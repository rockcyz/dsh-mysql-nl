/**
 * Natural-language to SQL: two-stage schema grounding, table selection, generation, and repair.
 *
 * Stage 1 (only for databases too large to inline) asks the model which tables the question needs,
 * from a name-and-comment catalog. Stage 2 sends the full column detail of just those tables.
 * Smaller databases skip stage 1 entirely so the model always sees every column.
 *
 * This module talks to the outside world only through the injected `llm` function, which keeps it
 * unit-testable without a network or a provider.
 * @module dsh-mysql-nl/core/nl
 */

import { cleanSql, guard } from './sql.js';
import { renderSchema } from './catalog.js';

/** Characters of catalog text inlined verbatim before stage 1 kicks in. */
export const DEFAULT_INLINE_CHAR_BUDGET = 60000;
/** Tables stage 1 may select. */
export const DEFAULT_MAX_TABLES = 12;

const BASE_RULES = `你是资深的 MySQL 数据库分析师，任务是把用户的自然语言查询需求翻译成**准确、可直接执行**的 MySQL 8 语句。

硬性要求：
1. 只能使用下方给定的库表与字段，禁止臆造表名或字段名。字段名必须与给定结构完全一致。
2. 表名、字段名用反引号包裹，例如 \`film\`.\`title\`。
3. 只输出**一条** SELECT 语句。不要输出 INSERT/UPDATE/DELETE/DDL。
4. 不要输出任何解释文字、不要输出 markdown 代码块标记，直接输出 SQL 本身。
5. 不确定的语义要按最合理的数据库含义理解（例如"最近"按时间字段倒序、"排名"按数量倒序）。
6. 需要聚合时正确使用 GROUP BY / HAVING / ORDER BY；需要关联时使用显式 JOIN 与 ON 条件。
7. 谨慎处理 NULL：聚合用 COUNT(*) 或 COUNT(字段) 需按语义选择。
8. 除非用户明确要求全部数据，否则加上合理的 LIMIT（默认不超过 100）。
9. 若用户的问题在下述结构中无法回答，输出 SQL 注释 \`-- 无法回答: <原因>\` 而不是编造。`;

/**
 * Prompt rules for write-statement generation. Used when the caller declares that a non-SELECT
 * request is legitimate; the statement is still never executed by this tool — see WRITE_GUARD.
 */
const WRITE_RULES = `你是资深的 MySQL 数据库分析师，任务是把用户的自然语言需求翻译成**准确**的 MySQL 8 写操作语句。

硬性要求：
1. 只能使用下方给定的库表与字段，禁止臆造表名或字段名。字段名必须与给定结构完全一致。
2. 表名、字段名用反引号包裹，例如 \`film\`.\`title\`。
3. 只输出**一条**语句，类型必须是 INSERT / UPDATE / DELETE / REPLACE 之一；只有当用户明确要求建表、改表结构或删除表时才允许 CREATE TABLE / ALTER TABLE / DROP TABLE。**绝不**输出 GRANT、SET、SHUTDOWN、KILL、LOAD DATA、事务控制或其它管理语句。
4. 写操作必须精确圈定范围：UPDATE / DELETE 一律带 WHERE 条件；条件不明确时宁可输出 "-- 无法回答: <缺什么条件>" 也不要输出会误伤整表的语句。
5. 不要输出任何解释文字、不要输出 markdown 代码块标记，直接输出 SQL 本身。
6. 不确定的语义要按最合理的数据库含义理解；涉及自增主键、外键约束时按给定结构中的实际定义书写。
7. 若用户的问题在下述结构中无法回答，输出 SQL 注释 \`-- 无法回答: <原因>\` 而不是编造。`;

/** Appended to every write-mode prompt: the plugin hands the SQL to the user, it never runs it. */
const WRITE_GUARD = '\n\n注意：本工具**不会执行**你生成的写语句——它只会连同逐子句讲解一起展示给用户，由用户复制到 DBeaver / MySQL Workbench 等客户端自行执行。请把语句写得可以直接复制运行（单条、以分号结尾），并优先保证安全边界（WHERE 条件精确、必要时提示备份）。';

/**
 * Ask the model to return the tables a question needs.
 * @param {{catalog: import('./types.js').Catalog, question: string, llm: Function, provider: string, model: string, maxTables?: number, signal?: AbortSignal}} input
 * @returns {Promise<{tables: string[], reason: string, strategy: 'heuristic'|'llm'}>}
 */
export async function selectTables(input) {
  const { catalog, question, llm, provider, model, signal } = input;
  const maxTables = Number.isInteger(input.maxTables) && input.maxTables > 0 ? input.maxTables : DEFAULT_MAX_TABLES;
  const names = catalog.tables.map((table) => table.name);
  if (names.length === 0) return { tables: [], reason: '数据库中没有表', strategy: 'heuristic' };
  const index = catalog.tables
    .map((table) => {
      const rows = typeof table.rowEstimate === 'number' ? ` ≈${table.rowEstimate}行` : '';
      const comment = table.comment ? ` -- ${table.comment}` : '';
      return `- ${table.name}${rows}${comment}`;
    })
    .join('\n');
  const system = `你是数据库检索助手。用户会给出一个查询需求和一张表清单，请判断回答该需求需要读取哪些表。
只输出 JSON，格式为 {"tables":["表名1","表名2"],"reason":"一句话理由"}，不要输出其他内容。
最多选择 ${maxTables} 张表；如果无法判断，选择最可能相关的表。`;
  const prompt = `数据库：${catalog.database}\n\n可用表清单：\n${index}\n\n用户需求：${question}`;
  const raw = await llm({ provider, model, system, prompt, maxTokens: 600, signal });
  const picked = parseTableList(raw, names, maxTables);
  if (picked.length === 0) {
    return { tables: names.slice(0, Math.min(maxTables, names.length)), reason: '模型未给出有效表名，回退为清单前若干张表', strategy: 'llm' };
  }
  return { tables: picked, reason: extractReason(raw) ?? `模型选择 ${picked.length} 张表`, strategy: 'llm' };
}

/**
 * Tolerant table-list parser: accepts JSON, a fenced block, or a bare list of table names.
 * @param {string} raw
 * @param {string[]} known
 * @param {number} maxTables
 * @returns {string[]}
 */
function parseTableList(raw, known, maxTables) {
  if (typeof raw !== 'string') return [];
  const lowerKnown = new Map(known.map((name) => [name.toLowerCase(), name]));
  const found = [];
  const push = (candidate) => {
    if (typeof candidate !== 'string') return;
    const name = candidate.trim().replace(/^[`"']|[`"']$/g, '');
    const exact = lowerKnown.get(name.toLowerCase());
    if (exact !== undefined && !found.includes(exact) && found.length < maxTables) found.push(exact);
  };
  const jsonText = (() => {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    if (fenced !== null) return fenced[1] ?? '';
    const braces = /\{[\s\S]*\}/.exec(raw);
    return braces !== null ? braces[0] : raw;
  })();
  try {
    const parsed = JSON.parse(jsonText.trim());
    if (Array.isArray(parsed)) parsed.forEach(push);
    else if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.tables)) parsed.tables.forEach(push);
  } catch {
    for (const match of raw.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'|\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      push(match[1] ?? match[2] ?? match[3] ?? match[4]);
    }
  }
  return found;
}

/**
 * @param {string} raw
 * @returns {string|undefined}
 */
function extractReason(raw) {
  if (typeof raw !== 'string') return undefined;
  const match = /"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  return match?.[1]?.trim() || undefined;
}

/**
 * Generate one MySQL statement from a question, grounded in real schema.
 * @param {{
 *   conn: import('./types.js').ConnectionOptions,
 *   loader: {loadCatalog: Function, loadTableDetails: Function},
 *   database: string, question: string, hintTables?: string[],
 *   llm: Function, provider: string, model: string, signal?: AbortSignal,
 *   inlineCharBudget?: number, maxTables?: number,
 *   prior?: {sql: string, error: string},
 *   allowWrite?: boolean
 * }} input
 * @returns {Promise<{sql: string, tables: string[], rationale: string, stage: string, selection: {strategy: string, tables: string[]}}>}
 */
export async function generateSql(input) {
  const { conn, loader, database, question, llm, provider, model, signal } = input;
  const inlineCharBudget = Number.isInteger(input.inlineCharBudget) ? input.inlineCharBudget : DEFAULT_INLINE_CHAR_BUDGET;
  const maxTables = Number.isInteger(input.maxTables) && input.maxTables > 0 ? input.maxTables : DEFAULT_MAX_TABLES;

  const catalog = await loader.loadCatalog(conn, database);
  if (catalog.tables.length === 0) {
    throw new Error(`数据库 ${database} 中没有任何表`);
  }

  let stage = 'full-schema';
  let selection = { strategy: 'hint', tables: [] };
  let schema;
  const budget = inlineCharBudget > 0 ? inlineCharBudget : 12000;

  if (Array.isArray(input.hintTables) && input.hintTables.length > 0) {
    const known = new Set(catalog.tables.map((table) => table.name));
    const wanted = input.hintTables.filter((name) => known.has(name));
    if (wanted.length > 0) {
      const detail = await loader.loadTableDetails(conn, database, wanted);
      schema = renderSchema(detail, { maxChars: Math.max(budget, 4 * budget) });
      selection = { strategy: 'hint', tables: wanted };
      stage = 'hint-schema';
    }
  }

  if (schema === undefined) {
    const wideCatalog = { ...catalog, detailed: false };
    const catalogText = renderCatalogIndex(catalog);
    if (catalogText.length <= budget) {
      // Everything fits: send the full column detail of every table in one pass.
      const detail = await loader.loadTableDetails(conn, database);
      schema = renderSchema(detail, { maxChars: Math.max(budget * 4, 60000) });
      selection = { strategy: 'full', tables: catalog.tables.map((table) => table.name) };
      stage = 'full-schema';
    } else {
      const heuristic = pickRelevant(catalog, question, maxTables * 2);
      const chosen = await selectTables({
        catalog: wideCatalog,
        question,
        llm,
        provider,
        model,
        maxTables,
        signal,
      });
      const merged = dedupe([...chosen.tables, ...heuristic]).slice(0, Math.max(maxTables, 8));
      // Never hand an empty selection to the detail pass: it means "every table".
      const wanted = merged.length > 0 ? merged : catalog.tables.slice(0, maxTables).map((table) => table.name);
      const detail = await loader.loadTableDetails(conn, database, wanted);
      schema = renderSchema(detail, { maxChars: Math.max(budget * 4, 60000) });
      selection = { strategy: chosen.strategy, tables: wanted };
      stage = 'selected-schema';
    }
  }

  const priorBlock = input.prior === undefined
    ? ''
    : `\n\n\n上一次生成的 SQL 执行失败，请修正：\n失败的 SQL：\n${input.prior.sql}\n数据库返回的错误：${input.prior.error}\n请重新生成一条可以正确执行的 SQL。`;

  const userPrompt = [
    `数据库方言：MySQL 8.0`,
    `当前数据库：${database}`,
    '',
    schema,
    '',
    `用户需求：${question}`,
    priorBlock,
  ].join('\n');

  // Write mode swaps the whole rule set: BASE_RULES forbids non-SELECT output, so appending a
  // permission sentence to it would only produce a self-contradicting prompt.
  const writeMode = input.allowWrite === true;
  const raw = await llm({
    provider,
    model,
    system: writeMode ? WRITE_RULES + WRITE_GUARD : BASE_RULES,
    prompt: userPrompt,
    maxTokens: 2000,
    signal,
  });
  const sql = cleanSql(raw);
  if (sql === '') throw new Error('EMPTY_SQL');
  const verdict = classifyOnly(sql);
  if (verdict.kind === 'empty' || verdict.kind === 'unknown' || verdict.kind === 'multiple') {
    throw new Error(`模型返回的语句无法识别：${verdict.reason ?? sql.slice(0, 120)}`);
  }
  return {
    sql,
    tables: selection.tables,
    rationale: typeof raw === 'string' ? raw.slice(0, 400) : '',
    stage,
    selection,
  };
}

/**
 * @param {string} sql
 * @returns {{ok: boolean, kind: string, reason?: string}}
 */
function classifyOnly(sql) {
  // `guard` with readOnly false isolates classification from policy; the caller enforces policy.
  return guard(sql, { readOnly: false });
}

/**
 * Name-and-comment index used when full column detail does not fit in the prompt budget.
 * @param {import('./types.js').Catalog} catalog
 * @returns {string}
 */
export function renderCatalogIndex(catalog) {
  const lines = [`## 数据库 ${catalog.database}（共 ${catalog.tables.length} 张表）`];
  for (const table of catalog.tables) {
    const rows = typeof table.rowEstimate === 'number' ? ` ≈${table.rowEstimate}行` : '';
    const comment = table.comment ? ` -- ${table.comment}` : '';
    lines.push(`- ${table.name}${rows}${comment}`);
  }
  return lines.join('\n');
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function dedupe(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Local lexical pre-filter, used to widen the stage-1 candidate set. Mirrors the catalog scorer
 * without importing it, so a missing `pickRelevantTables` can never break generation.
 * @param {import('./types.js').Catalog} catalog
 * @param {string} question
 * @param {number} limit
 * @returns {string[]}
 */
function pickRelevant(catalog, question, limit) {
  const text = String(question ?? '').toLowerCase();
  const scored = catalog.tables.map((table) => {
    const name = table.name.toLowerCase();
    let score = 0;
    if (name.length >= 3 && text.includes(name)) score += 10;
    for (const part of name.split(/[_\s]+/)) {
      if (part.length >= 3 && text.includes(part)) score += 3;
    }
    if (table.comment && text.length > 0) {
      for (const token of table.comment.toLowerCase().split(/[\s,，、]+/)) {
        if (token.length >= 2 && text.includes(token)) score += 1;
      }
    }
    return { name: table.name, score };
  });
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, Math.max(1, limit)).filter((entry) => entry.score > 0).map((entry) => entry.name);
}
