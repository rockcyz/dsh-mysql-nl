# dsh-mysql-nl — frozen module contract

**This file is the single source of truth for module interfaces. Owners must not change a signature
without telling the Lead.** All runtime code is ESM (`.js`, `"type": "module"`), plain JavaScript with
JSDoc types — no TypeScript build, no transpile step.

The plugin runs **in-process inside the DSH host**, loaded from the user profile's `node_modules`.
Runtime is Node 24 (bundled Electron/DSH runtime). There is **no SDK import** anywhere: the plugin
registers tools through the plain Cordis `ctx.tools.register()` API and returns plain objects.
This keeps the plugin dependency-free apart from `mysql2`.

## The two schema forms (read this before touching `plugin-mysql.js`)

`ctx.tools.register` stores the definition **verbatim** — `ToolRuntime.register()` asserts only
`output.schema` and never compiles `parameters`. Both schema fields are therefore **raw JSON Schema**,
and `parameters` must have an object root:

```js
ctx.tools.register({
  name, description,
  // Raw JSON Schema, forwarded to the model untouched. Object root is mandatory: the model API
  // rejects a function whose parameters node has no `type` with HTTP 400
  // "schema must be a JSON Schema of 'type: \"object\"', got 'type: null'".
  parameters: {
    type: 'object',
    properties: { question: { type: 'string', description: '…' } },
    required: ['question'],                     // array of property names; omit when nothing is required
  },
  output: {
    // Also raw JSON Schema, asserted directly by register(): assertSupportedJsonSchema(output.schema).
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['a', 'b'],                       // array of property names
      properties: { a: { type: 'string' }, b: { type: 'integer' } },
    },
    render: (args, value) => [{ type: 'text', text: String(value.a) }],
  },
  async execute(args, exec) { /* … */ },
});
```

The **author property map** — `parameters: { question: { type: 'string', required: true } }` with
per-property `required`, which the host compiles through `parameterSchemaSpecToJsonSchema` — is only
valid as `defineTool({ … })`'s input. `defineTool` (from `@deepseek-ai/dsh-tools`) is the single host
call site that compiles it. This plugin imports no host package, so it hand-writes the compiled raw
form; the first two live installs broke precisely because `register()` was handed the author map and
the model received a `parameters` node without `type`.

Rules that follow from the host's enforced subset:

- Scalar types are `string | number | integer | boolean | null | array | object | json`; use `integer`
  (not `number`) for counts and timings in `output.schema`.
- `required` is an array of property names in both fields; a property node must never carry
  `required: true` in a registered definition.
- Every object node in `output.schema` needs an explicit `additionalProperties` boolean; parameter
  schemas stay open (no `additionalProperties`), matching what the host compiler emits.
- `defineTool` from `@deepseek-ai/dsh-tools` is unavailable to this plugin by design, and it would in
  any case only be needed for the author form.
- Every registration goes through the local `registerTool` wrapper, which calls
  `assertObjectRootedParameters` first. A definition whose `parameters` root is not an object schema
  makes the host reject **every** model request with HTTP 400, and the model never answers — so no
  in-session diagnostic can run. Failing at plugin load keeps the session usable; registering the tool
  does not.
- Editing `lib/**` does **not** reach a running DSH process: the Cordis loader imports plugin modules
  with `await import(new URL(name, baseUrl).href)` (no cache-busting query) and Node caches ESM modules
  per process. Restart the app (or make the entry URL change) before expecting a code change to apply.

`test/contract.test.mjs` pins the registered forms and `oracle.validateJsonSchemaValue` against the
host's real subset validator (`test/_vendor/dsh-json-schema.mjs`), and `verify.mjs` in the workspace
root re-checks them end to end.

## Layout

```
dsh-mysql-nl/
  package.json                     # name dsh-mysql-nl, exports "./mysql" -> ./lib/plugin-mysql.js
  cordis.patch.yml                 # profile patch rows
  lib/plugin-mysql.js              # Cordis entry: name/inject/Config/apply  (owner: Lead)
  lib/core/config.js               # connection store loading + resolution (owner: teammate B)
  lib/core/client.js               # mysql2 pool registry + query execution (owner: teammate A)
  lib/core/catalog.js              # INFORMATION_SCHEMA introspection + compact schema text (owner: teammate A)
  lib/core/sql.js                  # SQL cleaning / read-only guard / LIMIT (owner: Lead)
  lib/core/explain.js              # deterministic clause-by-clause SQL explanation (owner: Lead)
  lib/core/nl.js                   # LLM table selection + SQL generation (owner: Lead)
  lib/core/format.js               # compact markdown result rendering (owner: Lead)
  lib/core/index.js                # facade re-exporting the above (owner: Lead)
  bin/mysql-nl.mjs                 # standalone CLI over lib/core (host-free; the Agent Skill's hands)
  skill/SKILL.md                   # the Agent Skill manifest, copied to the bundle root by scripts/
  scripts/build-skill.mjs          # syncs lib/core into .agents/skills/mysql-nl and packs it
  test/*.test.mjs                  # node:test, must pass with the bundled node
```

`lib/core/**` must stay free of any host API (`ctx`, `@deepseek-ai/*`): it is shared verbatim by the
DSH plugin, the CLI, and the Agent Skill bundle. `bin/`, `skill/` and `scripts/` are consumer-facing
additions and are **not** loaded by the Cordis entry point.

## The two consumers of the core

| Consumer | Entry | Has a model? | Where the SQL comes from |
|---|---|---|---|
| DSH plugin | `lib/plugin-mysql.js` | yes (`ctx.get('llm')`) | the plugin's own two-stage generation (`nl.js`) |
| CLI / Agent Skill | `bin/mysql-nl.mjs` | no | the **calling agent** writes the SQL; the CLI only grounds it in real schema and executes it safely |

Both must produce the same student-facing output — steps, SQL, clause-by-clause explanation, result —
so the explanation lives in `explain.js` (deterministic, offline) rather than in a prompt. The DSH
prompt deliberately forbids the model from emitting prose (see `nl.js` rule 4) so that `cleanSql`
stays robust; asking the model for an explanation would reintroduce the parsing fragility that rule
exists to prevent.

## Cross-module types (JSDoc, frozen)

```js
/** @typedef {object} ConnectionOptions
 *  @property {string}  id           stable key, e.g. "local"
 *  @property {string}  [label]
 *  @property {string}  host         default "127.0.0.1"
 *  @property {number}  port         default 3306
 *  @property {string}  user
 *  @property {string}  [password]
 *  @property {string}  [database]   default database when the caller omits one
 *  @property {boolean} [ssl]
 *  @property {boolean} [readOnly]   default true
 *  @property {number}  [maxRows]    default 200
 *  @property {number}  [maxQueryMs] default 15000
 *  @property {string}  [charset]    default "utf8mb4"
 *  @property {boolean} [isDefault]  at most one connection sets this
 *  @property {string}  [sourcePath] absolute path of the file this came from (diagnostics)
 */

/** @typedef {object} ResolvedConfig
 *  @property {ConnectionOptions[]} connections  never empty on success
 *  @property {string}              [defaultId]
 *  @property {string}              path          absolute path that was loaded
 */

/** @typedef {object} ColumnInfo
 *  @property {string}  name
 *  @property {string}  type          full COLUMN_TYPE, e.g. "varchar(45)"
 *  @property {boolean} nullable
 *  @property {boolean} isPrimaryKey
 *  @property {string}  [comment]
 *  @property {string}  [default]     raw COLUMN_DEFAULT (string) when present
 *  @property {boolean} [autoIncrement]
 */

/** @typedef {object} IndexInfo
 *  @property {string}   name
 *  @property {boolean}  unique
 *  @property {string[]} columns
 */

/** @typedef {object} ForeignKeyInfo
 *  @property {string} name
 *  @property {string[]} columns
 *  @property {string} referencedTable
 *  @property {string[]} referencedColumns
 */

/** @typedef {object} TableInfo
 *  @property {string}  name
 *  @property {string}  [comment]
 *  @property {number}  [rowEstimate]
 *  @property {ColumnInfo[]}      columns      MAY be empty for catalog-only results
 *  @property {IndexInfo[]}       indexes      MAY be empty
 *  @property {ForeignKeyInfo[]}  foreignKeys  MAY be empty
 */

/** @typedef {object} Catalog
 *  @property {string}      database
 *  @property {TableInfo[]} tables
 *  @property {boolean}     detailed   true when columns/indexes were loaded
 */

/** @typedef {object} QueryResult
 *  @property {string}   database
 *  @property {string}   sql          the exact statement that ran
 *  @property {unknown[]} columns     normalized column names (empty for non-row results)
 *  @property {unknown[][]} rows      row-major values, already truncated
 *  @property {number}   rowCount     rows returned after truncation
 *  @property {boolean}  truncated
 *  @property {number}   elapsedMs
 *  @property {string}   [warning]    e.g. LIMIT was applied automatically
 */
```

## Module contracts

### `lib/core/config.js`

```js
/** Candidate paths searched, in order, when no explicit file is configured. */
export const CONNECTION_FILE_NAMES;
/** @returns {Promise<string|null>} first existing candidate, else null */
export async function findConnectionsFile({ cwd, explicit } = {});
/** Load + validate + normalize. Throws Error with a Chinese-friendly message on bad JSON/shape.
 *  ${env:NAME} inside any string value is substituted from process.env (missing -> throws).
 *  @returns {Promise<ResolvedConfig>} */
export async function loadConnections({ cwd, explicit } = {});
/** @returns {ConnectionOptions} throws when id is unknown; default resolution order:
 *   explicit id -> file's default/defaultId -> the single connection -> throw with the known ids. */
export function resolveConnection(config, id);
```

File shape accepted (all of `connections` or a bare array):

```json
{ "version": 1, "default": "local",
  "connections": [ { "id": "local", "host": "127.0.0.1", "port": 3306, "user": "root",
                     "password": "${env:MYSQL_PWD}", "database": "sakila", "readOnly": true } ] }
```

### `lib/core/client.js`

```js
/** Lazily created pools, keyed by a stable fingerprint of the options. */
/** @returns {import('mysql2/promise').Pool} */
export function getPool(conn);
/** Close and forget every pool (plugin unload). Idempotent. */
export async function disposeAll();
/** Host/port/user/database snapshot for diagnostics, never including the password. */
export function describeTarget(conn);
/** Run one statement. `sql` is already final (no placeholders). Enforces conn.maxQueryMs with
 *  a MySQL `MAX_EXECUTION_TIME` optimizer hint for SELECTs, a socket timeout, and a hard timer that
 *  destroys the connection. Normalizes bigint/decimal/Buffer/Date values to JSON-safe scalars:
 *  bigint -> string, Buffer -> "<N bytes>" or hex for short binary, Date -> "YYYY-MM-DD HH:mm:ss".
 *  Applies rowLimit + maxCellChars truncation and reports `truncated`.
 *  @returns {Promise<QueryResult>} `columns` may be empty for statements with no result set. */
export async function runQuery(conn, database, sql, { rowLimit, maxCellChars, signal } = {});
/** Cheap liveness probe: SELECT VERSION(). @returns {Promise<{version:string,user:string}>} */
export async function ping(conn);
```

### `lib/core/catalog.js`

```js
/** @returns {Promise<string[]>} non-system schemas, sorted. */
export async function listDatabases(conn);
/** Catalog-only pass: every table with rowEstimate + comment, `columns`/`indexes`/`foreignKeys` empty.
 *  @returns {Promise<Catalog>} */
export async function loadCatalog(conn, database);
/** Full detail pass. `tableNames` undefined -> every table in the database.
 *  @returns {Promise<Catalog>} with `detailed: true`. */
export async function loadTableDetails(conn, database, tableNames);
/** Compact, token-efficient schema text for an LLM prompt. Sections:
 *  `## DATABASE <name>`, `### <table> (≈<rows> rows) -- <comment>`,
 *  one line per column `- name type[!NOT NULL][PK][AI][UNIQUE?] #comment` (aligned, not padded),
 *  then `FK: a.b -> c.d`, then `IDX: name(cols)`. Never emits SQL the model could mistake for
 *  the answer; plain text only, no markdown tables. @returns {string} */
export function renderSchema(catalog, { maxChars } = {});
/** Heuristic lexical pre-filter kept for large databases: score tables against a natural-language
 *  question using table name, table comment, column names, and Chinese character bigrams.
 *  @returns {string[]} table names, best first, length <= limit (never empty when tables exist) */
export function pickRelevantTables(catalog, question, limit);
```

### `lib/core/sql.js`

```js
/** Strip markdown fences/prose, collapse whitespace, drop one trailing ";". @returns {string} */
export function cleanSql(text);
/** True when the statement may run under the current policy. Mutates nothing.
 *  Classifies the leading keyword; an empty statement -> {ok:false}. Multi-statement input
 *  (a `;` that separates two non-empty statements) -> {ok:false}.
 *  @returns {{ok:boolean, kind:string, reason?:string}} kind ∈ select|with|show|describe|explain|other */
export function classify(sql);
/** @returns {{ok:boolean, reason?:string, kind?:string}} readOnly=true rejects everything but
 *  select/with/show/describe/explain, and rejects SELECT ... FOR UPDATE / LOCK IN SHARE MODE /
 *  INTO OUTFILE / INTO DUMPFILE / `information_schema`? (allowed) / load_file(). */
export function guard(sql, { readOnly });
/** Append `LIMIT n` when the statement is a select without a top-level LIMIT. @returns {string} */
export function withRowLimit(sql, n);
/** Structural risk report for the UI: {statementKind, touchesTables:string[], hasWhere, hasLimit}. */
export function analyze(sql);
/** Table references **with the schema qualifier kept** (`analyze` drops it): source order, deduped.
 *  `{schema: null}` means the reference is unqualified and therefore resolves against the
 *  connection's `DATABASE()`. Display code needs this to avoid reporting the connection's default
 *  database as the schema a query read.
 *  @returns {Array<{schema: string|null, table: string}>} */
export function referencedTables(sql);
```

### `lib/core/nl.js`

```js
/** @typedef {(options: {provider:string, model:string, system:string, prompt:string,
 *   maxTokens?:number, signal?:AbortSignal}) => Promise<string>} LlmFn */

/** Pick the tables needed to answer `question` when the catalog is too large to inline verbatim.
 *  `llm` returns JSON `{"tables":["a","b"]}`; parsing is tolerant (fences, prose, arrays).
 *  @returns {Promise<{tables:string[], reason:string, strategy:'heuristic'|'llm'}>} */
export async function selectTables({ catalog, question, llm, provider, model, maxTables, signal, inlineCharBudget });

/** Generate one MySQL statement. Two-stage by design: compact catalog pass first, then full column
 *  detail for the selected tables only. Throws Error('EMPTY_SQL') when the model returns nothing.
 *  @returns {Promise<{sql:string, tables:string[], rationale:string, stage:string,
 *    selection:{strategy:string, tables:string[]}}>} */
export async function generateSql({ conn, loader, database, question, hintTables, llm, provider, model, signal, inlineCharBudget, maxTables });
```

### `lib/core/explain.js`

```js
/** Deterministic, no-LLM clause-by-clause explanation. Never throws; degrades to whatever clauses
 *  it recognised. Clause text is sliced out of the ORIGINAL sql using offsets found in
 *  `maskLiterals(sql)`, so literals and backticked identifiers are preserved verbatim while
 *  keywords inside them are correctly ignored. Only depth-0 keywords are treated as clauses, which
 *  is what keeps a subquery's FROM out of the outer clause list.
 *  @returns {{
 *    kind: 'select'|'with'|'other',
 *    clauses: Array<{key: string, label: string, text: string, note: string}>,
 *    joins: Array<{table: string, alias?: string, on?: string}>,
 *    aggregates: string[],
 *    distinct: boolean,
 *    hasSubquery: boolean,
 *    hints: string[],
 *  }} */
export function explainSql(sql);
```

`hints` carries the beginner-mistake warnings (`SELECT *`, a JOIN with no `ON`, an aggregate in
`WHERE`, `ORDER BY` with no `LIMIT`, subqueries, `DISTINCT`). The Agent Skill contract requires the
calling agent to relay them to the student.

### `lib/core/format.js`

```js
/** Render a QueryResult as a compact markdown table for a tool result, at most `maxRows` rows.
 *  Escapes pipes/newlines; right-aligns nothing; adds "... (N more rows)" when truncated.
 *  @returns {string} */
export function renderResultTable(result, { maxRows } = {});
/** One-line human summary: `12 rows in 8ms from sakila.film`. @returns {string} */
export function summarizeResult(result);
/** Render the resolved connection for a listing, never the password. @returns {string} */
export function renderConnection(conn, { isDefault } = {});
/** Numbered "what actually happened" trace: target + policy, tables (with their schema), any LIMIT
 *  we appended, the injected timeout, then the outcome. `failure` replaces the last step with
 *  执行失败. `tables` accepts plain names or `{schema, table}` refs from `referencedTables`.
 *  @returns {string} begins with `### 执行步骤` */
export function renderQuerySteps(input);
/** Clause list + aggregates + join relations + teaching hints, from `explainSql`.
 *  @returns {string} begins with `### 语句讲解` */
export function renderExplanation(explanation);
```

`renderQuerySteps` deliberately emits **no** row-cap step when the statement already carried its own
`LIMIT`: the SQL block shows that limit, and quoting `maxRows` would claim a cap the query never
uses. Pass `failure` to end the trace where execution actually stopped.

**The connection target never includes a database.** `input.database` is the connection's default
schema (`DATABASE()`), not the schema a statement reads: `FROM jwgl.student` on a connection parked
on `world` is valid. Reporting `host:port/world` there told students the query ran on `world`.
Qualified references are shown as `jwgl.student`; unqualified ones are shown bare and the note
「未写库名，按连接默认库 `world` 解析」is appended, because that is the only case where the default
actually decides what gets read.
