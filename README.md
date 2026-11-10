# MySQL natural-language query plugin (dsh-mysql-nl)

A DeepSeek Harness (DSH) plugin: **connect to MySQL → read the real schema → turn a plain-language
request into accurate SQL → run it and return the rows.** You type what you want in the chat box; you
never write SQL yourself.

```
You say:  "how many cities does each country have? top 10"
It does:  read the real `world` schema -> model writes the SQL -> read-only check -> execute -> table
You get:  SELECT c.Name, COUNT(*) AS city_count
          FROM city c JOIN country k ON c.CountryCode = k.Code
          GROUP BY c.Name ORDER BY city_count DESC LIMIT 10
          (plus the 10 real rows)
```

## Contents

- [The problem it solves](#the-problem-it-solves)
- [Install](#install)
- [Configure connections](#configure-connections)
- [Plugin configuration](#plugin-configuration)
- [The three tools](#the-three-tools)
- [Examples](#examples)
- [Safety design](#safety-design)
- [How it works](#how-it-works)
- [Development and tests](#development-and-tests)

## The problem it solves

A model does not know your tables, column names, or join paths. Asked to "write a SQL query" cold, it
invents columns (`SELECT title FROM movies` when the table is really `film`) or drops join conditions.

This plugin reads the **real** schema first and feeds it to the model, so the statement it produces
actually runs:

1. **Grounded in the real schema** — tables, column names, types, nullability, primary keys,
   auto-increment, comments, indexes, and foreign keys, straight from `INFORMATION_SCHEMA`.
2. **Loaded on demand** — a small database fits in one prompt; a large one first asks the model to pick
   tables from a name-and-comment index, then loads full column detail for just those.
3. **Self-repairing** — when a statement fails, the failing SQL and the server's own error go back to the
   model once for a rewrite.
4. **Guarded** — read-only by default, single statement only, timeouts, row caps, truncated output.

## Install

The plugin is a standard DSH bundle; install it with `plugin_manager` (needs `danger-full-access` or
per-call approval):

```
plugin_manager(action: "install_bundle",
               target: "C:\\Users\\rockc\\Documents\\deepseek-harness\\default-workspace\\dsh-mysql-nl")
```

That adds `"dsh-mysql-nl": "link:<plugin dir>"` to the profile manifest, selects the bundle,
inserts the `mysql-nl` row from `cordis.patch.yml` (entry `lib/index.js`), and activates it through HMR.

> **Note:** if this package was already loaded once and failed to load, the host caches that **failed
> module record**. Toggling the plugin does not re-import changed code — a Harness restart (or a fresh
> module URL) is required to load a new JavaScript generation.

Verify with:

```
cordis_inspect_query(platform: "host", provider: "Config", method: "listConfigs",
                     input: { name: "dsh-mysql-nl" })
```

`fiberPhase: "active"` means it loaded (this query needs no approval).

## Configure connections

Connections live in a `.dsh-mysql.json` in your **workspace**. The plugin walks up from the current
working directory looking for `.dsh-mysql.json`, `dsh-mysql.json`, then `.dsh-mysql/connections.json`,
and finally checks the home directory and `~/.dsh`.

```json
{
  "version": 1,
  "default": "local",
  "connections": [
    {
      "id": "local",
      "label": "Local MySQL",
      "host": "127.0.0.1",
      "port": 3306,
      "user": "root",
      "password": "root",
      "database": "world",
      "readOnly": true,
      "maxRows": 200,
      "maxQueryMs": 15000,
      "charset": "utf8mb4"
    },
    {
      "id": "prod-report",
      "label": "Production read-only account",
      "host": "10.0.0.12",
      "port": 3306,
      "user": "report",
      "password": "${env:REPORT_DB_PASSWORD}",
      "database": "sakila",
      "readOnly": true,
      "maxRows": 100
    }
  ]
}
```

Notes:

- **Passwords may be written as `${env:NAME}`** to read from the process environment, so no secret lands
  in the file. A missing variable is a hard error — the plugin never silently connects with an empty
  password.
- `default` names the default connection; with a single connection it can be omitted. A connection may
  also set `"isDefault": true`.
- A **minimal single-connection** file works too (no `connections` array, no `id`), as does wrapping the
  whole document in `"mysql": { ... }`.
- `readOnly` defaults to **`true`**. Writing requires an explicit `"readOnly": false`.
- A typo'd key (for example `passwd` instead of `password`) is rejected with a message rather than
  silently ignored.

## Plugin configuration

Add a `config` block to the `mysql-nl` row in the profile's `cordis.patch.yml`:

```yaml
- id: mysql-nl
  name: "dsh-mysql-nl"
  config:
    connectionsFile: C:/path/to/.dsh-mysql.json
    profile: local
    readOnly: true
    maxRows: 200
    maxQueryMs: 15000
    inlineCharBudget: 60000
    maxTables: 12
    llmProvider: deepseek-account
    llmModel: deepseek-flash
```

| Field | Default | Meaning |
|---|---|---|
| `connectionsFile` | auto-discovered | Path to the connection store |
| `profile` | the file's `default` | Default connection id |
| `readOnly` | follows the connection | `true` forces read-only; `false` allows writes |
| `maxRows` | 200 | Rows returned per query (1–10000) |
| `maxQueryMs` | 15000 | Per-statement timeout in ms (100–600000) |
| `maxCellChars` | 400 | Characters kept per cell |
| `inlineCharBudget` | 60000 | Schema characters inlined in the prompt; beyond this the model picks tables first |
| `maxTables` | 12 | Maximum tables considered when generating SQL |
| `llmProvider` / `llmModel` | session default | Model used to write SQL; unset follows the current session |

Invalid configuration (unknown key, wrong type, out-of-range number) fails plugin activation instead of
silently falling back.

## The three tools

### `mysql_nl_query` — the main entry point

Pass the user's own words as `question`.

| Parameter | Required | Meaning |
|---|---|---|
| `question` | yes | The natural-language request |
| `connection` | | Connection id; defaults to the default connection |
| `database` | | Database name; defaults to the connection's database |
| `tables` | | Hint tables, skipping model table selection and improving accuracy |
| `execute` | | Defaults to `true`; `false` returns the SQL without running it |
| `max_rows` | | Per-call row cap, overriding the connection setting |
| `show_sql` | | Defaults to `true`; include the executed SQL in the reply |

Returns the generated SQL, statement kind, risk level, tables touched, row count, elapsed time,
truncation flag, a markdown table, and a short `reply` written for the user.

### `mysql_schema` — see the real structure

Parameters: `connection`, `database`, `tables` (optional; restrict to these tables).

Returns compact schema text (tables, columns, types, keys, auto-increment, comments, indexes, foreign
keys) suitable for reading directly or putting in context. Use it whenever you are unsure what a column
is actually called.

### `mysql_list_connections` — see the configured targets

Parameter: `ping` (defaults to `false`; `true` probes reachability and adds the server version and the
list of accessible databases).

Returns the connection list (**never a password**) plus the resolved connection-file path.

## Examples

Type these in the chat box:

- "Top 5 most populous countries in the world database"
- "How many films are in each category in sakila?"
- "Which customers rented the widest variety of films? Top 20"
- "Total order amount per day for last month"

Generate without executing:

> "Write the query but don't run it: count cities per country" → the model passes `execute: false`.

Pick a database and connection:

> "In the `company` database (use the `prod-report` connection), find the 3 departments with the most
> employees"

## Safety design

| Mechanism | Behaviour |
|---|---|
| Read-only by default | A connection's `readOnly` defaults to `true`; write statements are refused before execution with a clear reason |
| Dangerous syntax | In read-only mode: `FOR UPDATE`, `LOCK IN SHARE MODE`, `INTO OUTFILE/DUMPFILE`, `LOAD_FILE()`, `LOAD DATA`, `BENCHMARK()`, `SLEEP()` are refused |
| Single statement | Exactly one statement per call; `SELECT 1; DROP TABLE t` is rejected |
| Literal-aware | Classification blanks string literals and comments, so `SELECT 'delete from x'` is not mistaken for a write |
| Timeouts | `maxQueryMs` (default 15s) via a `MAX_EXECUTION_TIME` hint plus a hard connection destroy |
| Row and cell caps | Rows are capped at `maxRows` and truncation is reported; oversized cells are shortened |
| Grounding | Only table and column names that really exist are used |

> The plugin's own checks prevent accidents; they are not an authorization boundary. The real boundary is
> **database privileges** — grant the query account `SELECT` only.

## How it works

```
user question
   │
   ├─ 1. load config, resolve the connection (config.js)
   ├─ 2. read INFORMATION_SCHEMA: databases/tables/columns/indexes/FKs (catalog.js)
   │     small database -> whole schema in the prompt
   │     large database -> model picks tables from a name+comment index, then full detail
   ├─ 3. build the prompt (real schema + rules) and call the model (nl.js -> ctx.llm.stream)
   ├─ 4. clean the SQL (strip fences) and run safety checks (sql.js)
   ├─ 5. execute; on failure, hand the error back to the model once (client.js + nl.js)
   └─ 6. render the markdown table and summary (format.js)
```

| File | Responsibility |
|---|---|
| `lib/index.js` | Package entry, re-exports the Cordis plugin |
| `lib/plugin-mysql.js` | Cordis plugin: registers the three tools, resolves config, calls `ctx.llm` |
| `lib/config-schema.js` | Config validation (Standard Schema + JSON Schema projection) |
| `lib/core/config.js` | Connection file discovery, `${env:...}` substitution, default resolution |
| `lib/core/client.js` | mysql2 pool, single-statement execution, timeouts, value normalization |
| `lib/core/catalog.js` | `INFORMATION_SCHEMA` reads and compact schema rendering |
| `lib/core/sql.js` | SQL cleaning, classification, read-only guard, `LIMIT` fallback, analysis |
| `lib/core/nl.js` | Two-stage grounding: table selection -> generation -> repair |
| `lib/core/format.js` | Result tables, summaries, connection rendering |

**The plugin imports no `@deepseek-ai/*` package** — only `mysql2`. Tools are registered as raw
definitions through Cordis `ctx.tools.register`, and the model route comes from the host's
`agentDefaultModel` / `llm` services.

## Development and tests

```powershell
# dependencies
pnpm install --node-linker=hoisted      # or npm install (a flat node_modules is required)

# full suite (--test-isolation=none is required: plain --test spawns a piped child per file)
node --test-isolation=none --test "test/*.test.mjs"
```

The tests need a local MySQL. Point them elsewhere with environment variables (defaults are
`127.0.0.1:3306`, `root/root`, database `world`):

```
DSH_TEST_MYSQL_HOST / DSH_TEST_MYSQL_PORT / DSH_TEST_MYSQL_USER
DSH_TEST_MYSQL_PASSWORD / DSH_TEST_MYSQL_DATABASE
```

| File | Coverage |
|---|---|
| `test/sql.test.mjs` | Cleaning, classification, read-only guard, LIMIT, analysis (including adversarial cases: semicolons in comments, `FOR UPDATE` inside a literal) |
| `test/format.test.mjs` | Table rendering, escaping and truncation, summaries, no password leakage |
| `test/config.test.mjs` | Connection discovery, `${env:}`, every accepted shape and its failures |
| `test/client.test.mjs` / `test/catalog.test.mjs` | **Live MySQL**: pooling, timeouts, value normalization, databases/tables/columns/indexes/FKs, schema text |
| `test/nl.test.mjs` | Two-stage generation, prompt contents, repair path, failure branches (injected model) |
| `test/e2e.test.mjs` | **Live MySQL end to end**: config -> schema -> generation -> execution -> table |
| `test/plugin-integration.test.mjs` | **Live MySQL + scripted `llm.stream`**: the whole tool path and returned shape |
| `test/plugin.test.mjs` | Tool registration, definition shapes, config validation |
| `test/contract.test.mjs` | Validates parameter/output schemas with **the host's own schema compiler** (below) |

`test/_vendor/dsh-json-schema.mjs` is the enforced JSON Schema subset extracted from the installed DSH
(`_vendor/build-oracle.mjs` performs the extraction). It catches tool-schema shape mistakes during
testing — and that check earns its keep: this plugin's first two live installs failed precisely because
`parameters` (an author property map) and `output.schema` (raw JSON Schema) were confused for each other.
