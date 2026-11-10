/**
 * Deterministic, no-LLM explanation of a SQL statement, clause by clause.
 *
 * Why deterministic instead of asking a model: the same explanation has to appear in **both**
 * flavours of this package. The DSH plugin has a model available; the Agent Skill CLI does not —
 * the caller's agent is the model. A model-generated explanation would therefore exist in one
 * flavour and be missing in the other, which is exactly the drift the shared-core design exists to
 * prevent. This module needs no network, costs no tokens, never hallucinates, and is unit-testable.
 *
 * It explains *structure* (what each clause does), which is what a database course actually teaches.
 * Semantic intent ("why the student's question maps to this query") is the calling agent's job — see
 * the teaching contract in `skill/SKILL.md`.
 *
 * @module dsh-mysql-nl/core/explain
 */

import { maskLiterals } from './sql.js';

/**
 * Top-level clause keywords, tried in order at each candidate position.
 *
 * `ON` is deliberately absent: a JOIN condition belongs to its JOIN clause, not to a clause of its
 * own. Every pattern is sticky (`y`) and anchored at the scan position, so a match is a real
 * keyword at that exact offset, never a substring found somewhere ahead.
 */
const KEYWORD_PATTERNS = [
  { key: 'with', label: 'WITH', note: '公共表表达式（CTE）：先定义一个临时结果集，后面的 SELECT 可以当普通表用它。' },
  { key: 'select', label: 'SELECT', note: '决定结果集里出现哪些列，以及每列怎么算出来。' },
  { key: 'from', label: 'FROM', note: '指定数据的主来源表。' },
  { key: 'join', label: 'JOIN', note: '把另一张表按 ON 条件拼接进来。' },
  { key: 'where', label: 'WHERE', note: '在**分组之前**逐行过滤，不满足条件的行直接被丢掉。' },
  { key: 'group', label: 'GROUP BY', note: '把行按指定列分组，每组最终压成一行。' },
  { key: 'having', label: 'HAVING', note: '在**分组之后**过滤整组，配合聚合函数使用。' },
  { key: 'order', label: 'ORDER BY', note: '对最终结果排序；DESC 降序，ASC（默认）升序。' },
  { key: 'limit', label: 'LIMIT', note: '只取前 N 行，防止一次拉回过多数据。' },
  { key: 'union', label: 'UNION', note: '把两个查询的结果上下拼接（UNION ALL 保留重复行）。' },
];

const KEYWORD_PATTERN = KEYWORD_PATTERNS.map((entry) => ({
  ...entry,
  re: new RegExp(
    {
      with: 'with\\b',
      select: 'select\\b',
      from: 'from\\b',
      join: '(?:inner\\s+|left\\s+(?:outer\\s+)?|right\\s+(?:outer\\s+)?|full\\s+(?:outer\\s+)?|cross\\s+|straight_)?join\\b',
      where: 'where\\b',
      group: 'group\\s+by\\b',
      having: 'having\\b',
      order: 'order\\s+by\\b',
      limit: 'limit\\b',
      union: 'union\\b',
    }[entry.key],
    'iy',
  ),
}));

/** Aggregate functions that collapse many rows into one. */
const AGGREGATE_FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'GROUP_CONCAT', 'STDDEV', 'VARIANCE'];

/**
 * Find every top-level clause keyword in `masked`, ignoring anything nested inside parentheses.
 *
 * Depth tracking is what makes subqueries safe: the `FROM` of `SELECT (SELECT COUNT(*) FROM x) …`
 * sits at depth 1 and is correctly not treated as the outer query's FROM clause. `maskLiterals`
 * preserves character offsets, so the positions found here index back into the original SQL — which
 * is how the human-readable clause text keeps its real string literals and backticks.
 *
 * @param {string} masked
 * @returns {Array<{key: string, label: string, note: string, start: number, end: number}>}
 */
function findClauses(masked) {
  const found = [];
  let depth = 0;
  let index = 0;
  while (index < masked.length) {
    const char = masked[index];
    if (char === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    // Only word starts while at depth 0 can begin a top-level clause.
    const previous = index === 0 ? ' ' : masked[index - 1];
    if (depth === 0 && /[A-Za-z_]/.test(char) && !/[A-Za-z0-9_$]/.test(previous)) {
      let matched = false;
      for (const candidate of KEYWORD_PATTERN) {
        candidate.re.lastIndex = index;
        const match = candidate.re.exec(masked);
        if (match !== null && match.index === index) {
          found.push({
            key: candidate.key,
            label: candidate.label,
            note: candidate.note,
            start: index,
            end: index + match[0].length,
          });
          // Skip past the whole keyword; the `continue` is what stops the trailing `index += 1`
          // from advancing a second time (and potentially stepping over a parenthesis).
          index += match[0].length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    index += 1;
  }
  return found;
}

/**
 * Split an alias off a table reference: `country k` -> `{ table: 'country', alias: 'k' }`.
 * @param {string} reference
 * @returns {{table: string, alias?: string}}
 */
function splitTableReference(reference) {
  const cleaned = reference.replace(/\s+/g, ' ').trim().replace(/[,\s]+$/, '');
  const parts = cleaned.split(' ');
  const table = (parts[0] ?? '').replace(/`/g, '');
  if (parts.length >= 2) {
    const alias = parts[1].replace(/`/g, '');
    if (/^[A-Za-z0-9_$]+$/.test(alias) && !/^(on|using|as)$/i.test(alias)) return { table, alias };
    if (/^as$/i.test(parts[1]) && parts[2] !== undefined) return { table, alias: parts[2].replace(/`/g, '') };
  }
  return { table };
}

/**
 * Explain one SQL statement structurally. Never throws on malformed input — it degrades to whatever
 * clauses it could recognise, because a half-explained statement still teaches more than an error.
 *
 * @param {string} sql
 * @returns {{
 *   kind: string,
 *   clauses: Array<{key: string, label: string, text: string, note: string}>,
 *   joins: Array<{table: string, alias?: string, on?: string}>,
 *   aggregates: string[],
 *   distinct: boolean,
 *   hasSubquery: boolean,
 *   hints: string[],
 * }}
 */
export function explainSql(sql) {
  const text = typeof sql === 'string' ? sql : '';
  const masked = maskLiterals(text);
  const clauses = findClauses(masked);

  /** @type {Array<{key: string, label: string, text: string, note: string}>} */
  const explained = clauses.map((clause, position) => {
    const next = clauses[position + 1];
    const body = text.slice(clause.end, next === undefined ? text.length : next.start).trim().replace(/[;,]\s*$/, '');
    return { key: clause.key, label: clause.label, text: body, note: clause.note };
  });

  /** @type {Array<{table: string, alias?: string, on?: string}>} */
  const joins = [];
  for (const clause of explained) {
    if (clause.key !== 'join') continue;
    // `ON` may be followed by a nested subquery; split once, on the first top-level ON.
    const onMatch = /\bon\b/i.exec(clause.text);
    if (onMatch === null) {
      joins.push(splitTableReference(clause.text));
      continue;
    }
    const reference = splitTableReference(clause.text.slice(0, onMatch.index));
    joins.push({ ...reference, on: clause.text.slice(onMatch.index + onMatch[0].length).trim() });
  }

  const aggregates = AGGREGATE_FUNCTIONS.filter((fn) => new RegExp(`\\b${fn}\\s*\\(`, 'i').test(masked));
  const distinct = /\bselect\s+distinct\b/i.test(masked);
  const hasSubquery = /\(\s*select\b/i.test(masked);

  /** @type {string[]} */
  const hints = [];
  const selectClause = explained.find((clause) => clause.key === 'select');
  const whereClause = explained.find((clause) => clause.key === 'where');
  const limitClause = explained.find((clause) => clause.key === 'limit');
  const orderClause = explained.find((clause) => clause.key === 'order');

  if (selectClause !== undefined && /(^|[\s,])?\*(\s|,|$)/.test(selectClause.text)) {
    hints.push('`SELECT *` 会取出表里的**所有列**。写清列名能让结果更聚焦，也能避免表结构变化时查询行为悄悄改变。');
  }
  if (joins.some((join) => join.on === undefined)) {
    hints.push(
      '有 JOIN **缺少 ON 条件**。这在语法上合法，但结果是两张表的笛卡尔积（行数 = 两表行数之积），几乎总是错的。',
    );
  }
  if (whereClause !== undefined) {
    const offending = AGGREGATE_FUNCTIONS.find((fn) => new RegExp(`\\b${fn}\\s*\\(`, 'i').test(whereClause.text));
    if (offending !== undefined) {
      hints.push(
        `WHERE 里出现了聚合函数 \`${offending}()\`。**WHERE 在分组前执行，此时还没有聚合结果**，` +
          '要过滤聚合值必须改用 HAVING（并在 GROUP BY 之后）。',
      );
    }
  }
  if (limitClause === undefined && orderClause !== undefined) {
    hints.push('有 ORDER BY 但没有 LIMIT：排序本身不会减少行数，结果集可能很大。');
  }
  if (hasSubquery) {
    hints.push('语句里包含**子查询**：括号内的查询先算出结果，再交给外层使用。');
  }
  if (distinct) {
    hints.push('使用了 `DISTINCT`：结果会去重，只保留不重复的行。');
  }

  return {
    kind: clauseKind(explained),
    clauses: explained,
    joins,
    aggregates,
    distinct,
    hasSubquery,
    hints,
  };
}

/**
 * Best-effort statement kind from the clause keywords themselves.
 * @param {Array<{key: string}>} clauses
 * @returns {string}
 */
function clauseKind(clauses) {
  if (clauses.some((clause) => clause.key === 'with')) return 'with';
  if (clauses.some((clause) => clause.key === 'select')) return 'select';
  return 'other';
}
