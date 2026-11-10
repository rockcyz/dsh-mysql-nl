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
 *
 * DML has no result set but does have an effect: `affectedRows` is what the student needs to see,
 * because "0 行" after a successful `UPDATE` reads like nothing happened.
 * @param {import('./types.js').QueryResult} result
 * @returns {string}
 */
export function summarizeResult(result) {
  const table = result?.database ? `${result.database}` : '';
  const elapsed = typeof result?.elapsedMs === 'number' ? `${result.elapsedMs}ms` : '?';
  const truncated = result?.truncated ? '（已截断）' : '';
  if (typeof result?.affectedRows === 'number') {
    const inserted = typeof result.insertId === 'number' ? `，首个自增 ID ${result.insertId}` : '';
    return `影响 ${result.affectedRows} 行${inserted} / ${elapsed}${table === '' ? '' : ` · ${table}`}`;
  }
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
 * Describe the tables a statement touches, keeping the schema qualifier.
 *
 * `FROM jwgl.student` and `FROM student` behave completely differently: the second resolves against
 * the connection's default database, which is exactly the thing that silently breaks when someone
 * assumes the wrong one. Both cases are therefore spelled out rather than collapsed.
 *
 * @param {Array<{schema: string|null, table: string}>} refs
 * @param {string} database the connection's default schema
 * @returns {string}
 */
function describeTables(refs, database) {
  const label = (ref) => (ref.schema === null || ref.schema === '' ? ref.table : `${ref.schema}.${ref.table}`);
  const unqualified = refs.filter((ref) => ref.schema === null || ref.schema === '');
  if (refs.length === 0) return '（未能识别，交给数据库自行解析）';
  if (unqualified.length === 0) {
    // Nothing resolves against the default schema; make that explicit so nobody reads the connection
    // config and concludes the statement ran elsewhere.
    return `${refs.map(label).join('、')}（全部带库名，不受连接默认库 \`${database}\` 影响）`;
  }
  const listed = refs.map(label).join('、');
  // Unqualified names resolve against the connection's default schema, so say so even when that is
  // every table in the statement — that is precisely where the silent wrong-database bug lives.
  return `${listed}（其中 ${unqualified.map((ref) => ref.table).join('、')} 未写库名，按连接默认库 \`${database}\` 解析）`;
}

/**
 * Render the numbered "what actually happened" trace a student needs to see: which server was
 * contacted, what the statement was graded as, which tables it touches and against which schema,
 * whether a LIMIT was added for them, and what came back.
 *
 * `policy: 'handoff'` switches to the write lane: nothing was executed, so the trace must not claim
 * a read-only pass, a LIMIT, or a timeout — it says the statement was only generated.
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
 *   policy?: 'execute' | 'handoff',
 *   result: import('./types.js').QueryResult,
 * }} input
 * @returns {string}
 */
export function renderQuerySteps(input) {
  const handoff = input.policy === 'handoff';
  const target = `${input.connection.host ?? '127.0.0.1'}:${input.connection.port ?? 3306}`;
  const mode = input.readOnly ? '只读模式' : '读写模式';
  const lines = [
    '### 执行步骤',
    '',
    `1. **连接数据库** — \`${input.connection.id}\` → ${target}（${mode}${handoff ? '，写操作只生成不执行' : ''}）`,
  ];

  /** @type {Array<{schema: string|null, table: string}>} */
  const refs = (input.tables ?? []).map((entry) =>
    typeof entry === 'string' ? { schema: null, table: entry } : { schema: entry.schema ?? null, table: entry.table },
  );

  const tables = describeTables(refs, input.database);

  if (handoff) {
    lines.push(
      `2. **语句分级** — 识别为 \`${input.statementKind}\` 语句（写操作），按策略**不执行**，只生成给你自行运行`,
      `3. **涉及的表** — ${tables}`,
      '',
      '4. **未执行** — 插件不会改动任何数据；下方给出完整语句与讲解，供你复制到自己的客户端',
      '',
    );
    return lines.join('\n');
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
  if (typeof input.result.affectedRows === 'number') {
    // DML returns no rows; its outcome is how many rows it changed.
    const inserted = typeof input.result.insertId === 'number' ? `，首个自增 ID ${input.result.insertId}` : '';
    lines.push(`${step}. **执行** — 耗时 ${input.result.elapsedMs ?? '?'}ms，影响 ${input.result.affectedRows} 行${inserted}`, '');
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
 * Render a generated **write** statement as a hand-off: the statement plus everything a student
 * needs to run it safely somewhere else.
 *
 * This package never executes DML/DDL. That is a deliberate risk boundary, not a missing feature:
 * the plugin grounds the statement in the real schema and explains it, while the irreversible part
 * stays in a client the user chose and controls (DBeaver, MySQL Workbench, the `mysql` shell).
 * The output therefore has to read as an instruction manual, not as a result.
 *
 * @param {{
 *   sql: string,
 *   statementKind: string,
 *   grade: 'dml' | 'ddl',
 *   hasWhere: boolean,
 *   connection: {id: string, host?: string, port?: number},
 *   database: string,
 *   tables: Array<string | {schema?: string | null, table: string}>,
 *   explanation: ReturnType<import('./explain.js').explainSql>,
 * }} input
 * @returns {string}
 */
export function renderWriteHandoff(input) {
  const target = `${input.connection.host ?? '127.0.0.1'}:${input.connection.port ?? 3306}`;
  const refs = (input.tables ?? []).map((entry) =>
    typeof entry === 'string' ? { schema: null, table: entry } : { schema: entry.schema ?? null, table: entry.table },
  );
  const kindLabel = String(input.statementKind).toUpperCase();
  const scope = input.grade === 'ddl' ? '结构变更（DDL）' : '数据修改（DML）';
  // The copy target is a client, not this parser: hand over a statement that runs as pasted.
  const statement = `${input.sql.trim().replace(/;+\s*$/, '')};`;
  const isRowWrite = input.statementKind === 'update' || input.statementKind === 'delete';

  const lines = [
    '### ⚠️ 写操作：只生成，不执行',
    '',
    `**这是一条 \`${kindLabel}\` ${scope}语句。插件不会执行它**——数据风险留在你自己的客户端里。` +
      '请确认下面的 SQL 无误后，复制到 DBeaver / MySQL Workbench / Navicat 等工具运行。',
    '',
  ];

  if (!input.hasWhere && isRowWrite) {
    lines.push(
      '> 🚨 **这条语句没有 WHERE 条件**，会作用于整张表的所有行。若不是有意为之，' +
        '请把条件补进 SQL 再执行；一旦执行，未备份的数据无法撤销。',
      '',
    );
  }

  lines.push('### 执行前核对', '');
  if (isRowWrite && input.hasWhere) {
    lines.push('- 先跑一条**相同 WHERE 条件的 SELECT**，确认命中的行正是你要改/删的那些');
  } else if (isRowWrite) {
    lines.push('- 先跑 `SELECT COUNT(*)` 确认整表行数，确认这次真的要对**全部行**动手');
  } else {
    lines.push('- 先跑 `SHOW CREATE TABLE` 留存当前结构，并备份数据，结构变更出错时才有退路');
  }
  lines.push(
    `- 确认连的是正确的库：本次面向 \`${input.database}\`（\`${input.connection.id}\` → ${target}）`,
    `- 涉及的表：${describeTables(refs, input.database)}`,
    '- 重要数据先备份；确认无误后再提交事务',
    '',
    '### SQL 语句',
    '',
    '```sql',
    statement,
    '```',
    '',
    renderExplanation(input.explanation),
    '### 在你的客户端执行',
    '',
    `1. 打开 DBeaver / MySQL Workbench，连接 \`${target}\`，选中库 \`${input.database}\`；`,
    '2. 粘贴上面的语句（已补上结尾分号，可直接运行）；',
    '3. 查看预计影响行数，确认后提交：MySQL Workbench 记得 `COMMIT`，DBeaver 默认自动提交、需要回滚请先关闭它。',
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
