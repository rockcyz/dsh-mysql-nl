/**
 * mysql2 pool registry and single-statement execution with normalization and guard rails.
 * See CONTRACT.md for the frozen shapes.
 *
 * Design notes:
 * - Exactly one `mysql2/promise` pool exists per connection fingerprint (host, port, user,
 *   password, database, ssl, charset); `getPool` is synchronous and reuses it across calls.
 * - Statements run through `pool.getConnection()` + `connection.query()`. Placeholders are never
 *   used (`multipleStatements`/`namedPlaceholders` are off), so `execute()` would buy nothing.
 * - The session schema is set with `connection.changeUser({ database })` instead of a second
 *   `USE` statement: it is one round trip, it is parameterized by mysql2 (no identifier escaping
 *   bugs), it fails loudly with `ER_BAD_DB_ERROR` for unknown databases, and it resets session
 *   state on a recycled pooled connection. It runs on every query so a connection that was
 *   previously borrowed for another database can never leak its `USE` state into this query.
 * - Timeouts are enforced twice: a MySQL 8 `MAX_EXECUTION_TIME` optimizer hint for SELECT/WITH,
 *   and a hard client-side timer that `destroy()`s the connection. The hard timer fires
 *   `HARD_TIMEOUT_LEAD_MS` before the hint because MySQL honours the hint lazily: it *silently*
 *   returns a partial/aborted result (verified on 8.4.11 — `SELECT SLEEP(5)` with
 *   `MAX_EXECUTION_TIME(600)` resolves after ~608ms with `SLEEP()` returning 1) instead of
 *   raising an error, so only the client timer can produce a deterministic timeout failure.
 *   `connection.destroy()` removes the connection from the pool; the pool grows a fresh one on
 *   the next checkout, so a killed connection cannot poison it.
 * - TLS: `ssl: true` maps to `{ rejectUnauthorized: false }`, which is acceptable for a local
 *   developer tool talking to a self-signed MySQL but is *not* certificate-verified. An SSL
 *   options object is passed through untouched.
 * @module dsh-mysql-nl/core/client
 */

import mysql from 'mysql2/promise';

/** Default MySQL port when a connection omits one. @type {number} */
const DEFAULT_PORT = 3306;

/** Default host when a connection omits one. @type {string} */
const DEFAULT_HOST = '127.0.0.1';

/** Default character set. @type {string} */
const DEFAULT_CHARSET = 'utf8mb4';

/** Default row cap per query (CONTRACT: `ConnectionOptions.maxRows`). @type {number} */
const DEFAULT_ROW_LIMIT = 200;

/** Default per-cell character cap. @type {number} */
const DEFAULT_MAX_CELL_CHARS = 400;

/** Default per-statement time budget in milliseconds. @type {number} */
const DEFAULT_MAX_QUERY_MS = 15000;

/** Milliseconds the hard timer fires before the server-side hint (see module docs). @type {number} */
const HARD_TIMEOUT_LEAD_MS = 100;

/** Depth guard for nested cell values before they are stringified. @type {number} */
const MAX_JSON_DEPTH = 3;

/** Live pools, keyed by connection fingerprint. @type {Map<string, import('mysql2/promise').Pool>} */
const pools = new Map();

/**
 * Build the mysql2 pool options for one connection. Values are copied, never shared, so callers
 * may mutate their `ConnectionOptions` freely afterwards.
 * @param {import('./types.js').ConnectionOptions} conn
 * @returns {import('mysql2').PoolOptions}
 */
function buildPoolOptions(conn) {
  /** @type {import('mysql2').PoolOptions} */
  const options = {
    host: conn.host || DEFAULT_HOST,
    port: Number(conn.port) || DEFAULT_PORT,
    user: conn.user,
    waitForConnections: true,
    connectionLimit: 4,
    connectTimeout: 8000,
    charset: conn.charset || DEFAULT_CHARSET,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
    namedPlaceholders: false,
    rowsAsArray: false,
  };
  if (conn.password !== undefined) options.password = conn.password;
  if (conn.database) options.database = conn.database;
  if (conn.ssl) {
    options.ssl =
      typeof conn.ssl === 'object' && conn.ssl !== null ? conn.ssl : { rejectUnauthorized: false };
  }
  return options;
}

/**
 * Stable identity of a pool: two connections that would behave identically share one pool.
 * @param {import('mysql2').PoolOptions} options
 * @returns {string}
 */
function fingerprint(options) {
  return JSON.stringify([
    options.host,
    options.port,
    options.user,
    options.password ?? '',
    options.database ?? '',
    options.charset,
    options.ssl ? 1 : 0,
  ]);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number} a non-negative integer, or `Infinity` for "no limit"
 */
function normalizeLimit(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return Infinity;
  return Math.floor(numeric);
}

/**
 * @param {number} maxQueryMs
 * @returns {Error} a timeout error carrying `code === 'DSH_QUERY_TIMEOUT'`
 */
function timeoutError(maxQueryMs) {
  const error = new Error(`查询超过 ${maxQueryMs}ms 未完成，已中断该连接`);
  error.name = 'QueryTimeoutError';
  /** @type {*} */ (error).code = 'DSH_QUERY_TIMEOUT';
  return error;
}

/**
 * @returns {Error} an abort error carrying `code === 'DSH_QUERY_ABORTED'`
 */
function abortError() {
  const error = new Error('查询已被调用方取消');
  error.name = 'AbortError';
  /** @type {*} */ (error).code = 'DSH_QUERY_ABORTED';
  return error;
}

/**
 * Rethrowable view of an error that can never contain the connection password.
 * mysql2 errors already carry `code`/`sqlMessage`; this only redacts accidental echoes.
 * Short passwords (< 4 chars) and passwords that are also non-secret identity fields (`root`
 * user + `root` password is a common local setup) are left alone: MySQL never echoes a password,
 * and blind substring replacement would mangle unrelated text such as the account name in
 * `Access denied for user 'root'@'localhost'`.
 * @param {unknown} error
 * @param {import('./types.js').ConnectionOptions} conn
 * @returns {Error}
 */
function sanitizeError(error, conn) {
  const err = error instanceof Error ? error : new Error(String(error));
  const password = conn && conn.password;
  if (typeof password !== 'string' || password.length < 4) return err;
  const identity = [conn.user, conn.host, conn.database, conn.id].filter(
    (value) => typeof value === 'string' && value.length > 0,
  );
  if (identity.includes(password)) return err;
  if (typeof err.message === 'string' && err.message.includes(password)) {
    err.message = err.message.split(password).join('***');
  }
  return err;
}

/** @param {import('mysql2/promise').PoolConnection} connection */
function destroyQuietly(connection) {
  try {
    connection.destroy();
  } catch {
    /* the socket is already gone; nothing left to release */
  }
}

/**
 * Prefix the LIMIT-free statement with a MySQL 8 execution-time hint so the server abandons
 * runaway read-only scans on its own. SELECT gets the hint right after the keyword; WITH gets it
 * right after `WITH` (verified on 8.4.11 for plain, `RECURSIVE` and non-recursive CTEs — inside a
 * CTE body it would only bound that one query block).
 * @param {string} sql
 * @param {number} maxQueryMs
 * @returns {string}
 */
function applyExecutionHint(sql, maxQueryMs) {
  if (!(maxQueryMs > 0)) return sql;
  if (/MAX_EXECUTION_TIME\s*\(/i.test(sql)) return sql;
  const prefixMatch = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*/.exec(sql);
  const prefix = prefixMatch ? prefixMatch[0] : '';
  const rest = sql.slice(prefix.length);
  const keyword = (/^([A-Za-z]+)/.exec(rest)?.[1] ?? '').toUpperCase();
  if (keyword === 'SELECT') {
    return `${prefix}SELECT /*+ MAX_EXECUTION_TIME(${maxQueryMs}) */${rest.slice(6)}`;
  }
  if (keyword === 'WITH') {
    return `${prefix}WITH /*+ MAX_EXECUTION_TIME(${maxQueryMs}) */${rest.slice(4)}`;
  }
  return sql;
}

/**
 * @param {Date} date
 * @returns {string} local-time `YYYY-MM-DD HH:mm:ss`
 */
function formatDateTime(date) {
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * JSON-ish rendering of a nested value with a depth guard and cycle protection.
 * @param {unknown} value
 * @param {number} [depth]
 * @param {Set<unknown>} [seen]
 * @returns {string}
 */
function safeJson(value, depth = 0, seen = new Set()) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'number' || type === 'boolean') return String(value);
  if (type === 'bigint') return JSON.stringify(String(value));
  if (type === 'undefined') return 'null';
  if (depth >= MAX_JSON_DEPTH) return '"…"';
  if (type === 'object') {
    if (seen.has(value)) return '"<circular>"';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return `[${value.map((item) => safeJson(item, depth + 1, seen)).join(',')}]`;
      }
      const entries = Object.entries(/** @type {Record<string, unknown>} */ (value));
      return `{${entries
        .map(([key, item]) => `${JSON.stringify(key)}:${safeJson(item, depth + 1, seen)}`)
        .join(',')}}`;
    } catch {
      return JSON.stringify(String(value));
    } finally {
      seen.delete(value);
    }
  }
  return JSON.stringify(String(value));
}

/**
 * @param {unknown} value
 * @param {number} maxCellChars
 * @returns {unknown}
 */
function truncateCell(value, maxCellChars) {
  if (typeof value !== 'string') return value;
  if (!Number.isFinite(maxCellChars) || maxCellChars <= 0) return value;
  if (value.length <= maxCellChars) return value;
  return `${value.slice(0, maxCellChars)}…`;
}

/**
 * JSON-safe scalar for one cell: `bigint` becomes a decimal string, `Buffer` becomes hex (short)
 * or `"<N bytes>"`, `Date` becomes `YYYY-MM-DD HH:mm:ss` (rare, `dateStrings` is on), nested
 * objects/arrays are stringified with a depth guard, everything else passes through.
 * @param {unknown} value
 * @param {number} maxCellChars
 * @returns {unknown}
 */
function normalizeValue(value, maxCellChars) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  let normalized;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    normalized = value;
  } else if (type === 'bigint') {
    normalized = /** @type {bigint} */ (value).toString();
  } else if (Buffer.isBuffer(value)) {
    normalized = value.length <= 16 ? `0x${value.toString('hex')}` : `<${value.length} bytes>`;
  } else if (value instanceof Date) {
    normalized = formatDateTime(value);
  } else if (type === 'object') {
    normalized = safeJson(value);
  } else {
    normalized = String(value);
  }
  return truncateCell(normalized, maxCellChars);
}

/**
 * Lazily created pools, keyed by a stable fingerprint of the options.
 * @param {import('./types.js').ConnectionOptions} conn
 * @returns {import('mysql2/promise').Pool}
 */
export function getPool(conn) {
  const options = buildPoolOptions(conn);
  const key = fingerprint(options);
  let pool = pools.get(key);
  if (!pool) {
    pool = mysql.createPool(options);
    pools.set(key, pool);
  }
  return pool;
}

/**
 * Close and forget every pool (plugin unload). Idempotent; never throws.
 * Pools are dropped from the registry before they are awaited so a concurrent call is a no-op.
 * @returns {Promise<void>}
 */
export async function disposeAll() {
  const pending = [...pools.values()];
  pools.clear();
  await Promise.allSettled(
    pending.map(async (pool) => {
      await pool.end();
    }),
  );
}

/**
 * Host/port/user/database snapshot for diagnostics, never including the password.
 * @param {import('./types.js').ConnectionOptions} conn
 * @returns {{id:string, host:string, port:number, user:string, database?:string, readOnly:boolean}}
 */
export function describeTarget(conn) {
  /** @type {{id:string, host:string, port:number, user:string, database?:string, readOnly:boolean}} */
  const target = {
    id: conn.id,
    host: conn.host || DEFAULT_HOST,
    port: Number(conn.port) || DEFAULT_PORT,
    user: conn.user,
    readOnly: conn.readOnly !== false,
  };
  if (conn.database) target.database = conn.database;
  return target;
}

/**
 * Run one statement. `sql` is already final (no placeholders). Enforces `conn.maxQueryMs` with a
 * MySQL `MAX_EXECUTION_TIME` optimizer hint for SELECTs, the pool `connectTimeout` at the socket
 * level, and a hard timer that destroys the connection. Normalizes
 * bigint/decimal/Buffer/Date values to JSON-safe scalars: bigint -> string, Buffer -> "<N bytes>"
 * or hex for short binary, Date -> "YYYY-MM-DD HH:mm:ss". Applies rowLimit + maxCellChars
 * truncation and reports `truncated`.
 * @param {import('./types.js').ConnectionOptions} conn
 * @param {string} database
 * @param {string} sql
 * @param {{rowLimit?: number, maxCellChars?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<import('./types.js').QueryResult>} `columns` may be empty for statements with
 *   no result set.
 */
export async function runQuery(conn, database, sql, options = {}) {
  const statement = String(sql ?? '');
  const effectiveDatabase = database || conn.database || '';
  const rowLimit = normalizeLimit(options.rowLimit, conn.maxRows ?? DEFAULT_ROW_LIMIT);
  const maxCellChars = normalizeLimit(options.maxCellChars, DEFAULT_MAX_CELL_CHARS);
  const rawMaxQueryMs = conn.maxQueryMs ?? DEFAULT_MAX_QUERY_MS;
  const maxQueryMs = Number.isFinite(rawMaxQueryMs) && rawMaxQueryMs > 0 ? rawMaxQueryMs : 0;
  const finalSql = applyExecutionHint(statement, maxQueryMs);
  const { signal } = options;

  const pool = getPool(conn);
  let connection;
  try {
    connection = await pool.getConnection();
  } catch (error) {
    throw sanitizeError(error, conn);
  }

  const startedAt = Date.now();
  let destroyed = false;
  const destroyConnection = () => {
    if (destroyed) return;
    destroyed = true;
    destroyQuietly(connection);
  };

  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let hardTimer;
  /** @type {(() => void)|undefined} */
  let removeAbortListener;

  const timeoutPromise = new Promise((_resolve, reject) => {
    if (maxQueryMs <= 0) return;
    hardTimer = setTimeout(
      () => {
        destroyConnection();
        reject(timeoutError(maxQueryMs));
      },
      Math.max(1, maxQueryMs - HARD_TIMEOUT_LEAD_MS),
    );
  });

  const abortPromise = new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      destroyConnection();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });

  const queryPromise = (async () => {
    if (effectiveDatabase) {
      try {
        await connection.changeUser({ database: effectiveDatabase });
      } catch (error) {
        // A rejected COM_CHANGE_USER leaves the socket in an undefined state: verified on
        // mysql2 3.24.5 that releasing it poisons the pool and the next checkout fails with
        // ECONNRESET. Kill it instead of handing it back.
        destroyConnection();
        throw error;
      }
    }
    return connection.query(finalSql);
  })();

  try {
    const [rawRows, rawFields] = await Promise.race([queryPromise, timeoutPromise, abortPromise]);
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const fields = Array.isArray(rawFields) ? rawFields : [];
    const columns = fields.map((field) => String(field.name));
    const isRowSet = Array.isArray(rawRows);

    if (!isRowSet || columns.length === 0) {
      // A DML statement answers with an OkPacket, not a result set: mysql2 hands back
      // `{affectedRows, insertId, changedRows, warningStatus}` as the first tuple member. Reporting
      // that as "0 rows" would read like the statement did nothing.
      const ok = !isRowSet && rawRows !== null && typeof rawRows === 'object' ? rawRows : undefined;
      const affected = typeof ok?.affectedRows === 'number' ? ok.affectedRows : undefined;
      const insertId = typeof ok?.insertId === 'number' && ok.insertId !== 0 ? ok.insertId : undefined;
      return {
        database: effectiveDatabase,
        sql: finalSql,
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        elapsedMs,
        ...(affected === undefined ? {} : { affectedRows: affected }),
        ...(insertId === undefined ? {} : { insertId }),
      };
    }

    const truncated = Number.isFinite(rowLimit) && rawRows.length > rowLimit;
    const kept = truncated ? rawRows.slice(0, rowLimit) : rawRows;
    const rows = kept.map((row) =>
      columns.map((name) =>
        normalizeValue(/** @type {Record<string, unknown>} */ (row)?.[name], maxCellChars),
      ),
    );

    /** @type {import('./types.js').QueryResult} */
    const result = {
      database: effectiveDatabase,
      sql: finalSql,
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      elapsedMs,
    };
    if (truncated) result.warning = `已限制返回行数为 ${rowLimit}`;
    return result;
  } catch (error) {
    const ownError = /** @type {*} */ (error);
    if (ownError && (ownError.code === 'DSH_QUERY_TIMEOUT' || ownError.code === 'DSH_QUERY_ABORTED')) {
      throw error;
    }
    // Fatal transport errors mean the socket is already unusable; keep it out of the pool.
    if (ownError && ownError.fatal) destroyConnection();
    throw sanitizeError(error, conn);
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
    if (removeAbortListener) removeAbortListener();
    if (!destroyed) {
      try {
        connection.release();
      } catch {
        /* the pool already reclaimed the connection */
      }
    }
  }
}

/**
 * Cheap liveness probe: SELECT VERSION().
 * @param {import('./types.js').ConnectionOptions} conn
 * @returns {Promise<{version: string, user: string}>}
 */
export async function ping(conn) {
  const result = await runQuery(
    conn,
    conn.database,
    'SELECT VERSION() AS version, CURRENT_USER() AS user',
    { rowLimit: 1 },
  );
  const versionIndex = result.columns.indexOf('version');
  const userIndex = result.columns.indexOf('user');
  const row = result.rows[0] ?? [];
  return {
    version: String(versionIndex >= 0 ? row[versionIndex] : ''),
    user: String(userIndex >= 0 ? row[userIndex] : ''),
  };
}
