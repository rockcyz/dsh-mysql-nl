#!/usr/bin/env node
/**
 * `mysql-nl` — a standalone CLI over the plugin's host-independent core.
 *
 * This file deliberately imports **only** `lib/core/*`: no Cordis, no DSH, no `ctx`. That is what
 * lets the same core ship as a DSH plugin *and* as an Agent Skill that any shell-capable agent
 * (OpenCode, Claude Code, Cursor, Codex…) can drive.
 *
 * The division of labour is the whole point of the skill flavour:
 *
 *   - `schema` gives the caller **real** table structure (the part an LLM cannot guess).
 *   - `query` executes a caller-supplied statement behind the read-only guard, the row limit, the
 *     statement timeout and the truncation logic in `lib/core/sql.js` + `lib/core/client.js`.
 *   - Selecting tables and **writing the SQL is the caller's job** — the caller is already an LLM.
 *
 * Exit codes are part of the interface, because an agent reads them:
 *   0  success
 *   1  runtime/config/SQL error
 *   2  the statement was refused by the read-only policy (not a bug, a policy answer)
 *   64 usage error
 *
 * @module mysql-nl/bin
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { CONNECTION_FILE_NAMES, loadConnections, resolveConnection, stripByteOrderMark } from '../lib/core/config.js';
import { describeTarget, disposeAll, ping, runQuery } from '../lib/core/client.js';
import { listDatabases, loadCatalog, loadTableDetails, renderSchema } from '../lib/core/catalog.js';
import { analyze, guard, referencedTables, withRowLimit } from '../lib/core/sql.js';
import { explainSql } from '../lib/core/explain.js';
import {
  renderConnection,
  renderExplanation,
  renderQuerySteps,
  renderResultTable,
  summarizeResult,
} from '../lib/core/format.js';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_REFUSED = 2;
const EXIT_USAGE = 64;

/** Long options that always consume the following argument. Everything else is a boolean. */
const VALUE_FLAGS = new Set([
  'db',
  'database',
  'tables',
  'connection',
  'file',
  'cwd',
  'sql',
  'max-rows',
  'max-chars',
  'semantic',
]);

/** Single-letter aliases. */
const SHORT_FLAGS = new Map([
  ['c', 'connection'],
  ['d', 'db'],
  ['f', 'file'],
  ['h', 'help'],
  ['s', 'sql'],
]);

const USAGE = `mysql-nl — 读取真实表结构 / 执行只读 SQL（DSH 插件内核的命令行壳）

用法:
  mysql-nl list                        列出连接文件里的所有连接（不显示密码）
  mysql-nl dbs                         列出服务器上的数据库
  mysql-nl ping                        连通性探测，返回服务器版本
  mysql-nl schema [--db <库>] [--tables a,b] [--brief] [--max-chars N]
                                       输出紧凑的表结构文本（喂给模型或人看）
  mysql-nl query --sql "<SQL>" [--db <库>] [--max-rows N] [--json]
                                       只读校验后执行，输出 markdown 表格（或 JSON）
  mysql-nl verify --semantic <文件> [--db <库>]
                                       校验领域语义层与真实库是否一致（表/列/类型/
                                       禁用表/示例可执行），防止 skill 随库漂移腐烂

通用选项:
  -c, --connection <id>   选择连接 id（默认用连接文件里的 default）
  -f, --file <路径>       显式指定连接文件
      --cwd <目录>        从该目录开始向上搜索连接文件（默认当前目录）
  -h, --help              显示本帮助

schema 选项:
      --tables a,b,c      只看这些表（默认整库）
      --brief             只列表和行数估计，不读字段（大库更快）
      --max-chars N       结构文本字符上限（默认 60000）

query 选项:
  -s, --sql <SQL>         要执行的语句；传 "-" 从标准输入读取
      --max-rows N        返回行数上限（默认取连接的 maxRows，再默认 200）
      --json              输出机器可读的 JSON（含 steps 与 explanation 结构化字段）
      --quiet             只输出 SQL 和结果表格，不显示执行步骤与语句讲解

输出默认包含教学四段：**执行步骤 → SQL 语句 → 语句讲解 → 查询结果**。
语句讲解是逐子句的结构说明（不依赖大模型，永远在场）。

verify 选项:
      --semantic <路径>   领域语义层文件（semantic.json）
      --db <库>           覆盖语义文件里的 database

连接文件候选名（在 --cwd 起逐级向上查找，再查用户主目录）:
  ${CONNECTION_FILE_NAMES.join('\n  ')}

退出码: 0 成功 / 1 错误 / 2 被只读策略拒绝 / 64 用法错误

只读策略: 由连接配置的 "readOnly" 决定（默认 true，即只允许
SELECT/WITH/SHOW/DESCRIBE/EXPLAIN）。CLI 不提供绕过开关；要写操作请在连接配置里显式写
"readOnly": false。`;

/**
 * Parse `argv` into flags and positionals.
 *
 * Flags in {@link VALUE_FLAGS} consume the next argument **unconditionally**, so a SQL string that
 * itself starts with `--` (a leading SQL comment, say) is not mistaken for an option.
 *
 * @param {string[]} argv
 * @returns {{flags: Record<string, string|boolean>, positional: string[]}}
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }

    const body = token.startsWith('--') ? token.slice(2) : (SHORT_FLAGS.get(token.slice(1)) ?? token.slice(1));
    const equals = body.indexOf('=');
    if (equals !== -1) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    if (VALUE_FLAGS.has(body)) {
      const next = argv[index + 1];
      if (next === undefined) throw new UsageError(`选项 --${body} 需要一个值`);
      flags[body] = next;
      index += 1;
      continue;
    }
    flags[body] = true;
  }

  return { flags, positional };
}

class UsageError extends Error {}

/** Read all of stdin as UTF-8 text. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** @param {unknown} value @returns {number|undefined} */
function positiveInt(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`需要一个正整数，收到 "${value}"`);
  return Math.floor(parsed);
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Load the connection file and pick one connection.
 * @param {Record<string, string|boolean>} flags
 */
async function openTarget(flags) {
  const cwd = typeof flags.cwd === 'string' ? flags.cwd : process.cwd();
  const explicit = typeof flags.file === 'string' ? flags.file : undefined;
  const config = await loadConnections({ cwd, explicit });
  const id = typeof flags.connection === 'string' ? flags.connection : undefined;
  const conn = resolveConnection(config, id);
  return { conn, config };
}

/**
 * Resolve the database for a command, preferring `--db` over the connection's default.
 * @param {import('../lib/core/types.js').ConnectionOptions} conn
 * @param {Record<string, string|boolean>} flags
 * @returns {string}
 */
function databaseOf(conn, flags) {
  const explicit = typeof flags.db === 'string' ? flags.db : typeof flags.database === 'string' ? flags.database : '';
  const database = explicit !== '' ? explicit : conn.database;
  if (database === undefined || database === '') {
    throw new UsageError(`连接 ${conn.id} 未指定默认数据库，请用 --db <库名> 指定`);
  }
  return database;
}

/**
 * Best human label for "which database did this query read".
 *
 * Prefer the schemas the statement actually names. Only fall back to the connection's default
 * database when every table reference is unqualified — that is the one case where the default
 * genuinely determines what was read.
 *
 * @param {string} defaultDatabase
 * @param {Array<{schema: string|null, table: string}>} refs
 * @returns {string}
 */
function databaseLabelOf(defaultDatabase, refs) {
  const schemas = [...new Set(refs.map((ref) => ref.schema).filter((schema) => schema !== null && schema !== ''))];
  if (schemas.length === 0) return defaultDatabase;
  return schemas.join(' / ');
}

// ---------------------------------------------------------------------------- commands

/** @param {Record<string, string|boolean>} flags */
async function commandList(flags) {
  const { config } = await openTarget(flags);
  const lines = [`连接文件: ${config.path}`];
  for (const conn of config.connections) {
    lines.push(renderConnection(conn, { isDefault: conn.id === config.defaultId }));
  }
  return { text: lines.join('\n'), code: EXIT_OK };
}

/** @param {Record<string, string|boolean>} flags */
async function commandDbs(flags) {
  const { conn } = await openTarget(flags);
  const databases = await listDatabases(conn);
  return { text: databases.join('\n'), code: EXIT_OK };
}

/** @param {Record<string, string|boolean>} flags */
async function commandPing(flags) {
  const { conn } = await openTarget(flags);
  const info = await ping(conn);
  const target = describeTarget(conn);
  return {
    text: `${target.host}:${target.port} 连接正常\n服务器版本: ${info.version}\n当前用户: ${info.user}`,
    code: EXIT_OK,
  };
}

/** @param {Record<string, string|boolean>} flags */
async function commandSchema(flags) {
  const { conn } = await openTarget(flags);
  const database = databaseOf(conn, flags);
  const wanted =
    typeof flags.tables === 'string'
      ? flags.tables
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '')
      : undefined;
  const maxChars = positiveInt(flags['max-chars']) ?? 60000;

  // `--brief` skips the column pass: cheap enough to run against a 500-table database.
  const catalog = flags.brief === true ? await loadCatalog(conn, database) : await loadTableDetails(conn, database, wanted);
  const schema = renderSchema(catalog, { maxChars });
  const header =
    `# 数据库 ${database}（连接 ${conn.id}，${catalog.tables.length} 张表` +
    `${catalog.detailed ? '，含字段/索引/外键' : '，仅表名列表'}）`;
  return { text: `${header}\n\n${schema}`, code: EXIT_OK };
}

/** Placeholder `QueryResult` for the failure path, where no result exists but the step renderer
 *  still wants the shape. Its numbers are never printed: `failure` short-circuits the last step. */
const FAILED_RESULT = { database: '', sql: '', columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0 };

/** @param {Record<string, string|boolean>} flags */
async function commandQuery(flags) {
  const { conn } = await openTarget(flags);
  const database = databaseOf(conn, flags);

  let sql = typeof flags.sql === 'string' ? flags.sql : '';
  if (sql === '-') sql = await readStdin();
  if (sql.trim() === '') throw new UsageError('缺少 --sql "<SQL>"（或 --sql - 从标准输入读取）');

  const readOnly = conn.readOnly !== false;
  const verdict = guard(sql, { readOnly });
  if (!verdict.ok) {
    // A refusal is a policy answer, not a crash: exit 2 so a caller can branch on it.
    process.stderr.write(
      `已拒绝执行：${verdict.reason ?? '未知原因'}\n` +
        (readOnly ? `当前连接 ${conn.id} 为只读模式（readOnly）\n` : '') +
        `语句：${sql.trim()}\n`,
    );
    return { text: '', code: EXIT_REFUSED };
  }

  const maxRows = positiveInt(flags['max-rows']) ?? conn.maxRows ?? 200;
  const finalSql = withRowLimit(sql, maxRows);
  const limitAdded = finalSql !== sql;
  // Display the statement we asked the server to run, before `runQuery` prepends its
  // MAX_EXECUTION_TIME hint: a student should read the query they wrote, not our safety wrapper.
  const displaySql = finalSql;
  const analysis = analyze(displaySql);
  const explanation = explainSql(displaySql);
  const timeoutMs = conn.maxQueryMs ?? 15000;
  // Keep the schema qualifier so the step trace can tell `jwgl.student` from `student`. The latter
  // resolves against the connection's default database, and conflating the two is exactly the
  // misconception this display must not create.
  const tableRefs = referencedTables(displaySql);
  const summaryDatabase = databaseLabelOf(database, tableRefs);

  const baseSteps = {
    connection: conn,
    database,
    readOnly,
    statementKind: analysis.statementKind,
    tables: tableRefs,
    limitApplied: maxRows,
    limitAdded,
    timeoutMs,
  };

  let result;
  try {
    result = await runQuery(conn, database, finalSql, { rowLimit: maxRows });
  } catch (error) {
    // A rejected statement is the most teachable moment there is: still show the SQL and the
    // clause-by-clause explanation, and put the server's own error message next to them.
    const failure = messageOf(error);
    const parts = [];
    if (flags.quiet !== true) parts.push(renderQuerySteps({ ...baseSteps, result: FAILED_RESULT, failure }));
    parts.push('### SQL 语句', '', '```sql', displaySql, '```', '');
    if (flags.quiet !== true) parts.push(renderExplanation(explanation));
    parts.push('### 执行失败', '', '```', failure, '```', '', '数据库拒绝了这条语句。按上面的提示核对字段名、表名和子句用法后修改重试。');
    if (flags.json === true) {
      return {
        text: JSON.stringify(
          { connection: conn.id, database, sql: displaySql, executed: false, error: failure, explanation },
          null,
          2,
        ),
        code: EXIT_ERROR,
      };
    }
    return { text: parts.join('\n'), code: EXIT_ERROR };
  }

  const summary = summarizeResult({ ...result, database: summaryDatabase });
  const steps = renderQuerySteps({ ...baseSteps, result });

  if (flags.json === true) {
    return {
      text: JSON.stringify(
        {
          connection: conn.id,
          // `defaultDatabase` is `DATABASE()` on the connection, not necessarily what the query
          // read; `tableRefs` says which schemas the statement actually names.
          defaultDatabase: database,
          tableRefs,
          sql: displaySql,
          executedSql: result.sql,
          statementKind: analysis.statementKind,
          tablesUsed: analysis.touchesTables,
          limitApplied: maxRows,
          limitAdded,
          steps,
          explanation,
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
          truncated: result.truncated,
          elapsedMs: result.elapsedMs,
          warning: result.warning,
        },
        null,
        2,
      ),
      code: EXIT_OK,
    };
  }

  // The teaching sections are the whole point of this CLI for a course; `--quiet` drops both the
  // step trace and the explanation, leaving just the SQL and the data.
  const parts = [];
  if (flags.quiet !== true) parts.push(steps);
  parts.push('### SQL 语句', '', '```sql', displaySql, '```', '');
  if (flags.quiet !== true) parts.push(renderExplanation(explanation));

  parts.push(`### 查询结果（${summary}）`, '', renderResultTable(result, { maxRows: Math.min(maxRows, 50) }));
  if (result.truncated) {
    parts.push('', `> 结果已按上限 ${maxRows} 行截断。要更多数据请提高 \`--max-rows\`，或缩小查询范围。`);
  }
  return { text: parts.join('\n'), code: EXIT_OK };
}

/**
 * Validate a domain semantic file against the live database.
 *
 * The whole point of a semantic layer is that a human wrote facts the database cannot tell you
 * (business vocabulary, metric definitions, dirty tables). Those facts rot silently: a renamed
 * column leaves the skill confidently describing something that no longer exists, and the agent
 * writes SQL from a stale document. This command makes that rot a build failure.
 *
 * It checks what can be checked mechanically and *runs* every example, so identifier resolution is
 * verified by MySQL itself rather than by a hand-rolled SQL parser.
 *
 * @param {Record<string, string|boolean>} flags
 */
async function commandVerify(flags) {
  if (typeof flags.semantic !== 'string') throw new UsageError('缺少 --semantic <semantic.json 路径>');
  const base = typeof flags.cwd === 'string' ? flags.cwd : process.cwd();
  const file = path.resolve(base, flags.semantic);

  let spec;
  try {
    // Windows editors add a UTF-8 BOM by default; strip it before parsing (same helper the
    // connection store uses, so both readers agree).
    spec = JSON.parse(stripByteOrderMark(await readFile(file, 'utf8')));
  } catch (error) {
    throw new Error(`读不到或解析不了语义文件 ${file}：${messageOf(error)}`);
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`语义文件 ${file} 的根节点必须是对象`);
  }

  const { conn } = await openTarget(flags);
  const database = typeof flags.db === 'string' ? flags.db : spec.database;
  if (typeof database !== 'string' || database === '') {
    throw new Error('语义文件缺少 database，且没有传 --db');
  }

  const out = [];
  let errors = 0;
  let warnings = 0;
  const pass = (message) => out.push(`  ✓ ${message}`);
  const fail = (message) => {
    errors += 1;
    out.push(`  ✗ ${message}`);
  };
  const warn = (message) => {
    warnings += 1;
    out.push(`  ! ${message}`);
  };

  out.push(`领域：${spec.title ?? spec.domain ?? '（未命名）'}`, `库：${database} · 连接：${conn.id}`, '');

  const databases = await listDatabases(conn);
  if (!databases.includes(database)) {
    fail(`库 ${database} 不存在（服务器上有：${databases.join('、')}）`);
    out.push('', `结果：失败 1 项`);
    return { text: out.join('\n'), code: EXIT_ERROR };
  }

  const catalog = await loadTableDetails(conn, database);
  const tableMap = new Map(catalog.tables.map((table) => [table.name, table]));
  out.push(`已读取真实结构：${catalog.tables.length} 张表`, '');

  const checkTableColumn = (ref, context) => {
    const match = /^([A-Za-z0-9_$]+)\.([A-Za-z0-9_$]+)$/.exec(String(ref ?? '').trim());
    if (match === null) {
      fail(`${context}：引用 "${ref}" 不是 table.column 形式`);
      return false;
    }
    const [, tableName, columnName] = match;
    const table = tableMap.get(tableName);
    if (table === undefined) {
      fail(`${context}：表 ${tableName} 不存在`);
      return false;
    }
    const column = table.columns.find((entry) => entry.name === columnName);
    if (column === undefined) {
      fail(`${context}：列 ${ref} 不存在（${tableName} 现有：${table.columns.map((c) => c.name).join(', ')}）`);
      return false;
    }
    return true;
  };

  // ---- 表与列
  out.push('【表与列】');
  for (const [tableName, declared] of Object.entries(spec.tables ?? {})) {
    const table = tableMap.get(tableName);
    if (table === undefined) {
      fail(`表 ${tableName} 不存在（现有：${[...tableMap.keys()].join(', ')}）`);
      continue;
    }
    pass(`表 ${tableName}（${table.rowEstimate ?? '?'} 行）`);
    for (const [columnName, columnSpec] of Object.entries(declared?.columns ?? {})) {
      const column = table.columns.find((entry) => entry.name === columnName);
      if (column === undefined) {
        fail(`列 ${tableName}.${columnName} 不存在（现有：${table.columns.map((c) => c.name).join(', ')}）`);
        continue;
      }
      const declaredType = String(columnSpec?.type ?? '').trim().toLowerCase();
      const actualType = String(column.type ?? '').trim().toLowerCase();
      if (declaredType !== '' && declaredType !== actualType) {
        fail(`列 ${tableName}.${columnName} 类型不符：语义层写 ${declaredType}，实际 ${actualType}`);
        continue;
      }
      pass(`列 ${tableName}.${columnName} ${actualType}`);
    }
  }

  // ---- 禁用表
  const forbidden = (spec.forbidden ?? []).map((entry) => String(entry?.table ?? '')).filter((name) => name !== '');
  if (forbidden.length > 0) {
    out.push('', '【禁用表】');
    for (const entry of spec.forbidden ?? []) {
      const tableName = String(entry?.table ?? '');
      if (tableName === '') continue;
      if (tableMap.has(tableName)) pass(`${tableName} 存在（语义层声明禁止使用：${entry.reason ?? '未写原因'}）`);
      else warn(`${tableName} 已不在库中，禁用声明可以删掉`);
    }
  }

  // ---- 指标引用
  out.push('', '【指标引用】');
  for (const metric of spec.metrics ?? []) {
    const name = String(metric?.name ?? '（未命名指标）');
    let ok = true;
    for (const ref of metric?.uses ?? []) {
      if (!checkTableColumn(ref, `指标「${name}」`)) ok = false;
    }
    if (ok) pass(`指标「${name}」`);
  }

  // ---- 关联路径
  const joinEntries = spec.joins ?? [];
  if (joinEntries.length > 0) {
    out.push('', '【关联路径】');
    for (const join of joinEntries) {
      const name = String(join?.name ?? '（未命名关联）');
      if (typeof join?.verifySql === 'string') {
        try {
          await runQuery(conn, database, withRowLimit(join.verifySql, 1), { rowLimit: 1 });
          pass(`关联「${name}」可执行`);
        } catch (error) {
          fail(`关联「${name}」执行失败：${messageOf(error)}`);
        }
        continue;
      }
      pass(`关联「${name}」（未提供 verifySql，未做结构校验）`);
    }
  }

  // ---- 二义性（消歧规则）
  // An ambiguity declaration is a claim about the data ("this name matches more than one row").
  // When the data changes, the claim can silently become false and the agent then asks the user a
  // pointless question, or stops asking one it should. Checking it here keeps the interaction
  // protocol honest.
  const ambiguityEntries = spec.ambiguity ?? [];
  if (ambiguityEntries.length > 0) {
    out.push('', '【二义性规则】');
    for (const entry of ambiguityEntries) {
      const field = String(entry?.field ?? '');
      const label = `二义性「${field === '' ? '（未写 field）' : field}」`;
      // `presentColumns` are naturally bare column names of the table named by `field`, so resolve
      // them against that table instead of forcing the author to repeat the prefix everywhere.
      const fieldTable = field.includes('.') ? field.split('.')[0] : null;
      const asRef = (ref) => {
        if (typeof ref !== 'string' || ref === '') return null;
        if (ref.includes('.')) return ref;
        return fieldTable === null ? null : `${fieldTable}.${ref}`;
      };
      let ok = true;
      const refs = [...new Set([entry?.identity, entry?.confirmedKey, ...(entry?.presentColumns ?? [])].map(asRef).filter((r) => r !== null))];
      for (const ref of refs) {
        if (!checkTableColumn(ref, label)) ok = false;
      }
      if (!ok) continue;
      if (typeof entry?.lookupSql !== 'string' || entry.lookupSql.trim() === '') {
        fail(`${label}：缺少 lookupSql，无法回归`);
        continue;
      }
      try {
        const probe = await runQuery(conn, database, withRowLimit(entry.lookupSql, 10), { rowLimit: 10 });
        if (entry.expectAmbiguous === true) {
          if (probe.rowCount > 1) pass(`${label}：候选查询命中 ${probe.rowCount} 行，二义性成立（需先让用户确认）`);
          else warn(`${label}：声明"应有多行"，实际命中 ${probe.rowCount} 行 —— 数据已变，这条规则可能过期`);
        } else {
          pass(`${label}：候选查询可执行（命中 ${probe.rowCount} 行）`);
        }
      } catch (error) {
        fail(`${label}：lookupSql 执行失败：${messageOf(error)}`);
      }
    }
  }

  // ---- 禁用表不得被引用
  const referenceSources = [
    ...(spec.metrics ?? []).flatMap((metric) => (metric?.uses ?? []).map((ref) => ({ where: `指标「${metric.name}」`, text: String(ref) }))),
    ...(spec.joins ?? []).flatMap((join) => [
      { where: `关联「${join.name}」`, text: String(join?.on ?? '') },
      { where: `关联「${join.name}」校验语句`, text: String(join?.verifySql ?? '') },
    ]),
    ...(spec.examples ?? []).map((example) => ({ where: `示例「${example.question ?? ''}」`, text: String(example?.sql ?? '') })),
  ];
  const violations = [];
  for (const source of referenceSources) {
    for (const tableName of forbidden) {
      if (new RegExp(`(^|[^A-Za-z0-9_$])${tableName}([^A-Za-z0-9_$]|$)`, 'i').test(source.text)) {
        violations.push(`${source.where} 引用了禁用表 ${tableName}`);
      }
    }
  }
  if (forbidden.length > 0) {
    out.push('', '【禁用表未被引用】');
    if (violations.length === 0) pass(`语义层内部没有引用禁用表`);
    for (const violation of violations) fail(violation);
  }

  // ---- 示例可执行
  out.push('', '【示例可执行】');
  const examples = spec.examples ?? [];
  let executed = 0;
  for (const [index, example] of examples.entries()) {
    const question = String(example?.question ?? `示例 ${index + 1}`);
    if (typeof example?.sql !== 'string' || example.sql.trim() === '') {
      fail(`示例「${question}」缺少 sql`);
      continue;
    }
    try {
      // LIMIT 1 keeps the probe cheap on any table size; the read-only guard inside runQuery still
      // applies, so a semantic file cannot smuggle a write into verification.
      const result = await runQuery(conn, database, withRowLimit(example.sql, 1), { rowLimit: 1 });
      executed += 1;
      const first = result.rows[0] === undefined ? '（无数据行）' : result.rows[0].map((value) => String(value)).join(' / ');
      pass(`示例「${question}」→ ${first}${example.expect === undefined ? '' : `（期望：${example.expect}）`}`);
    } catch (error) {
      fail(`示例「${question}」执行失败：${messageOf(error)}`);
    }
  }

  out.push('');
  const summary = `结果：${examples.length === 0 ? '' : `${executed}/${examples.length} 个示例可执行，`}失败 ${errors} 项，警告 ${warnings} 项`;
  out.push(summary);
  return { text: out.join('\n'), code: errors > 0 ? EXIT_ERROR : EXIT_OK };
}

const COMMANDS = {
  list: commandList,
  dbs: commandDbs,
  ping: commandPing,
  schema: commandSchema,
  query: commandQuery,
  verify: commandVerify,
};

// ---------------------------------------------------------------------------- entry

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const name = positional[0] ?? (flags.help === true ? 'help' : undefined);

  if (flags.help === true || name === 'help' || name === undefined) {
    process.stdout.write(`${USAGE}\n`);
    // Bare invocation is a usage error; an explicit --help/help is not.
    return name === undefined ? EXIT_USAGE : EXIT_OK;
  }

  const command = COMMANDS[name];
  if (command === undefined) throw new UsageError(`未知子命令 "${name}"（可用：${Object.keys(COMMANDS).join(', ')}）`);

  const { text, code } = await command(flags);
  if (text !== '') process.stdout.write(`${text}\n`);
  return code;
}

let exitCode = EXIT_OK;
try {
  exitCode = await main();
} catch (error) {
  if (error instanceof UsageError) {
    // Print the one-line diagnosis and point at --help rather than dumping the whole usage block:
    // this output lands in an agent's context, and the full text is a `--help` away.
    process.stderr.write(`用法错误：${error.message}\n运行 --help 查看完整用法。\n`);
    exitCode = EXIT_USAGE;
  } else {
    process.stderr.write(`错误：${messageOf(error)}\n`);
    exitCode = EXIT_ERROR;
  }
} finally {
  // The pool keeps the event loop alive; close it before exiting on every path.
  await disposeAll().catch(() => {});
}

process.exit(exitCode);
