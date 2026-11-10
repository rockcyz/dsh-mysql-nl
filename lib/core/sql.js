/**
 * Statement cleaning, classification, read-only guarding, LIMIT enforcement, and structural analysis.
 * Pure functions, no IO — every rule here is unit-testable and applied to model-generated SQL before
 * it is allowed anywhere near a connection.
 * @module dsh-mysql-nl/core/sql
 */

/** Top-level keywords that are inherently read-only. */
const READ_ONLY_KINDS = new Set(['select', 'with', 'show', 'describe', 'desc', 'explain', 'analyze', 'help']);

/** Keywords that mutate data or schema, mapped to a human-readable Chinese label. */
const WRITE_KEYWORDS = new Map([
  ['insert', 'INSERT 插入数据'],
  ['update', 'UPDATE 修改数据'],
  ['delete', 'DELETE 删除数据'],
  ['replace', 'REPLACE 覆盖数据'],
  ['merge', 'MERGE 合并数据'],
  ['truncate', 'TRUNCATE 清空表'],
  ['drop', 'DROP 删除对象'],
  ['create', 'CREATE 创建对象'],
  ['alter', 'ALTER 修改表结构'],
  ['rename', 'RENAME 重命名对象'],
  ['grant', 'GRANT 授权'],
  ['revoke', 'REVOKE 回收权限'],
  ['set', 'SET 修改会话/全局变量'],
  ['use', 'USE 切换数据库'],
  ['call', 'CALL 调用存储过程'],
  ['do', 'DO 执行表达式'],
  ['handler', 'HANDLER 语句'],
  ['load', 'LOAD 导入数据'],
  ['lock', 'LOCK 锁表'],
  ['unlock', 'UNLOCK 解锁'],
  ['commit', 'COMMIT 提交事务'],
  ['rollback', 'ROLLBACK 回滚事务'],
  ['start', 'START TRANSACTION 开启事务'],
  ['begin', 'BEGIN 开启事务'],
  ['savepoint', 'SAVEPOINT 保存点'],
  ['install', 'INSTALL 安装组件'],
  ['uninstall', 'UNINSTALL 卸载组件'],
  ['shutdown', 'SHUTDOWN 关闭服务器'],
  ['kill', 'KILL 终止连接'],
  ['flush', 'FLUSH 刷新'],
  ['reset', 'RESET 重置'],
  ['optimize', 'OPTIMIZE TABLE'],
  ['repair', 'REPAIR TABLE'],
  ['check', 'CHECK TABLE'],
]);

/**
 * Read-only violations that only appear deeper in the statement.
 * @type {ReadonlyArray<{pattern: RegExp, reason: string}>}
 */
const READ_ONLY_PATTERNS = [
  { pattern: /\bfor\s+update\b/i, reason: 'SELECT ... FOR UPDATE 会加排他锁' },
  { pattern: /\block\s+in\s+share\s+mode\b/i, reason: 'SELECT ... LOCK IN SHARE MODE 会加共享锁' },
  { pattern: /\bfor\s+share\b/i, reason: 'SELECT ... FOR SHARE 会加共享锁' },
  { pattern: /\binto\s+outfile\b/i, reason: 'INTO OUTFILE 会向服务器磁盘写文件' },
  { pattern: /\binto\s+dumpfile\b/i, reason: 'INTO DUMPFILE 会向服务器磁盘写文件' },
  { pattern: /\binto\s+@/i, reason: 'INTO @变量 会写入用户变量' },
  { pattern: /\bload_file\s*\(/i, reason: 'LOAD_FILE() 会读取服务器文件' },
  { pattern: /\bload\s+data\b/i, reason: 'LOAD DATA 会导入数据' },
  { pattern: /\bbenchmark\s*\(/i, reason: 'BENCHMARK() 可被用于资源消耗攻击' },
  { pattern: /\bsleep\s*\(/i, reason: 'SLEEP() 会阻塞数据库连接' },
];

/**
 * Span kinds produced by the single-pass scanner.
 * `plain` text is code; `comment` spans are dropped; every other span is a literal or quoted
 * identifier whose delimiters are dropped but whose content is kept or blanked by the caller.
 */
const SPAN_CODE = 0;
const SPAN_STRING = 1;
const SPAN_QUOTED_ID = 2;
const SPAN_COMMENT = 3;

/**
 * Single-pass scanner for the tokens that make SQL text ambiguous: string literals, quoted
 * identifiers, line comments, and block comments. Everything else is reported as code.
 * @param {string} sql
 * @returns {Array<{kind: number, start: number, end: number}>} spans covering the whole input
 */
export function scanSpans(sql) {
  /** @type {Array<{kind: number, start: number, end: number}>} */
  const spans = [];
  const length = sql.length;
  let codeStart = 0;
  const flushCode = (end) => {
    if (end > codeStart) spans.push({ kind: SPAN_CODE, start: codeStart, end });
  };
  let i = 0;
  while (i < length) {
    const char = sql[i];
    const next = sql[i + 1];
    if (char === "'" || char === '"' || char === '`') {
      flushCode(i);
      const start = i;
      i += 1;
      while (i < length) {
        if (sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === char) {
          if (sql[i + 1] === char) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      spans.push({ kind: char === '`' ? SPAN_QUOTED_ID : SPAN_STRING, start, end: i });
      codeStart = i;
      continue;
    }
    if (char === '-' && next === '-') {
      flushCode(i);
      const start = i;
      while (i < length && sql[i] !== '\n') i += 1;
      spans.push({ kind: SPAN_COMMENT, start, end: i });
      codeStart = i;
      continue;
    }
    if (char === '#') {
      flushCode(i);
      const start = i;
      while (i < length && sql[i] !== '\n') i += 1;
      spans.push({ kind: SPAN_COMMENT, start, end: i });
      codeStart = i;
      continue;
    }
    if (char === '/' && next === '*') {
      flushCode(i);
      const start = i;
      i += 2;
      while (i < length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i = Math.min(length, i + 2);
      spans.push({ kind: SPAN_COMMENT, start, end: i });
      codeStart = i;
      continue;
    }
    i += 1;
  }
  flushCode(length);
  return spans;
}

/**
 * Rebuild the statement as code only: literals, quoted identifiers, and comments become spaces so
 * structural scans cannot be fooled by content. Every character keeps its position.
 * @param {string} sql
 * @returns {string}
 */
export function maskLiterals(sql) {
  let out = '';
  for (const span of scanSpans(sql)) {
    const text = sql.slice(span.start, span.end);
    if (span.kind === SPAN_CODE) {
      out += text;
      continue;
    }
    if (span.kind === SPAN_QUOTED_ID) {
      // Keep the identifier itself readable (still space-filled to preserve offsets) so table-name
      // discovery can see `film`; a quoted identifier can never contain a terminator.
      const inner = text.length <= 2 ? '' : text.slice(1, -1).replace(/`/g, ' ');
      out += ` ${inner} `;
      continue;
    }
    out += ' '.repeat(text.length);
  }
  return out;
}

/**
 * Split a raw statement on top-level semicolons, ignoring terminators inside literals/comments.
 * @param {string} sql
 * @returns {string[]} non-empty trimmed statements, in order
 */
export function splitStatements(sql) {
  const parts = [];
  let current = '';
  for (const span of scanSpans(sql)) {
    const text = sql.slice(span.start, span.end);
    if (span.kind !== SPAN_CODE) {
      current += span.kind === SPAN_COMMENT ? ' ' : text;
      continue;
    }
    let cursor = 0;
    let at = text.indexOf(';');
    while (at >= 0) {
      current += text.slice(cursor, at);
      if (current.trim() !== '') parts.push(current.trim());
      current = '';
      cursor = at + 1;
      at = text.indexOf(';', cursor);
    }
    current += text.slice(cursor);
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/**
 * Strip markdown code fences and surrounding prose the model may have added, collapse whitespace,
 * and drop a single trailing statement terminator.
 * @param {unknown} text
 * @returns {string}
 */
export function cleanSql(text) {
  if (typeof text !== 'string') return '';
  let out = text.trim();
  // Whole response wrapped in a fence: ```sql\n...\n```
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(out);
  if (fenced !== null && typeof fenced[1] === 'string') out = fenced[1];
  // A fence anywhere: keep the widest fenced block, otherwise drop stray fence markers.
  if (out.includes('```')) {
    const blocks = [...out.matchAll(/```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```/g)];
    if (blocks.length > 0) {
      out = blocks
        .map((match) => match[1] ?? '')
        .sort((a, b) => b.length - a.length)[0] ?? out;
    } else {
      out = out.replace(/```/g, '\n');
    }
    out = out.trim();
  }
  // Drop a leading label such as "SQL:" or "查询语句：".
  out = out.replace(/^(?:sql|query|mysql|answer|statement)\s*[:：]\s*/i, '');
  out = out.replace(/^(?:sql|查询|语句|查询语句)\s*[:：]\s*/, '');
  out = out.trim();
  // Collapse all whitespace runs into single spaces so one logical statement is one line.
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/;+\s*$/, '').trim();
  return out;
}

/**
 * MySQL executable comments (`/*!...*&#47;`, `/*!50000 ...*&#47;`) run their contents on the server,
 * so they are code, not comments. Detecting them needs the raw text: {@link maskLiterals} blanks them.
 * @param {string} sql
 * @returns {boolean}
 */
export function hasExecutableComment(sql) {
  return /\/\*!/.test(typeof sql === 'string' ? sql : '');
}

/**
 * Mask string literals, quoted identifiers, and comments so structural scans cannot be fooled by
 * content. Kept as the documented name for {@link maskLiterals}.
 */

/**
 * Advance past one balanced `(` … `)` group starting at `index`.
 * @param {string} text
 * @param {number} index
 * @returns {number} index just past the closing paren, or -1 when it never closes
 */
function skipBalanced(text, index) {
  if (text[index] !== '(') return -1;
  let depth = 0;
  for (let at = index; at < text.length; at += 1) {
    if (text[at] === '(') depth += 1;
    else if (text[at] === ')') {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return -1;
}

/**
 * Walk past a leading `WITH [RECURSIVE] cte [(...)] AS (...) [, ...]` prefix and return the text that
 * follows it. MySQL 8 lets a CTE introduce a DELETE or UPDATE, so classification must not stop at
 * `WITH`. Returns the original text when it does not look like a CTE prefix, and the empty string when
 * the CTE definition never closes (which the server would reject anyway).
 *
 * The column list is only consumed when its contents really look like identifiers; a body such as
 * `c AS (SELECT 1 UNION SELECT 2)` begins with a keyword, not an identifier, and must be treated as the
 * body — otherwise `UNION` would be mistaken for the statement the CTE introduces.
 * @param {string} masked masked statement text
 * @returns {string}
 */
function afterCtePrefix(masked) {
  const skipSpace = (at) => {
    let index = at;
    while (index < masked.length && /\s/.test(masked[index])) index += 1;
    return index;
  };
  const readWord = (at) => {
    const match = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(masked.slice(at));
    return match === null ? { word: '', end: at } : { word: match[0], end: at + match[0].length };
  };

  let index = skipSpace(0);
  const withWord = readWord(index);
  if (withWord.word.toLowerCase() !== 'with') return masked;
  index = skipSpace(withWord.end);
  const recursive = readWord(index);
  if (recursive.word.toLowerCase() === 'recursive') index = skipSpace(recursive.end);

  for (;;) {
    const name = readWord(index);
    if (name.word === '') return '';
    index = skipSpace(name.end);
    // Optional column list: the interior must be a comma-separated identifier list. Checking only that
    // a `(` follows would treat `c AS (SELECT ...)` as a list starting with `S`.
    if (masked[index] === '(') {
      const end = skipBalanced(masked, index);
      if (end < 0) return '';
      const interior = masked.slice(index + 1, end - 1);
      if (/^\s*[A-Za-z_][A-Za-z_0-9$]*(\s*,\s*[A-Za-z_][A-Za-z_0-9$]*)*\s*$/.test(interior)) {
        index = skipSpace(end);
      }
    }
    const asWord = readWord(index);
    if (asWord.word.toLowerCase() !== 'as') return '';
    index = skipSpace(asWord.end);
    const bodyEnd = skipBalanced(masked, index);
    if (bodyEnd < 0) return '';
    index = skipSpace(bodyEnd);
    if (masked[index] === ',') {
      index = skipSpace(index + 1);
      continue;
    }
    return masked.slice(index);
  }
}

/**
 * Classify the text that follows a `WITH` prefix.
 * @param {string} body
 * @returns {{ok: boolean, kind: string, reason?: string}}
 */
function classifyBody(body) {
  const keyword = /[a-zA-Z_]+/.exec(body)?.[0]?.toLowerCase() ?? '';
  if (keyword === '') return { ok: false, kind: 'unknown', reason: '无法识别语句类型' };
  // DESCRIBE/DESC are their own read statements; their argument is a table name, not a statement.
  if (keyword === 'describe' || keyword === 'desc') return { ok: true, kind: 'describe' };
  if (keyword === 'explain') {
    const rest = body.replace(/^\s*explain\b/i, '');
    // `EXPLAIN ANALYZE` actually runs the statement, so it is never treated as a read.
    if (/^\s*analyze\b/i.test(rest)) return { ok: true, kind: 'explain-analyze' };
    const cleaned = rest.replace(/^\s*(?:format\s*=\s*\w+|extended\b|partitions\b|for\s+connection\s+\d+)/i, '');
    const inner = afterCtePrefix(maskLiterals(cleaned));
    if (inner === '') return { ok: false, kind: 'unknown', reason: '无法识别被 EXPLAIN 的语句' };
    return classifyBody(inner);
  }
  if (READ_ONLY_KINDS.has(keyword)) return { ok: true, kind: keyword };
  return { ok: true, kind: WRITE_KEYWORDS.has(keyword) ? keyword : 'other' };
}

/**
 * Classify one statement by the keyword that actually executes. A `WITH` prefix is walked through so
 * `WITH x AS (...) DELETE FROM t` is classified as `delete`, not as a read.
 * @param {string} sql
 * @returns {{ok: boolean, kind: string, reason?: string}}
 */
export function classify(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') {
    return { ok: false, kind: 'empty', reason: '语句为空' };
  }
  const statements = splitStatements(sql);
  if (statements.length === 0) return { ok: false, kind: 'empty', reason: '语句为空' };
  if (statements.length > 1) {
    return { ok: false, kind: 'multiple', reason: `检测到 ${statements.length} 条语句，一次只允许执行一条` };
  }
  const body = afterCtePrefix(maskLiterals(statements[0]));
  if (body === '') return { ok: false, kind: 'unknown', reason: 'WITH 子句没有正确闭合' };
  return classifyBody(body);
}

/**
 * Enforce the deployment's safety policy against one statement.
 * @param {string} sql
 * @param {{readOnly?: boolean}} [options]
 * @returns {{ok: boolean, kind?: string, reason?: string}}
 */
export function guard(sql, options = {}) {
  const readOnly = options.readOnly !== false;
  const verdict = classify(sql);
  if (!verdict.ok) return verdict;
  if (!readOnly) return verdict;
  // Executable comments carry SQL the masker cannot see, so they are refused outright rather than
  // inspected.
  if (hasExecutableComment(sql)) {
    return {
      ok: false,
      kind: verdict.kind,
      reason: '只读模式拒绝执行：语句包含 MySQL 可执行注释（/*!...*/），其内容会真被执行',
    };
  }
  if (!READ_ONLY_KINDS.has(verdict.kind)) {
    const label = WRITE_KEYWORDS.get(verdict.kind) ?? `${verdict.kind.toUpperCase()} 语句`;
    return {
      ok: false,
      kind: verdict.kind,
      reason: `当前连接为只读模式（readOnly: true），拒绝执行 ${label}。如需写操作，请在连接配置中设置 "readOnly": false。`,
    };
  }
  const masked = maskLiterals(sql);
  for (const { pattern, reason } of READ_ONLY_PATTERNS) {
    if (pattern.test(masked)) return { ok: false, kind: verdict.kind, reason: `只读模式拒绝执行：${reason}` };
  }
  return verdict;
}

/**
 * Append `LIMIT n` when the statement is a row-returning read that has no top-level LIMIT.
 * SHOW/DESCRIBE/EXPLAIN already bound their own output and are returned unchanged.
 * @param {string} sql
 * @param {number} n
 * @returns {string}
 */
export function withRowLimit(sql, n) {
  if (!Number.isInteger(n) || n <= 0) return sql;
  const verdict = classify(sql);
  if (!verdict.ok || (verdict.kind !== 'select' && verdict.kind !== 'with')) return sql;
  const masked = maskLiterals(sql);
  if (/\blimit\b/i.test(masked)) return sql;
  if (/\bfor\s+(update|share)\b/i.test(masked)) return sql;
  return `${sql.replace(/;\s*$/, '')} LIMIT ${n}`;
}

/**
 * Table references as written, **keeping the schema qualifier**.
 *
 * `analyze().touchesTables` deliberately throws the schema away, but a teaching display must keep
 * it: `FROM jwgl.student` and `FROM student` behave completely differently, because the second one
 * resolves against the connection's default database (`DATABASE()`). A query that reads
 * `jwgl.student` while the connection is on `world` is perfectly valid — so reporting the
 * connection's default database as "the database this query used" is simply wrong.
 *
 * @param {string} sql
 * @returns {Array<{schema: string|null, table: string}>} unique, in source order
 */
export function referencedTables(sql) {
  const masked = maskLiterals(typeof sql === 'string' ? sql : '');
  const namePattern = '(?:\\s*`[^`]+`|\\s*[A-Za-z0-9_$]+)(?:\\s*\\.\\s*(?:`[^`]+`|[A-Za-z0-9_$]+))?';
  const tablePattern = new RegExp(`\\b(?:from|join|update|into|table)\\s+(${namePattern}(?:\\s*,\\s*${namePattern})*)`, 'gi');

  /** @type {Array<{schema: string|null, table: string}>} */
  const found = [];
  const seen = new Set();
  for (const match of masked.matchAll(tablePattern)) {
    for (const piece of (match[1] ?? '').split(',')) {
      const parts = piece
        .replace(/`/g, '')
        .trim()
        .split('.')
        .map((part) => part.trim())
        .filter((part) => part !== '');
      if (parts.length === 0) continue;
      const table = parts[parts.length - 1];
      const schema = parts.length >= 2 ? parts[parts.length - 2] : null;
      const key = `${(schema ?? '').toLowerCase()}.${(table ?? '').toLowerCase()}`;
      if (table === '' || table === undefined || seen.has(key)) continue;
      seen.add(key);
      found.push({ schema, table });
    }
  }
  return found;
}

/**
 * Structural risk report for presentation and for the model's own review.
 * @param {string} sql
 * @returns {{statementKind: string, touchesTables: string[], hasWhere: boolean, hasLimit: boolean, hasJoin: boolean, hasAggregate: boolean, estimatedRisk: '低' | '中' | '高'}}
 */
export function analyze(sql) {
  const verdict = classify(sql);
  // String literals and comments are blanked; quoted identifiers keep their content so backticked
  // table names are still discovered.
  const masked = maskLiterals(typeof sql === 'string' ? sql : '');
  const touchesTables = [];
  // One name is either `quoted` or bare; quoted segments may be spaced out by the masker, so
  // backticks and the spaces around them are tolerated.
  const namePattern = '(?:\\s*`[^`]+`|\\s*[A-Za-z0-9_$]+)(?:\\s*\\.\\s*(?:`[^`]+`|[A-Za-z0-9_$]+))?';
  const tablePattern = new RegExp(`\\b(?:from|join|update|into|table)\\s+(${namePattern}(?:\\s*,\\s*${namePattern})*)`, 'gi');
  for (const match of masked.matchAll(tablePattern)) {
    const raw = match[1] ?? '';
    for (const piece of raw.split(',')) {
      const name = piece.replace(/`/g, '').split('.').pop()?.trim() ?? '';
      if (name !== '' && !touchesTables.includes(name)) touchesTables.push(name);
    }
  }
  const write = !READ_ONLY_KINDS.has(verdict.kind) && verdict.kind !== 'empty' && verdict.kind !== 'unknown';
  const hasWhere = /\bwhere\b/i.test(masked);
  let estimatedRisk = '低';
  if (write) estimatedRisk = '高';
  else if (touchesTables.length === 0) estimatedRisk = '中';
  return {
    statementKind: verdict.kind,
    touchesTables,
    hasWhere,
    hasLimit: /\blimit\b/i.test(masked),
    hasJoin: /\bjoin\b/i.test(masked),
    hasAggregate: /\b(count|sum|avg|min|max|group\s+by)\b/i.test(masked),
    estimatedRisk,
  };
}
