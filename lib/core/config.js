/**
 * Connection store: file discovery, loading, `${env:...}` substitution, normalization and
 * default-connection resolution. See CONTRACT.md for the frozen shapes.
 *
 * Discovery (first hit wins, regular files only):
 * 1. every name in {@link CONNECTION_FILE_NAMES} inside `cwd`, in order;
 * 2. every ancestor of `cwd` up to the filesystem root, nearest first, same name order;
 * 3. `os.homedir()`;
 * 4. `<homedir>/.dsh`.
 *
 * An explicit path short-circuits discovery and must exist — a missing explicit path throws
 * instead of silently falling back to the searched candidates.
 *
 * This module is dependency-free: Node builtins only, no `@deepseek-ai/*` import.
 *
 * @module dsh-mysql-nl/core/config
 */

import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Candidate file names probed in order relative to each search root. */
export const CONNECTION_FILE_NAMES = [
  '.dsh-mysql.json',
  'dsh-mysql.json',
  // Host-neutral name, so the same core also works as a plain CLI / Agent Skill outside DSH.
  'mysql-nl.json',
  '.dsh-mysql/connections.json',
];

/** Recognized keys of a connection object; anything else is reported as a typo. */
const CONNECTION_KEYS = [
  'id',
  'label',
  'host',
  'port',
  'user',
  'password',
  'database',
  'ssl',
  'readOnly',
  'maxRows',
  'maxQueryMs',
  'charset',
  'isDefault',
];
const CONNECTION_KEY_SET = new Set(CONNECTION_KEYS);

/** Recognized top-level keys when the document uses a `connections` array. */
const ROOT_KEYS = ['version', 'default', 'defaultId', 'connections', '$schema', 'description'];
const ROOT_KEY_SET = new Set(ROOT_KEYS);

/** Keys tolerated next to the `{ "mysql": { ... } }` alias wrapper. */
const MYSQL_WRAPPER_KEY_SET = new Set(['mysql', 'version', '$schema', 'description']);

/** `${env:NAME}` reference, whole-string or embedded. */
const ENV_REFERENCE = /\$\{env:([^}]*)\}/g;

/**
 * Find the connection file to load.
 *
 * @param {{cwd?: string, explicit?: string}} [options] `cwd` defaults to `process.cwd()`;
 *   `explicit` is a path relative to `cwd` (or absolute) that must exist.
 * @returns {Promise<string|null>} resolved absolute path of the first existing candidate, or
 *   `null` when nothing was found and no explicit path was given.
 * @throws {Error} when `explicit` is given but missing, unreadable, or not a regular file.
 */
export async function findConnectionsFile({ cwd, explicit } = {}) {
  const baseDir = path.resolve(cwd ?? process.cwd());

  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== 'string') {
      throw new Error(`explicit 必须是文件路径字符串，实际是 ${describeType(explicit)}`);
    }
    const trimmed = explicit.trim();
    if (trimmed !== '') {
      const target = path.resolve(baseDir, trimmed);
      let info;
      try {
        info = await stat(target);
      } catch {
        throw new Error(
          `找不到连接配置文件：${target}（explicit 显式指定的路径不存在；` +
            `相对路径按 cwd=${baseDir} 解析，且不会回退到默认搜索）`,
        );
      }
      if (!info.isFile()) {
        throw new Error(`连接配置路径不是普通文件：${target}`);
      }
      return target;
    }
  }

  for (const root of connectionSearchRoots(baseDir)) {
    for (const name of CONNECTION_FILE_NAMES) {
      const candidate = path.join(root, name);
      if (await isRegularFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Load, validate and normalize a connections document.
 *
 * `${env:NAME}` in any string *value* is substituted from `process.env`; a missing or empty
 * variable throws. Object keys are never substituted.
 *
 * @param {{cwd?: string, explicit?: string}} [options] Same semantics as
 *   {@link findConnectionsFile}; when no file is found this throws instead of returning `null`.
 * @returns {Promise<import('./types.js').ResolvedConfig>} connections carry materialized
 *   defaults plus `sourcePath`; `defaultId` is present only when it could be determined.
 * @throws {Error} On a missing file, unreadable file, bad JSON, unsupported shape, unknown key,
 *   duplicate id, invalid field value, missing environment variable, or empty connection list.
 */
export async function loadConnections({ cwd, explicit } = {}) {
  const baseDir = path.resolve(cwd ?? process.cwd());
  const filePath = await findConnectionsFile({ cwd: baseDir, explicit });
  if (filePath === null) {
    throw new Error(
      `未找到数据库连接配置文件：已在 ${baseDir} 及其所有上级目录、` +
        `${os.homedir()} 和 ${path.join(os.homedir(), '.dsh')} 中查找 ` +
        `${CONNECTION_FILE_NAMES.join(' / ')}；请创建该文件，或通过 connectionsFile 选项显式指定路径。`,
    );
  }

  const text = await readConfigText(filePath);
  let parsed;
  try {
    parsed = JSON.parse(stripByteOrderMark(text));
  } catch (err) {
    throw new Error(`连接配置文件不是合法的 JSON：${filePath}；解析错误：${messageOf(err)}`);
  }

  const document = substituteEnvDeep(parsed, filePath);
  const { entries, declaredDefault, allowImplicitId } = extractDocument(document, filePath);

  /** @type {import('./types.js').ConnectionOptions[]} */
  const connections = [];
  /** @type {Set<string>} */
  const knownIds = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isPlainObject(entry)) {
      throw new Error(
        `连接配置文件 ${filePath} 的 connections[${index}] 必须是对象，实际是 ${describeType(entry)}`,
      );
    }
    const connection = normalizeConnection(entry, { filePath, index, allowImplicitId });
    if (knownIds.has(connection.id)) {
      throw new Error(`连接配置文件 ${filePath} 中存在重复的连接 id："${connection.id}"`);
    }
    knownIds.add(connection.id);
    connections.push(connection);
  }
  if (connections.length === 0) {
    throw new Error(
      `未找到任何数据库连接配置：${filePath} 的 connections 是空数组，请至少配置一个连接。`,
    );
  }

  const flagged = connections.filter((connection) => connection.isDefault === true);
  if (flagged.length > 1) {
    throw new Error(
      `连接配置文件 ${filePath} 中有 ${flagged.length} 个连接设置了 isDefault：` +
        `${flagged.map((connection) => connection.id).join(', ')}；只能有一个默认连接。`,
    );
  }

  /** @type {string|undefined} */
  let defaultId;
  if (declaredDefault !== undefined) {
    if (!knownIds.has(declaredDefault)) {
      throw new Error(
        `连接配置文件 ${filePath} 的 default 指向不存在的连接 id："${declaredDefault}"；` +
          `已知连接：${[...knownIds].join(', ')}`,
      );
    }
    defaultId = declaredDefault;
  } else if (flagged.length === 1) {
    defaultId = flagged[0].id;
  } else if (connections.length === 1) {
    defaultId = connections[0].id;
  }

  /** @type {import('./types.js').ResolvedConfig} */
  const config = { connections, path: filePath };
  if (defaultId !== undefined) config.defaultId = defaultId;
  return config;
}

/**
 * Pick one connection out of a loaded config.
 *
 * Order: the explicit `id` -> `config.defaultId` -> the only connection -> throw. The returned
 * value is the exact object stored in `config.connections` (same identity).
 *
 * @param {import('./types.js').ResolvedConfig} config
 * @param {string} [id] Connection id; undefined or empty selects the configured default.
 * @returns {import('./types.js').ConnectionOptions}
 * @throws {Error} When the config has no connections, the id is unknown, or the id is required
 *   but missing; the message lists the known ids.
 */
export function resolveConnection(config, id) {
  const connections = config && Array.isArray(config.connections) ? config.connections : [];
  if (connections.length === 0) {
    throw new Error('没有可用的数据库连接配置，请先创建连接配置文件。');
  }
  const known = connections.map((connection) => connection.id).join(', ');

  const requested = id === undefined || id === null ? '' : String(id).trim();
  if (requested !== '') {
    const found = connections.find((connection) => connection.id === requested);
    if (found === undefined) {
      throw new Error(`未知的连接 id："${requested}"；已知连接：${known}`);
    }
    return found;
  }

  const defaultId =
    typeof config.defaultId === 'string' && config.defaultId !== '' ? config.defaultId : undefined;
  if (defaultId !== undefined) {
    const found = connections.find((connection) => connection.id === defaultId);
    if (found === undefined) {
      throw new Error(`连接配置的 defaultId "${defaultId}" 不在 connections 中；已知连接：${known}`);
    }
    return found;
  }

  if (connections.length === 1) return connections[0];
  throw new Error(`未指定连接 id，且配置中有多个连接；请指定其中之一：${known}`);
}

/* ------------------------------------------------------------------ discovery helpers */

/**
 * Build the deduplicated search roots for `baseDir`: itself, its ancestors up to the filesystem
 * root, the home directory, then `<home>/.dsh`.
 *
 * @param {string} baseDir Absolute directory to start from.
 * @returns {string[]} Absolute directories in probe order.
 */
function connectionSearchRoots(baseDir) {
  /** @type {string[]} */
  const roots = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const add = (dir) => {
    const absolute = path.resolve(dir);
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (seen.has(key)) return;
    seen.add(key);
    roots.push(absolute);
  };

  add(baseDir);
  for (const ancestor of ancestorDirs(baseDir)) add(ancestor);
  const home = os.homedir();
  add(home);
  add(path.join(home, '.dsh'));
  return roots;
}

/**
 * Parent chain of `dir`, nearest first, including the filesystem root and never looping.
 *
 * @param {string} dir Absolute directory.
 * @returns {string[]} Ancestor directories (excluding `dir` itself).
 */
function ancestorDirs(dir) {
  /** @type {string[]} */
  const ancestors = [];
  let current = dir;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return ancestors;
    ancestors.push(parent);
    current = parent;
  }
}

/**
 * @param {string} candidate Absolute path to probe.
 * @returns {Promise<boolean>} True only when the path exists and is a regular file.
 */
async function isRegularFile(candidate) {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------- document loading */

/**
 * @param {string} filePath Absolute path of the config file.
 * @returns {Promise<string>} Raw UTF-8 text.
 */
async function readConfigText(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(`无法读取连接配置文件 ${filePath}：${messageOf(err)}`);
  }
}

/**
 * Resolve the accepted document shapes to a connection entry list.
 * Shapes: `{version, default, connections}` / `{default, connections}` / bare array /
 * single connection object without a wrapper / `{mysql: <any of the above>}`.
 *
 * @param {unknown} document Parsed (and env-substituted) JSON document.
 * @param {string} filePath Absolute path of the config file, for messages.
 * @returns {{entries: unknown[], declaredDefault: string|undefined, allowImplicitId: boolean}}
 * @throws {Error} On an unsupported top-level shape or an unrecognized top-level key.
 */
function extractDocument(document, filePath) {
  let doc = document;

  if (isPlainObject(doc) && doc.connections === undefined && isPlainObject(doc.mysql)) {
    const stray = Object.keys(doc).filter((key) => !MYSQL_WRAPPER_KEY_SET.has(key));
    if (stray.length > 0) {
      throw new Error(
        `连接配置文件 ${filePath} 的 "mysql" 包装对象旁存在无法识别的键：${stray.join(', ')}`,
      );
    }
    doc = doc.mysql;
  }

  if (Array.isArray(doc)) {
    return { entries: doc, declaredDefault: undefined, allowImplicitId: false };
  }
  if (!isPlainObject(doc)) {
    throw new Error(
      `连接配置文件 ${filePath} 的顶层必须是对象或数组，实际是 ${describeType(doc)}`,
    );
  }

  if (doc.connections !== undefined) {
    const stray = Object.keys(doc).filter((key) => !ROOT_KEY_SET.has(key));
    if (stray.length > 0) {
      throw new Error(
        `连接配置文件 ${filePath} 包含无法识别的顶层键：${stray.join(', ')}；` +
          `可用顶层键：${ROOT_KEYS.join(', ')}`,
      );
    }
    if (!Array.isArray(doc.connections)) {
      throw new Error(
        `连接配置文件 ${filePath} 的 "connections" 必须是数组，实际是 ${describeType(doc.connections)}`,
      );
    }
    const declared = doc.default ?? doc.defaultId;
    return {
      entries: doc.connections,
      declaredDefault: normalizeDeclaredDefault(declared, filePath),
      allowImplicitId: false,
    };
  }

  // Convenience shape: a single connection object with no wrapper; `id` becomes "default".
  return { entries: [doc], declaredDefault: undefined, allowImplicitId: true };
}

/**
 * @param {unknown} value Raw `default`/`defaultId` field.
 * @param {string} filePath Absolute path of the config file, for messages.
 * @returns {string|undefined} Trimmed id, or undefined when unset/empty.
 * @throws {Error} When the field is present but not a string.
 */
function normalizeDeclaredDefault(value, filePath) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(
      `连接配置文件 ${filePath} 的 default 必须是字符串，实际是 ${describeType(value)}`,
    );
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/* ------------------------------------------------------------------ normalization */

/**
 * Validate one raw connection object and materialize every documented default.
 *
 * @param {Record<string, unknown>} entry Raw connection object.
 * @param {{filePath: string, index: number, allowImplicitId: boolean}} context
 * @returns {import('./types.js').ConnectionOptions}
 * @throws {Error} On unknown keys, missing required fields, wrong types or out-of-range values.
 */
function normalizeConnection(entry, { filePath, index, allowImplicitId }) {
  const where = typeof entry.id === 'string' && entry.id.trim() !== '' ? `"${entry.id.trim()}"` : `#${index + 1}`;
  const unknownKeys = Object.keys(entry).filter((key) => !CONNECTION_KEY_SET.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `连接配置文件 ${filePath} 的连接 ${where} 包含无法识别的键：${unknownKeys.join(', ')}；` +
        `可用键：${CONNECTION_KEYS.join(', ')}（请检查拼写，例如 passwd 应为 password）`,
    );
  }

  let id;
  if (entry.id === undefined || entry.id === null) {
    if (!allowImplicitId) {
      throw new Error(`连接配置文件 ${filePath} 的连接 ${where} 缺少必填的 "id"`);
    }
    id = 'default';
  } else if (typeof entry.id !== 'string' || entry.id.trim() === '') {
    throw new Error(
      `连接配置文件 ${filePath} 的连接 ${where} 的 "id" 必须是非空字符串，实际是 ${describeType(entry.id)}`,
    );
  } else {
    id = entry.id.trim();
  }

  const user = requiredString(entry, 'user', { filePath, where });
  const password = optionalString(entry, 'password', { filePath, where, allowEmpty: true }) ?? '';
  const database = optionalString(entry, 'database', { filePath, where, allowEmpty: true });
  const label = optionalString(entry, 'label', { filePath, where, allowEmpty: true });

  /** @type {import('./types.js').ConnectionOptions} */
  const connection = {
    id,
    host: stringWithDefault(entry, 'host', { filePath, where, fallback: '127.0.0.1' }),
    port: integerWithDefault(entry, 'port', {
      filePath,
      where,
      fallback: 3306,
      min: 1,
      max: 65535,
      clamp: false,
    }),
    user,
    password,
    ssl: booleanWithDefault(entry, 'ssl', { filePath, where, fallback: false }),
    readOnly: booleanWithDefault(entry, 'readOnly', { filePath, where, fallback: true }),
    maxRows: integerWithDefault(entry, 'maxRows', {
      filePath,
      where,
      fallback: 200,
      min: 1,
      max: 10000,
      clamp: true,
    }),
    maxQueryMs: integerWithDefault(entry, 'maxQueryMs', {
      filePath,
      where,
      fallback: 15000,
      min: 100,
      max: 600000,
      clamp: true,
    }),
    charset: stringWithDefault(entry, 'charset', { filePath, where, fallback: 'utf8mb4' }),
    isDefault: booleanWithDefault(entry, 'isDefault', { filePath, where, fallback: false }),
    sourcePath: filePath,
  };
  if (label !== undefined) connection.label = label;
  if (database !== undefined) connection.database = database;
  return connection;
}

/**
 * Read a required non-empty string field.
 *
 * @param {Record<string, unknown>} entry Raw connection object.
 * @param {string} key Field name.
 * @param {{filePath: string, where: string}} context
 * @returns {string}
 * @throws {Error} When the field is missing, empty, or not a string.
 */
function requiredString(entry, key, { filePath, where }) {
  const raw = entry[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      `连接配置文件 ${filePath} 的连接 ${where} 缺少必填的非空字符串 "${key}"，实际是 ${describeType(raw)}`,
    );
  }
  return raw;
}

/**
 * Read an optional string field; `null`/absent yield undefined.
 *
 * @param {Record<string, unknown>} entry Raw connection object.
 * @param {string} key Field name.
 * @param {{filePath: string, where: string, allowEmpty?: boolean}} context `allowEmpty` permits "".
 * @returns {string|undefined}
 * @throws {Error} When the field is present but not an allowed string.
 */
function optionalString(entry, key, { filePath, where, allowEmpty = false }) {
  const raw = entry[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || (!allowEmpty && raw.trim() === '')) {
    throw new Error(
      `连接配置文件 ${filePath} 的连接 ${where} 的 "${key}" 必须是${allowEmpty ? '' : '非空'}字符串，` +
        `实际是 ${describeType(raw)}`,
    );
  }
  return raw;
}

/**
 * Read an optional string field with a documented fallback.
 *
 * @param {Record<string, unknown>} entry Raw connection object.
 * @param {string} key Field name.
 * @param {{filePath: string, where: string, fallback: string}} context
 * @returns {string}
 * @throws {Error} When the field is present but not a non-empty string.
 */
function stringWithDefault(entry, key, { filePath, where, fallback }) {
  const value = optionalString(entry, key, { filePath, where });
  return value === undefined ? fallback : value;
}

/**
 * Read an optional boolean field with a documented fallback.
 *
 * @param {Record<string, unknown>} entry Raw connection object.
 * @param {string} key Field name.
 * @param {{filePath: string, where: string, fallback: boolean}} context
 * @returns {boolean}
 * @throws {Error} When the field is present but not a boolean.
 */
function booleanWithDefault(entry, key, { filePath, where, fallback }) {
  const raw = entry[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') {
    throw new Error(
      `连接配置文件 ${filePath} 的连接 ${where} 的 "${key}" 必须是 true 或 false，` +
        `实际是 ${describeType(raw)}`,
    );
  }
  return raw;
}

/**
 * Read an optional integer field; numeric strings are accepted. `clamp: true` squeezes the value
 * into `min..max` (used for maxRows/maxQueryMs), otherwise an out-of-range value throws (port).
 *
 * @param {Record<string, unknown>} entry Raw connection object.
 * @param {string} key Field name.
 * @param {{filePath: string, where: string, fallback: number, min: number, max: number,
 *   clamp: boolean}} context
 * @returns {number}
 * @throws {Error} When the field is not an integer or violates the range without clamping.
 */
function integerWithDefault(entry, key, { filePath, where, fallback, min, max, clamp }) {
  const raw = entry[key];
  if (raw === undefined || raw === null) return fallback;

  let value;
  if (typeof raw === 'number') value = raw;
  else if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw.trim()))) {
    value = Number(raw.trim());
  } else {
    throw new Error(
      `连接配置文件 ${filePath} 的连接 ${where} 的 "${key}" 必须是整数，实际是 ${JSON.stringify(raw)}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new Error(
      `连接配置文件 ${filePath} 的连接 ${where} 的 "${key}" 必须是整数，实际是 ${JSON.stringify(raw)}`,
    );
  }
  if (clamp) return Math.min(max, Math.max(min, value));
  if (value < min || value > max) {
    throw new Error(
      `连接配置文件 ${filePath} 的连接 ${where} 的 "${key}" 必须在 ${min}..${max} 之间，实际是 ${value}`,
    );
  }
  return value;
}

/* --------------------------------------------------------------- env substitution */

/**
 * Recursively replace `${env:NAME}` in every string value. Object keys are never touched.
 *
 * @param {unknown} node Parsed JSON value.
 * @param {string} filePath Absolute path of the config file, for messages.
 * @returns {unknown} A structurally identical value with references resolved.
 * @throws {Error} When a referenced variable is missing or empty, or the name is empty.
 */
function substituteEnvDeep(node, filePath) {
  if (typeof node === 'string') return substituteEnvReferences(node, filePath);
  if (Array.isArray(node)) return node.map((item) => substituteEnvDeep(item, filePath));
  if (isPlainObject(node)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = substituteEnvDeep(value, filePath);
    return out;
  }
  return node;
}

/**
 * @param {string} value String value from the document.
 * @param {string} filePath Absolute path of the config file, for messages.
 * @returns {string} The value with all `${env:NAME}` references resolved.
 * @throws {Error} When a referenced variable is missing or empty, or the name is empty.
 */
function substituteEnvReferences(value, filePath) {
  return value.replace(ENV_REFERENCE, (_match, rawName) => {
    const name = String(rawName).trim();
    if (name === '') {
      throw new Error(`连接配置文件 ${filePath} 中存在空的 \${env:} 引用，请写成 \${env:NAME}`);
    }
    const resolved = process.env[name];
    if (resolved === undefined || resolved === '') {
      throw new Error(
        `连接配置文件 ${filePath} 引用了未设置（或为空）的环境变量 ${name}（\${env:${name}}）；` +
          '请先设置该环境变量，或改用直接的字符串值。',
      );
    }
    return resolved;
  });
}

/* ------------------------------------------------------------------------- utilities */

/**
 * @param {unknown} value Candidate value.
 * @returns {boolean} True for a non-null, non-array object (JSON documents are plain objects).
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value Value to describe in an error message.
 * @returns {string} Human-readable JSON-ish type name.
 */
function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  if (value === undefined) return '未提供';
  return typeof value;
}

/**
 * Strip a leading UTF-8 BOM.
 *
 * Exported because every human-authored JSON file this package reads needs it: Windows editors
 * (Notepad, `Set-Content -Encoding UTF8` on PowerShell 5.1) add a BOM by default, and
 * `JSON.parse` rejects it with a confusing "Unexpected token" error. Keeping one helper means the
 * connection store and the semantic-layer verifier cannot disagree about it.
 *
 * @param {string} text File text.
 * @returns {string} Text without a leading BOM.
 */
export function stripByteOrderMark(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * @param {unknown} err Caught value.
 * @returns {string} Its message when available.
 */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}
