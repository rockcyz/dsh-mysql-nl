/**
 * Shared JSDoc typedefs. Import for typing only (`import('./types.js').TableInfo`); this module
 * exports nothing at runtime.
 * @module dsh-mysql-nl/core/types
 */

/**
 * One configured MySQL target.
 * @typedef {object} ConnectionOptions
 * @property {string} id
 * @property {string} [label]
 * @property {string} [host]
 * @property {number} [port]
 * @property {string} [user]
 * @property {string} [password]
 * @property {string} [database]
 * @property {boolean} [ssl]
 * @property {boolean} [readOnly]
 * @property {number} [maxRows]
 * @property {number} [maxQueryMs]
 * @property {string} [charset]
 * @property {boolean} [isDefault]
 * @property {string} [sourcePath]
 */

/**
 * @typedef {object} ResolvedConfig
 * @property {ConnectionOptions[]} connections
 * @property {string} [defaultId]
 * @property {string} path
 */

/**
 * @typedef {object} ColumnInfo
 * @property {string} name
 * @property {string} type
 * @property {boolean} nullable
 * @property {boolean} isPrimaryKey
 * @property {string} [comment]
 * @property {string} [default]
 * @property {boolean} [autoIncrement]
 */

/**
 * @typedef {object} IndexInfo
 * @property {string} name
 * @property {boolean} unique
 * @property {string[]} columns
 */

/**
 * @typedef {object} ForeignKeyInfo
 * @property {string} name
 * @property {string[]} columns
 * @property {string} referencedTable
 * @property {string[]} referencedColumns
 */

/**
 * @typedef {object} TableInfo
 * @property {string} name
 * @property {string} [comment]
 * @property {number} [rowEstimate]
 * @property {ColumnInfo[]} columns
 * @property {IndexInfo[]} indexes
 * @property {ForeignKeyInfo[]} foreignKeys
 */

/**
 * @typedef {object} Catalog
 * @property {string} database
 * @property {TableInfo[]} tables
 * @property {boolean} detailed
 */

/**
 * @typedef {object} QueryResult
 * @property {string} database
 * @property {string} sql          the exact statement sent to the server, safety wrappers included;
 *   display code should use the caller's own pre-`runQuery` string instead, so a student sees the
 *   statement they wrote rather than the injected `MAX_EXECUTION_TIME` hint
 * @property {unknown[]} columns
 * @property {unknown[][]} rows
 * @property {number} rowCount
 * @property {boolean} truncated
 * @property {number} elapsedMs
 * @property {string} [warning]
 * @property {number} [affectedRows]  rows changed by a DML statement. Present instead of a result
 *   set: without it a successful `UPDATE … WHERE …` would render as "0 rows", which reads like a
 *   no-op when in fact rows changed.
 * @property {number} [insertId]      first AUTO_INCREMENT value an `INSERT` assigned.
 */

export {};
