/**
 * INFORMATION_SCHEMA introspection and compact schema text for prompts.
 * See CONTRACT.md for the frozen shapes.
 *
 * Design notes:
 * - Every catalog query goes through `client.runQuery` so pooling, timeouts and value
 *   normalization stay in one place. Metadata queries pass `rowLimit: Infinity` and
 *   `maxCellChars: Infinity` because truncating a catalog would silently corrupt the schema text.
 * - `IN (?)` array placeholders are not used: `runQuery` takes a final statement with no parameter
 *   channel, so table lists are escaped with `mysql.escape` and inlined. Table names come from
 *   INFORMATION_SCHEMA itself, and escaping keeps even hostile names inert.
 * - Only `BASE TABLE` rows are catalogued. Views are queryable but carry no row estimate, no
 *   primary key and no real indexes, which makes them misleading in a prompt; the `world` sample
 *   database ships one view (`eastern_asia_city_population`) that would otherwise inflate the
 *   "3 tables" expectation. Flip `BASE_TABLE_ONLY` to include views.
 * @module dsh-mysql-nl/core/catalog
 */

import mysql from 'mysql2/promise';

import { runQuery } from './client.js';

/** Only base tables are catalogued (see module docs). @type {string} */
const BASE_TABLE_ONLY = "TABLE_TYPE = 'BASE TABLE'";

/** Default `renderSchema` character budget. @type {number} */
const DEFAULT_SCHEMA_CHARS = 60000;

/** Schemas that are never interesting to a user query. @type {string[]} */
const SYSTEM_SCHEMAS = ['information_schema', 'mysql', 'performance_schema', 'sys'];

/**
 * Query helper that turns a row-major `QueryResult` back into plain objects keyed by the SELECT
 * aliases, with every guard rail of `runQuery` still in force.
 * @param {import('./types.js').ConnectionOptions} conn
 * @param {string} database
 * @param {string} sql
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function queryRows(conn, database, sql) {
  const result = await runQuery(conn, database, sql, {
    rowLimit: Infinity,
    maxCellChars: Infinity,
  });
  return result.rows.map((values) => {
    /** @type {Record<string, unknown>} */
    const row = {};
    for (let index = 0; index < result.columns.length; index += 1) {
      row[result.columns[index]] = values[index];
    }
    return row;
  });
}

/**
 * Escape one SQL string literal (`'` -> `''`), the only interpolation this module performs.
 * @param {string} value
 * @returns {string}
 */
function escapeLiteral(value) {
  return mysql.escape(value);
}

/**
 * `AND TABLE_NAME IN (...)` fragment for the given real table names.
 * @param {string} column e.g. `TABLE_NAME` or `k.TABLE_NAME`
 * @param {string[]} names
 * @returns {string} empty string when `names` is empty
 */
function inFilter(column, names) {
  if (names.length === 0) return '';
  return ` AND ${column} IN (${names.map((name) => escapeLiteral(name)).join(', ')})`;
}

/**
 * @param {unknown} value
 * @returns {number|undefined}
 */
function toRowEstimate(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * @param {unknown} value
 * @returns {string|undefined} trimmed text, or undefined when empty
 */
function toText(value) {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

/**
 * @param {import('./types.js').ConnectionOptions} conn
 * @returns {Promise<string[]>} non-system schemas, sorted.
 */
export async function listDatabases(conn) {
  const placeholders = SYSTEM_SCHEMAS.map((name) => escapeLiteral(name)).join(', ');
  const rows = await queryRows(
    conn,
    conn.database,
    'SELECT SCHEMA_NAME AS name FROM INFORMATION_SCHEMA.SCHEMATA ' +
      `WHERE SCHEMA_NAME NOT IN (${placeholders}) ORDER BY SCHEMA_NAME`,
  );
  return rows.map((row) => String(row.name));
}

/**
 * Catalog-only pass: every table with rowEstimate + comment, `columns`/`indexes`/`foreignKeys`
 * empty.
 * @param {import('./types.js').ConnectionOptions} conn
 * @param {string} database
 * @returns {Promise<import('./types.js').Catalog>}
 */
export async function loadCatalog(conn, database) {
  const rows = await queryRows(
    conn,
    database,
    'SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment, TABLE_ROWS AS rowEstimate ' +
      `FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ${escapeLiteral(database)} ` +
      `AND ${BASE_TABLE_ONLY} ORDER BY TABLE_NAME`,
  );
  return {
    database,
    detailed: false,
    tables: rows.map((row) => {
      /** @type {import('./types.js').TableInfo} */
      const table = {
        name: String(row.name),
        columns: [],
        indexes: [],
        foreignKeys: [],
      };
      const comment = toText(row.comment);
      if (comment) table.comment = comment;
      const rowEstimate = toRowEstimate(row.rowEstimate);
      if (rowEstimate !== undefined) table.rowEstimate = rowEstimate;
      return table;
    }),
  };
}

/**
 * Full detail pass. `tableNames` undefined (or empty) -> every table in the database; otherwise
 * only the requested tables are returned, each with complete column/index/foreign-key detail
 * (this is what keeps the two-stage prompt pipeline cheap on a 500-table schema).
 * @param {import('./types.js').ConnectionOptions} conn
 * @param {string} database
 * @param {string[]} [tableNames]
 * @returns {Promise<import('./types.js').Catalog>} with `detailed: true`.
 */
export async function loadTableDetails(conn, database, tableNames) {
  const catalog = await loadCatalog(conn, database);
  const requested =
    Array.isArray(tableNames) && tableNames.length > 0
      ? new Set(tableNames.map((name) => String(name)))
      : null;
  const tables = requested ? catalog.tables.filter((table) => requested.has(table.name)) : catalog.tables;
  if (tables.length === 0) {
    return { database: catalog.database, tables: [], detailed: true };
  }
  const wanted = tables.map((table) => table.name);
  const plainFilter = inFilter('TABLE_NAME', wanted);

  /** @type {Map<string, import('./types.js').ColumnInfo[]>} */
  const columnsByTable = new Map();
  const columnRows = await queryRows(
    conn,
    database,
    'SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType, ' +
      'IS_NULLABLE AS isNullable, COLUMN_KEY AS columnKey, COLUMN_COMMENT AS columnComment, ' +
      'COLUMN_DEFAULT AS columnDefault, EXTRA AS extra ' +
      `FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ${escapeLiteral(database)}` +
      `${plainFilter} ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  );
  for (const row of columnRows) {
    const tableName = String(row.tableName);
    const list = columnsByTable.get(tableName) ?? [];
    /** @type {import('./types.js').ColumnInfo} */
    const column = {
      name: String(row.columnName),
      type: String(row.columnType),
      nullable: String(row.isNullable).toUpperCase() === 'YES',
      isPrimaryKey: String(row.columnKey).toUpperCase() === 'PRI',
    };
    const comment = toText(row.columnComment);
    if (comment) column.comment = comment;
    if (row.columnDefault !== null && row.columnDefault !== undefined) {
      column.default = String(row.columnDefault);
    }
    if (String(row.extra).includes('auto_increment')) column.autoIncrement = true;
    list.push(column);
    columnsByTable.set(tableName, list);
  }

  /** @type {Map<string, import('./types.js').IndexInfo[]>} */
  const indexesByTable = new Map();
  /** @type {Map<string, import('./types.js').IndexInfo>} */
  const indexGroups = new Map();
  const indexRows = await queryRows(
    conn,
    database,
    'SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique, ' +
      'SEQ_IN_INDEX AS seqInIndex, COLUMN_NAME AS columnName FROM INFORMATION_SCHEMA.STATISTICS ' +
      `WHERE TABLE_SCHEMA = ${escapeLiteral(database)}${plainFilter} ` +
      'ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX',
  );
  for (const row of indexRows) {
    const tableName = String(row.tableName);
    const indexName = String(row.indexName);
    const groupKey = `${tableName}\u0000${indexName}`;
    let index = indexGroups.get(groupKey);
    if (!index) {
      index = { name: indexName, unique: Number(row.nonUnique) === 0, columns: [] };
      indexGroups.set(groupKey, index);
      const list = indexesByTable.get(tableName) ?? [];
      list.push(index);
      indexesByTable.set(tableName, list);
    }
    const column = toText(row.columnName);
    if (column) index.columns.push(column);
  }

  /** @type {Map<string, import('./types.js').ForeignKeyInfo[]>} */
  const foreignKeysByTable = new Map();
  /** @type {Map<string, import('./types.js').ForeignKeyInfo>} */
  const foreignKeyGroups = new Map();
  const foreignKeyRows = await queryRows(
    conn,
    database,
    'SELECT k.TABLE_NAME AS tableName, k.CONSTRAINT_NAME AS constraintName, ' +
      'k.COLUMN_NAME AS columnName, k.ORDINAL_POSITION AS ordinalPosition, ' +
      'k.REFERENCED_TABLE_NAME AS referencedTable, k.REFERENCED_COLUMN_NAME AS referencedColumn ' +
      'FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS k ' +
      'JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS r ' +
      'ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME ' +
      'AND r.TABLE_NAME = k.TABLE_NAME ' +
      `WHERE k.TABLE_SCHEMA = ${escapeLiteral(database)} AND k.REFERENCED_TABLE_NAME IS NOT NULL` +
      `${inFilter('k.TABLE_NAME', wanted)} ` +
      'ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION',
  );
  for (const row of foreignKeyRows) {
    const tableName = String(row.tableName);
    const constraintName = String(row.constraintName);
    const referencedTable = String(row.referencedTable);
    const groupKey = `${tableName}\u0000${constraintName}\u0000${referencedTable}`;
    let foreignKey = foreignKeyGroups.get(groupKey);
    if (!foreignKey) {
      foreignKey = { name: constraintName, columns: [], referencedTable, referencedColumns: [] };
      foreignKeyGroups.set(groupKey, foreignKey);
      const list = foreignKeysByTable.get(tableName) ?? [];
      list.push(foreignKey);
      foreignKeysByTable.set(tableName, list);
    }
    const column = toText(row.columnName);
    if (column) foreignKey.columns.push(column);
    const referencedColumn = toText(row.referencedColumn);
    if (referencedColumn) foreignKey.referencedColumns.push(referencedColumn);
  }

  return {
    database: catalog.database,
    detailed: true,
    tables: tables.map((table) => ({
      ...table,
      columns: columnsByTable.get(table.name) ?? [],
      indexes: indexesByTable.get(table.name) ?? [],
      foreignKeys: foreignKeysByTable.get(table.name) ?? [],
    })),
  };
}

/**
 * One `- name type [markers] #comment` line.
 * @param {import('./types.js').ColumnInfo} column
 * @param {Set<string>} uniqueColumns
 * @returns {string}
 */
function renderColumn(column, uniqueColumns) {
  const parts = [`- ${column.name} ${column.type}`];
  if (!column.nullable) parts.push('!NOT NULL');
  if (column.isPrimaryKey) parts.push('[PK]');
  if (column.autoIncrement) parts.push('[AI]');
  if (uniqueColumns.has(column.name)) parts.push('[UNIQUE]');
  const line = parts.join(' ');
  return column.comment ? `${line} #${column.comment.replace(/\s+/g, ' ')}` : line;
}

/**
 * @param {import('./types.js').TableInfo} table
 * @returns {string}
 */
function renderTable(table) {
  const lines = [];
  const columns = table.columns ?? [];
  const indexes = table.indexes ?? [];
  const uniqueColumns = new Set();
  for (const index of indexes) {
    if (index.unique && index.name !== 'PRIMARY' && index.columns.length === 1) {
      uniqueColumns.add(index.columns[0]);
    }
  }
  const rows = typeof table.rowEstimate === 'number' ? ` (≈${table.rowEstimate} rows)` : '';
  const comment = table.comment ? ` -- ${table.comment.replace(/\s+/g, ' ')}` : '';
  lines.push(`### ${table.name}${rows}${comment}`);
  for (const column of columns) lines.push(renderColumn(column, uniqueColumns));
  for (const foreignKey of table.foreignKeys ?? []) {
    lines.push(
      `FK: ${table.name}.${foreignKey.columns.join(',')} -> ` +
        `${foreignKey.referencedTable}.${foreignKey.referencedColumns.join(',')}`,
    );
  }
  for (const index of indexes) {
    if (index.name === 'PRIMARY') continue;
    const prefix = index.unique ? 'UNIQUE ' : '';
    lines.push(`IDX: ${prefix}${index.name}(${index.columns.join(',')})`);
  }
  return lines.join('\n');
}

/**
 * Compact, token-efficient schema text for an LLM prompt. Sections:
 * `## DATABASE <name>`, `### <table> (≈<rows> rows) -- <comment>`,
 * one line per column `- name type[!NOT NULL][PK][AI][UNIQUE] #comment`,
 * then `FK: a.b -> c.d`, then `IDX: name(cols)`.
 * Whole tables are dropped from the tail to respect `maxChars`, and the dropped count is reported
 * on one final line. Never emits markdown tables or SQL the model could mistake for the answer.
 * @param {import('./types.js').Catalog} catalog
 * @param {{maxChars?: number}} [options]
 * @returns {string}
 */
export function renderSchema(catalog, options = {}) {
  const tables = Array.isArray(catalog?.tables) ? catalog.tables : [];
  const requested = Number(options.maxChars ?? DEFAULT_SCHEMA_CHARS);
  const maxChars = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_SCHEMA_CHARS;
  const footer = (dropped) => `\n...(还有 ${dropped} 张表未展示)`;

  let text = `## DATABASE ${catalog?.database ?? ''}`;
  let shown = 0;
  for (const table of tables) {
    const block = renderTable(table);
    const remaining = tables.length - shown - 1;
    const reserve = remaining > 0 ? footer(remaining).length : 0;
    if (text.length + block.length + 2 + reserve > maxChars) break;
    text += `\n\n${block}`;
    shown += 1;
  }
  const dropped = tables.length - shown;
  if (dropped > 0) text += footer(dropped);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Words that carry no table-selection signal. @type {Set<string>} */
const STOPWORDS = new Set([
  'a', 'all', 'an', 'and', 'any', 'are', 'as', 'at', 'avg', 'be', 'between', 'by', 'column',
  'columns', 'count', 'data', 'distinct', 'do', 'does', 'each', 'every', 'find', 'for', 'from',
  'get', 'give', 'group', 'having', 'how', 'i', 'in', 'into', 'is', 'it', 'its', 'join', 'last',
  'limit', 'list', 'many', 'max', 'me', 'min', 'most', 'my', 'not', 'number', 'of', 'on', 'or',
  'order', 'our', 'per', 'please', 'row', 'rows', 'select', 'show', 'sum', 'table', 'tables',
  'than', 'that', 'the', 'their', 'there', 'these', 'this', 'those', 'to', 'top', 'value',
  'values', 'want', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'with', 'you',
  'your',
]);

/**
 * Small Chinese -> latin glossary. A pure-Chinese question shares no characters with English
 * INFORMATION_SCHEMA names, so without this bridge every table would score zero and the ranking
 * would degrade to alphabetical order. Keys are two-character CJK terms.
 * @type {Record<string, string[]>}
 */
const CJK_HINTS = {
  电影: ['film', 'movie'],
  影片: ['film'],
  演员: ['actor'],
  影星: ['actor'],
  客户: ['customer'],
  顾客: ['customer'],
  租赁: ['rental'],
  出租: ['rental'],
  支付: ['payment'],
  付款: ['payment'],
  城市: ['city'],
  国家: ['country'],
  语言: ['language'],
  商店: ['store'],
  门店: ['store'],
  员工: ['staff'],
  职员: ['staff'],
  库存: ['inventory'],
  存货: ['inventory'],
  分类: ['category'],
  类别: ['category'],
  地址: ['address'],
  地区: ['address'],
  订单: ['order'],
  销售: ['sales'],
  商品: ['product'],
  产品: ['product'],
  学生: ['student'],
  成绩: ['score'],
  课程: ['course'],
  老师: ['teacher'],
  教师: ['teacher'],
  账户: ['account'],
  账号: ['account'],
  银行: ['bank'],
  部门: ['department'],
  人口: ['population'],
  首都: ['capital'],
  名称: ['name'],
  名字: ['name'],
  标题: ['title'],
  时长: ['length'],
  评分: ['rating'],
  价格: ['price'],
  金额: ['amount'],
  数量: ['quantity'],
  日期: ['date'],
  时间: ['time'],
};

/**
 * Naive singular form used for the plural/singular matching boost.
 * @param {string} word
 * @returns {string}
 */
function singularize(word) {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * @param {string} question
 * @returns {Set<string>} latin words, CJK bigrams, full CJK runs and glossary expansions
 */
function tokenizeQuestion(question) {
  const lowered = question.toLowerCase();
  const tokens = new Set();
  for (const word of lowered.match(/[a-z0-9_]+/g) ?? []) {
    if (word.length >= 2 && !STOPWORDS.has(word)) tokens.add(word);
  }
  for (const run of lowered.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (run.length < 2) continue;
    tokens.add(run);
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      tokens.add(bigram);
      for (const word of CJK_HINTS[bigram] ?? []) tokens.add(word);
    }
  }
  return tokens;
}

/**
 * @param {import('./types.js').TableInfo} table
 * @param {Set<string>} tokens
 * @returns {number}
 */
function scoreTable(table, tokens) {
  const name = String(table?.name ?? '').toLowerCase();
  if (!name) return 0;
  const segments = name.split(/[^a-z0-9]+/).filter(Boolean);
  const comment = String(table?.comment ?? '').toLowerCase();
  const columnNames = (table?.columns ?? [])
    .map((column) => String(column?.name ?? '').toLowerCase())
    .filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    const singular = singularize(token);
    if (token === name) {
      score += 12;
    } else if (singular === name) {
      score += 11;
    } else if (segments.includes(token) || segments.includes(singular)) {
      score += 10;
    } else if (
      name.length >= 3 &&
      token.length >= 4 &&
      (name.includes(token) || name.includes(singular))
    ) {
      // A bare substring hit must stay well below an exact/segment/plural hit, otherwise
      // "countries" would rank `countrylanguage` above `country`.
      score += 3;
    }
    if (token.length >= 3 && comment.includes(token)) score += 4;
    if (columnNames.includes(token) || (singular !== token && columnNames.includes(singular))) {
      score += 3;
    } else if (token.length >= 4 && columnNames.some((column) => column.includes(token))) {
      score += 2;
    }
  }
  return score;
}

/**
 * Heuristic lexical pre-filter kept for large databases: score tables against a natural-language
 * question using table name, table comment, column names, and Chinese character bigrams.
 * Pure function: no IO, deterministic (score desc, then table name by code unit).
 * @param {import('./types.js').Catalog} catalog
 * @param {string} question
 * @param {number} limit
 * @returns {string[]} table names, best first, length <= limit (never empty when tables exist)
 */
export function pickRelevantTables(catalog, question, limit) {
  const seen = new Set();
  /** @type {import('./types.js').TableInfo[]} */
  const tables = [];
  for (const table of Array.isArray(catalog?.tables) ? catalog.tables : []) {
    const name = String(table?.name ?? '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    tables.push(table);
  }
  if (tables.length === 0) return [];

  const tokens = tokenizeQuestion(String(question ?? ''));
  const ranked = tables
    .map((table) => ({ name: String(table.name), score: scoreTable(table, tokens) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.name === right.name) return 0;
      return left.name < right.name ? -1 : 1;
    });
  const requestedLimit = Number(limit);
  const cap =
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : ranked.length;
  return ranked.slice(0, Math.min(cap, ranked.length)).map((entry) => entry.name);
}
