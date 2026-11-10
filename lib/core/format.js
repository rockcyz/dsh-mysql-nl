/**
 * Compact, model-friendly rendering of query results and connection metadata.
 * Pure functions, no IO. Output is Chinese-labelled plain text / markdown.
 * @module dsh-mysql-nl/core/format
 */

/** Longest cell text kept in a rendered table. */
const CELL_LIMIT = 120;
/** Rows rendered before the first truncation notice. */
const HEAD_ROWS = 50;

/**
 * Make one cell safe for a markdown table row.
 * @param {unknown} value
 * @returns {string}
 */
function cell(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') {
    const flat = value.replace(/\r?\n/g, '\\n').replace(/\|/g, '\\|');
    return flat.length > CELL_LIMIT ? `${flat.slice(0, CELL_LIMIT)}…` : flat;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return String(value);
    return json.length > CELL_LIMIT ? `${json.slice(0, CELL_LIMIT)}…` : json;
  } catch {
    return String(value);
  }
}

/**
 * Render a query result as a compact markdown table.
 * @param {import('./types.js').QueryResult} result
 * @param {{maxRows?: number}} [options]
 * @returns {string}
 */
export function renderResultTable(result, options = {}) {
  const maxRows = Number.isInteger(options.maxRows) && options.maxRows > 0 ? options.maxRows : HEAD_ROWS;
  const columns = Array.isArray(result?.columns) ? result.columns.map((name) => String(name)) : [];
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  if (columns.length === 0) return '（该语句没有返回结果集）';
  if (rows.length === 0) return `（查询成功，但没有匹配的数据行。涉及表：${columns.join(', ')} 的字段列表如下）`;
  const shown = rows.slice(0, maxRows);
  const header = `| ${columns.map((name) => name.replace(/\|/g, '\\|')).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = shown.map((row) => `| ${columns.map((_, index) => cell(row[index])).join(' | ')} |`);
  const lines = [header, divider, ...body];
  if (rows.length > shown.length) {
    lines.push(`... 另有 ${rows.length - shown.length} 行未显示`);
  }
  return lines.join('\n');
}

/**
 * One-line human summary of a query result.
 * @param {import('./types.js').QueryResult} result
 * @returns {string}
 */
export function summarizeResult(result) {
  const table = result?.database ? `${result.database}` : '';
  const elapsed = typeof result?.elapsedMs === 'number' ? `${result.elapsedMs}ms` : '?';
  const truncated = result?.truncated ? '（已截断）' : '';
  return `${result?.rowCount ?? 0} 行 / ${elapsed}${table === '' ? '' : ` · ${table}`}${truncated}`;
}

/**
 * Render one connection without ever revealing its password.
 * @param {import('./types.js').ConnectionOptions} conn
 * @param {{isDefault?: boolean}} [options]
 * @returns {string}
 */
export function renderConnection(conn, options = {}) {
  const user = conn.user ?? '';
  const host = conn.host ?? '127.0.0.1';
  const port = conn.port ?? 3306;
  const password = conn.password ? '已配置' : '空';
  const ssl = conn.ssl ? 'ssl' : '无ssl';
  const mode = conn.readOnly === false ? '读写' : '只读';
  const parts = [
    `- **${conn.id}**${options.isDefault ? '（默认）' : ''}: ${user}@${host}:${port}`,
    `数据库 ${conn.database ?? '未指定'} · 密码 ${password} · ${ssl} · ${mode} · 最多 ${conn.maxRows ?? 200} 行 / ${conn.maxQueryMs ?? 15000}ms`,
  ];
  if (conn.label) parts[0] += ` — ${conn.label}`;
  return parts.join('\n  ');
}

/** Longest clause text quoted back in a teaching explanation. */
const CLAUSE_TEXT_LIMIT = 220;

/**
 * Collapse whitespace and cap length so one huge clause cannot flood the teaching output.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
function condense(text, limit = CLAUSE_TEXT_LIMIT) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Render the numbered "what actually happened" trace a student needs to see: which server was
 * contacted, whether the read-only policy was enforced, which tables were read and against which
 * schema, whether a LIMIT was added for them, and what came back.
 *
 * The connection target deliberately does **not** include `database`. That field is the
 * connection's *default* schema (`DATABASE()`), not the schema a query reads: `FROM jwgl.student`
 * on a connection parked on `world` is valid and must not be reported as "queried world". When the
 * table references carry no schema, the default schema becomes load-bearing (unqualified names
 * resolve against it), so it is disclosed there instead.
 *
 * @param {{
 *   connection: {id: string, host?: string, port?: number},
 *   database: string,
 *   readOnly: boolean,
 *   statementKind: string,
 *   tables: Array<string | {schema?: string | null, table: string}>,
 *   limitApplied?: number,
 *   limitAdded?: boolean,
 *   timeoutMs?: number,
 *   failure?: string,
 *   result: import('./types.js').QueryResult,
 * }} input
 * @returns {string}
 */
export function renderQuerySteps(input) {
  const target = `${input.connection.host ?? '127.0.0.1'}:${input.connection.port ?? 3306}`;
  const mode = input.readOnly ? '只读模式' : '读写模式';
  const lines = ['### 执行步骤', '', `1. **连接数据库** — \`${input.connection.id}\` → ${target}（${mode}）`];

  /** @type {Array<{schema: string|null, table: string}>} */
  const refs = (input.tables ?? []).map((entry) =>
    typeof entry === 'string' ? { schema: null, table: entry } : { schema: entry.schema ?? null, table: entry.table },
  );
  const label = (ref) => (ref.schema === null || ref.schema === '' ? ref.table : `${ref.schema}.${ref.table}`);
  const qualified = refs.filter((ref) => ref.schema !== null && ref.schema !== '');
  const unqualified = refs.filter((ref) => ref.schema === null || ref.schema === '');

  let tables;
  if (refs.length === 0) {
    tables = '（未能识别，交给数据库自行解析）';
  } else if (unqualified.length === 0) {
    tables = refs.map(label).join('、');
  } else {
    // Mixed: say which ones lean on the connection's default schema, because that is exactly the
    // thing that silently breaks when someone assumes the wrong database.
    tables =
      refs.map(label).join('、') +
      `（其中 ${unqualified.map((ref) => ref.table).join('、')} 未写库名，按连接默认库 \`${input.database}\` 解析）`;
  }
  if (qualified.length > 0 && unqualified.length === 0) {
    // Nothing resolves against the default schema; make that explicit so nobody reads the connection
    // config and concludes the query ran elsewhere.
    tables += `（全部带库名，不受连接默认库 \`${input.database}\` 影响）`;
  }

  lines.push(
    `2. **只读校验** — 识别为 \`${input.statementKind}\` 语句，通过检查（只允许 SELECT / WITH / SHOW / DESCRIBE / EXPLAIN）`,
    `3. **涉及的表** — ${tables}`,
  );

  let step = 4;
  if (input.limitApplied !== undefined && input.limitAdded === true) {
    lines.push(
      `${step}. **自动补 LIMIT** — 原语句没有写 LIMIT，已追加 \`LIMIT ${input.limitApplied}\`，避免一次把整张表拉回本地`,
    );
    step += 1;
  }
  // No step when the statement carried its own LIMIT: the SQL block already shows it, and quoting
  // `maxRows` here would claim a cap the query does not actually use.
  if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
    lines.push(`${step}. **超时保护** — 已注入 \`MAX_EXECUTION_TIME(${input.timeoutMs})\` 优化器提示，超时即中止`);
    step += 1;
  }
  if (input.failure !== undefined) {
    // The failure path still walks the steps the caller took, then stops where reality did.
    lines.push(`${step}. **执行失败** — 数据库拒绝了这条语句（详见下方错误信息）`, '');
    return lines.join('\n');
  }
  lines.push(
    `${step}. **执行** — 耗时 ${input.result.elapsedMs ?? '?'}ms，返回 ${input.result.rowCount ?? 0} 行` +
      `${input.result.truncated === true ? '（结果已被截断）' : ''}`,
    '',
  );
  return lines.join('\n');
}

/**
 * Render a clause-by-clause explanation produced by `explain.js`, plus its teaching hints.
 *
 * The clause text is deliberately **not** wrapped in backticks: real statements are full of
 * backticked identifiers, and nesting them would break the markdown rather than help.
 *
 * @param {ReturnType<import('./explain.js').explainSql>} explanation
 * @returns {string}
 */
export function renderExplanation(explanation) {
  const lines = ['### 语句讲解', ''];
  if (explanation.clauses.length === 0) {
    lines.push('（这条语句没有可拆解的子句。）');
  }
  for (const clause of explanation.clauses) {
    const body = condense(clause.text);
    lines.push(`- **${clause.label}** ${body === '' ? '（无内容）' : body}`, `  ↳ ${clause.note}`);
  }

  if (explanation.aggregates.length > 0) {
    lines.push('', `**用到的聚合函数**：${explanation.aggregates.map((fn) => `\`${fn}()\``).join('、')} — 把多行压成一行`);
  }
  if (explanation.joins.length > 0) {
    lines.push('', '**连接关系**：');
    for (const join of explanation.joins) {
      const label = join.alias === undefined ? `\`${join.table}\`` : `\`${join.table}\`（别名 \`${join.alias}\`）`;
      lines.push(
        join.on === undefined ? `- ${label} — ⚠️ 没有 ON 条件` : `- ${label} ON ${condense(join.on, 160)}`,
      );
    }
  }
  if (explanation.hints.length > 0) {
    lines.push('', '**教学提示**：');
    for (const hint of explanation.hints) lines.push(`- ${hint}`);
  }
  lines.push('');
  return lines.join('\n');
}
