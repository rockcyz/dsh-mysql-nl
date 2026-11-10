/**
 * DeepSeek Harness plugin: MySQL natural-language query.
 *
 * Registers three model-facing tools that together let the user type a plain-language question in
 * the chat box and get real rows back:
 *   - `mysql_list_connections` — which MySQL targets are configured
 *   - `mysql_schema`           — the real table/column structure of one database
 *   - `mysql_nl_query`         — natural language in, schema-grounded SQL out, executed, rendered
 *
 * The plugin is deliberately free of any `@deepseek-ai/*` import: it registers plain tool
 * definitions through `ctx.tools.register` and reads the model route from the host's own services.
 * @module dsh-mysql-nl
 */

import { loadConnections, resolveConnection } from './core/config.js';
import { disposeAll, runQuery, ping } from './core/client.js';
import { listDatabases, loadCatalog, loadTableDetails, renderSchema, pickRelevantTables } from './core/catalog.js';
import { analyze, guard, referencedTables, withRowLimit } from './core/sql.js';
import { explainSql } from './core/explain.js';
import { generateSql } from './core/nl.js';
import {
  renderConnection,
  renderExplanation,
  renderQuerySteps,
  renderResultTable,
  summarizeResult,
} from './core/format.js';

export const name = 'dsh-mysql-nl';

/** Host services this plugin needs. `llm` and `agentDefaultModel` are resolved optionally at call time. */
export const inject = ['tools'];

export { Config } from './config-schema.js';

/** Default cap on rows returned by one query. */
const DEFAULT_MAX_ROWS = 200;
/** Default per-statement timeout. */
const DEFAULT_MAX_QUERY_MS = 15000;
/** Default per-cell character cap. */
const DEFAULT_MAX_CELL_CHARS = 400;

/**
 * Coerce a caller-supplied number to a usable positive integer. Models sometimes emit a float, so a
 * fractional value is floored rather than silently ignored.
 * @param {unknown} value
 * @returns {number|undefined}
 */
function positiveInt(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
    return undefined;
  }
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : undefined;
}

/**
 * Build the runtime settings from plugin config, defaulting everything.
 * @param {Record<string, unknown>} config
 */
function settingsOf(config) {
  return {
    connectionsFile: typeof config.connectionsFile === 'string' && config.connectionsFile !== '' ? config.connectionsFile : undefined,
    profile: typeof config.profile === 'string' && config.profile !== '' ? config.profile : undefined,
    /** undefined follows the connection; true forces read-only; false explicitly allows writes. */
    forceReadOnly: config.readOnly === true ? true : config.readOnly === false ? false : undefined,
    maxRows: positiveInt(config.maxRows) ?? DEFAULT_MAX_ROWS,
    maxQueryMs: positiveInt(config.maxQueryMs) ?? DEFAULT_MAX_QUERY_MS,
    maxCellChars: positiveInt(config.maxCellChars) ?? DEFAULT_MAX_CELL_CHARS,
    inlineCharBudget: positiveInt(config.inlineCharBudget) ?? 60000,
    maxTables: positiveInt(config.maxTables) ?? 12,
    llmProvider: typeof config.llmProvider === 'string' && config.llmProvider !== '' ? config.llmProvider : undefined,
    llmModel: typeof config.llmModel === 'string' && config.llmModel !== '' ? config.llmModel : undefined,
  };
}

/**
 * Replace an in-process `ctx.llm.stream` with a plain promise of the assistant text.
 * @param {any} ctx
 * @returns {(options: {provider: string, model: string, system: string, prompt: string, maxTokens?: number, signal?: AbortSignal}) => Promise<string>}
 */
function makeLlm(ctx) {
  return async (options) => {
    const llm = ctx.get('llm');
    if (llm === undefined) throw new Error('宿主没有可用的 llm 服务，无法调用模型生成 SQL');
    if (typeof llm.stream !== 'function') throw new Error('llm 服务不支持 stream()，无法生成 SQL');
    const stream = llm.stream({
      provider: options.provider,
      model: options.model,
      system: options.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: options.prompt }] }],
      maxTokens: options.maxTokens,
      temperature: 0,
      signal: options.signal,
    });
    let text = '';
    let failure;
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') text += chunk.text ?? '';
      else if (chunk?.type === 'finish' && chunk.reason?.kind !== 'stop' && chunk.reason?.kind !== 'tool-calls') {
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') failure = chunk.reason.failure;
      }
    }
    if (failure !== undefined) {
      throw new Error(`模型调用失败：${failure.message ?? '未知错误'}（${failure.code ?? 'unknown'}）`);
    }
    if (text.trim() === '') throw new Error('模型没有返回任何内容');
    return text;
  };
}

/**
 * Resolve the provider/model route used for SQL generation: explicit config first, then the host's
 * current default model selection.
 * @param {any} ctx
 * @param {{llmProvider?: string, llmModel?: string}} settings
 * @returns {{provider: string, model: string, source: string}}
 */
function resolveModelRoute(ctx, settings) {
  const fallback = () => {
    const service = ctx.get('agentDefaultModel');
    const selection = typeof service?.currentSelection === 'function' ? service.currentSelection() : undefined;
    if (selection?.provider && selection?.model) {
      return { provider: selection.provider, model: selection.model, source: 'agentDefaultModel' };
    }
    return undefined;
  };
  if (settings.llmProvider !== undefined && settings.llmModel !== undefined) {
    return { provider: settings.llmProvider, model: settings.llmModel, source: 'plugin-config' };
  }
  const resolved = fallback();
  if (resolved === undefined) {
    throw new Error('无法确定用于生成 SQL 的模型：请在插件配置中设置 llmProvider 与 llmModel');
  }
  return {
    provider: settings.llmProvider ?? resolved.provider,
    model: settings.llmModel ?? resolved.model,
    source: resolved.source,
  };
}

/**
 * Load and resolve the connection a tool call targets.
 * @param {{cwd?: string}} runtime
 * @param {ReturnType<typeof settingsOf>} settings
 * @param {string|undefined} requestedId
 * @param {{requireConnection?: boolean}} [options]
 */
async function openTarget(runtime, settings, requestedId, options = {}) {
  try {
    const config = await loadConnections({ cwd: runtime.cwd, explicit: settings.connectionsFile });
    const conn = resolveConnection(config, requestedId ?? settings.profile);
    return { conn, config };
  } catch (error) {
    if (options.requireConnection === false) return { conn: undefined, config: undefined, error };
    throw error;
  }
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Best human label for "which database did this query read".
 *
 * Prefer the schemas the statement actually names; fall back to the connection's default database
 * only when every reference is unqualified, because that is the one case where the default
 * determines the answer. Reporting `DATABASE()` unconditionally would tell a student that a
 * `jwgl.student` query ran on `world`.
 *
 * @param {string} defaultDatabase
 * @param {Array<{schema: string|null, table: string}>} refs
 * @returns {string}
 */
function databaseLabelOf(defaultDatabase, refs) {
  const schemas = [...new Set(refs.map((ref) => ref.schema).filter((schema) => schema !== null && schema !== ''))];
  if (schemas.length === 0) return defaultDatabase;
  return schemas.join(' / ');
}

/**
 * Assert that a tool's `parameters` is raw, object-rooted JSON Schema.
 *
 * `ctx.tools.register` forwards `parameters` to the model verbatim, so a definition whose root is not
 * an object schema poisons **every** request with HTTP 400
 * (`schema must be a JSON Schema of 'type: "object"', got 'type: null'`). That failure is unfixable
 * from inside a session: the model never answers, so no tool call — not even a diagnostic one — can
 * run. Refusing to load costs the user the tool; a poisoned request costs the user the session.
 * @param {Record<string, unknown>} definition
 * @returns {Record<string, unknown>} the same definition, when it is safe to register
 */
export function assertObjectRootedParameters(definition) {
  const parameters = definition.parameters;
  const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(parameters) || parameters.type !== 'object' || !isRecord(parameters.properties)) {
    throw new Error(
      `工具 ${String(definition.name)} 的 parameters 必须是 object 根的原始 JSON Schema` +
      '（{ type: "object", properties: { … } }）：ctx.tools.register 会把它原样发给模型，' +
      '根节点缺少 type 会让每一次模型请求都返回 400 INVALID_REQUEST。' +
      '作者属性表（每条属性带 required: true）只适用于宿主内部的 defineTool，不能交给 register。',
    );
  }
  return definition;
}

/** Register one model-facing tool after checking the schema shape the registry will forward. */
function registerTool(ctx, definition) {
  return ctx.tools.register(assertObjectRootedParameters(definition));
}

/**
 * Plugin entry point.
 * @param {any} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config = {}) {
  const settings = settingsOf(config);
  const llm = makeLlm(ctx);

  const textOutput = (text) => [{ type: 'text', text }];

  // Every registration below is owned by this fiber, so an unload disposes them in order.
  ctx.effect(() => () => {
    void disposeAll().catch(() => {});
  });

  // ---------------------------------------------------------------- list connections
  registerTool(ctx, {
    name: 'mysql_list_connections',
    description:
      '列出本机配置好的 MySQL 连接（id、账号、主机、默认库、是否只读），并可探测连通性与服务器版本。' +
      '在用户没有说明要用哪个数据库、或需要确认连接是否可用时先调用它。永远不会返回密码明文。',
    // `ctx.tools.register` forwards `parameters` verbatim (only `output.schema` is asserted), so it
    // must already be raw, object-rooted JSON Schema — never an author property map. An author map
    // reaches the model as a schema without `type`, and the request dies with HTTP 400
    // "schema must be a JSON Schema of 'type: \"object\"', got 'type: null'".
    parameters: {
      type: 'object',
      properties: {
        ping: { type: 'boolean', description: '是否顺手探测连通性并返回 MySQL 版本，默认 false' },
      },
    },
    // `output.schema` is raw JSON Schema (the registry asserts it directly, it is not compiled);
    // `required` therefore belongs on the object node as an array.
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['profile', 'connections', 'hint'],
        properties: {
          profile: { type: 'string', description: '连接配置文件绝对路径' },
          defaultId: { type: 'string', description: '默认连接 id' },
          connections: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'host', 'port', 'user', 'readOnly', 'isDefault'],
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                host: { type: 'string' },
                port: { type: 'integer' },
                user: { type: 'string' },
                database: { type: 'string' },
                readOnly: { type: 'boolean' },
                isDefault: { type: 'boolean' },
                reachable: { type: 'boolean' },
                version: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
          databases: { type: 'array', items: { type: 'string' } },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => textOutput(value.hint),
    },
    async execute(args, exec) {
      const runtime = { cwd: cwdOf(exec) };
      let opened;
      try {
        opened = { config: await loadConnections({ cwd: runtime.cwd, explicit: settings.connectionsFile }) };
      } catch (error) {
        throw new Error(
          `没有找到可用的 MySQL 连接配置。请在 ${runtime.cwd ?? '当前工作目录'} 下创建 .dsh-mysql.json，` +
            `或在工作目录中新建连接文件。原始错误：${messageOf(error)}`,
        );
      }
      const { config: resolved } = opened;
      const entries = [];
      /** Display-only password indicators, parallel to `entries`. Kept out of `entries` because that
       *  array is the tool's structured output and its schema is `additionalProperties: false`. */
      const passwordIndicators = [];
      for (const conn of resolved.connections) {
        /** @type {Record<string, unknown>} */
        const entry = {
          id: conn.id,
          host: conn.host,
          port: conn.port,
          user: conn.user,
          readOnly: conn.readOnly !== false,
          isDefault: resolved.defaultId === conn.id,
        };
        if (conn.label !== undefined) entry.label = conn.label;
        if (conn.database !== undefined) entry.database = conn.database;
        if (args.ping === true) {
          try {
            const info = await ping(conn);
            entry.reachable = true;
            entry.version = info.version;
          } catch (error) {
            entry.reachable = false;
            entry.error = messageOf(error);
          }
        }
        entries.push(entry);
        passwordIndicators.push(conn.password);
      }
      let databases;
      if (args.ping === true && entries.some((entry) => entry.reachable === true)) {
        const first = resolved.connections.find((conn) => entries.find((entry) => entry.id === conn.id)?.reachable === true);
        if (first !== undefined) {
          try {
            databases = await listDatabases(first);
          } catch {
            databases = undefined;
          }
        }
      }
      const lines = [`连接配置文件：${resolved.path}`,
        ...entries.map((entry, index) => renderConnection(
          // `password` is passed through on purpose: `renderConnection` never prints the secret, it
          // only turns it into the "已配置/空" indicator. Omitting it made this listing claim
          // "密码 空" for connections that do have a password.
          { id: String(entry.id), user: String(entry.user), host: String(entry.host), port: Number(entry.port), database: entry.database, readOnly: entry.readOnly, password: passwordIndicators[index] },
          { isDefault: entry.isDefault === true },
        ).trimEnd()),
      ];
      if (entries.length === 0) lines.push('- （没有任何连接）');
      lines.push(
        '',
        databases === undefined
          ? '提示：调用 `mysql_nl_query` 时可用 `connection` 指定连接 id；不指定则使用默认连接。'
          : `可访问的数据库：${databases.join('、')}`,
      );
      /** @type {Record<string, unknown>} */
      const value = {
        profile: resolved.path,
        connections: entries,
        hint: lines.join('\n'),
      };
      if (resolved.defaultId !== undefined) value.defaultId = resolved.defaultId;
      if (databases !== undefined) value.databases = databases;
      return value;
    },
    presentCall: () => ({ card: 'generic', title: '列出 MySQL 连接', kind: 'other' }),
  });

  // ---------------------------------------------------------------- schema
  registerTool(ctx, {
    name: 'mysql_schema',
    description:
      '读取 MySQL 的真实数据表结构：库中所有表、每张表的字段名/类型/是否可空/主键/自增/注释、索引与外键。' +
      '在需要弄清字段含义、或在生成 SQL 前确认表结构时调用。返回内容经过压缩，适合放进上下文。',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接 id，默认使用默认连接' },
        database: { type: 'string', description: '数据库名，默认使用该连接的默认库' },
        tables: {
          type: 'array',
          items: { type: 'string' },
          description: '只看这些表；不填则返回整库结构。表多时建议传具体的表名',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['connection', 'database', 'tableCount', 'tables', 'schema'],
        properties: {
          connection: { type: 'string' },
          database: { type: 'string' },
          tableCount: { type: 'integer' },
          tables: { type: 'array', items: { type: 'string' } },
          schema: { type: 'string', description: '紧凑的表结构文本' },
        },
      },
      render: (_args, value) => textOutput(value.schema),
    },
    async execute(args, exec) {
      const runtime = { cwd: cwdOf(exec) };
      const { conn } = await openTarget(runtime, settings, args.connection);
      const database = typeof args.database === 'string' && args.database !== '' ? args.database : conn.database;
      if (database === undefined || database === '') {
        throw new Error(`连接 ${conn.id} 未指定默认数据库，请通过 database 参数指定要查看的数据库`);
      }
      const wanted = Array.isArray(args.tables) ? args.tables.filter((name) => typeof name === 'string') : undefined;
      const catalog = await loadTableDetails(conn, database, wanted);
      const text = renderSchema(catalog, { maxChars: settings.inlineCharBudget * 2 });
      return {
        connection: conn.id,
        database,
        tableCount: catalog.tables.length,
        tables: catalog.tables.map((table) => table.name),
        schema: text,
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `读取表结构${typeof args.database === 'string' ? ` — ${args.database}` : ''}`,
      kind: 'other',
      rawInput: args,
    }),
  });

  // ---------------------------------------------------------------- natural language query
  registerTool(ctx, {
    name: 'mysql_nl_query',
    description:
      '把用户用自然语言描述的查询需求，翻译成准确的 MySQL 语句并执行，返回真实数据。' +
      '插件会先读取数据库的真实表结构（表、字段、类型、主键、外键），据此让模型生成 SQL；' +
      '执行报错时会带上错误信息自动重写一次。这是回答"数据库里有什么/有多少/排名/明细"这类问题的首选工具：' +
      '把用户的原话直接放进 question。当用户询问数据库中的数据时应当主动调用它，而不是反问用户 SQL 怎么写。' +
      '返回值里的 reply 已包含**执行步骤、SQL 语句和逐子句讲解**，请把它们一并转述给用户——' +
      '这是一门数据库课的教学工具，直接给出数字而不给出 SQL 和解释是不合格的回答。',
    // Raw object root: per-property `required: true` is an author-DSL form that would be forwarded
    // to the model as an invalid schema. Requiredness lives in the root `required` array.
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '用户原话描述的查询需求，例如"查询每个国家的城市数量，按数量倒序取前10"' },
        connection: { type: 'string', description: '连接 id，默认使用默认连接' },
        database: { type: 'string', description: '数据库名，默认使用该连接的默认库' },
        tables: { type: 'array', items: { type: 'string' }, description: '提示用到的表，可跳过模型选表这一步，提高准确率' },
        execute: { type: 'boolean', description: '是否执行 SQL，默认 true；为 false 时只返回生成的 SQL' },
        max_rows: { type: 'number', description: '最多返回的行数，默认使用连接配置（200）；传值时优先于连接配置' },
        show_sql: { type: 'boolean', description: '是否在结果里显示生成并执行的 SQL，默认 true' },
      },
      required: ['question'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'connection', 'database', 'sql', 'executed', 'guard', 'statementKind', 'risk',
          'tablesUsed', 'rowCount', 'elapsedMs', 'truncated', 'resultTable', 'reply',
        ],
        properties: {
          connection: { type: 'string' },
          database: { type: 'string' },
          sql: { type: 'string' },
          executed: { type: 'boolean' },
          guard: { type: 'string' },
          statementKind: { type: 'string' },
          risk: { type: 'string' },
          tablesUsed: { type: 'array', items: { type: 'string' } },
          rowCount: { type: 'integer' },
          elapsedMs: { type: 'integer' },
          truncated: { type: 'boolean' },
          resultTable: { type: 'string' },
          reply: { type: 'string', description: '给用户看的简短结论' },
          repairError: { type: 'string' },
        },
      },
      render: (_args, value) => textOutput(value.reply),
    },
    async execute(args, exec) {
      const runtime = { cwd: cwdOf(exec) };
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      if (question === '') throw new Error('question 不能为空');
      const { conn } = await openTarget(runtime, settings, args.connection);
      const database = typeof args.database === 'string' && args.database !== '' ? args.database : conn.database;
      if (database === undefined || database === '') {
        throw new Error(`连接 ${conn.id} 未指定默认数据库，请通过 database 参数指定要查询的数据库`);
      }
      const route = resolveModelRoute(ctx, settings);
      const rowLimit = positiveInt(args.max_rows)
        ?? (conn.maxRows !== undefined ? conn.maxRows : settings.maxRows);
      const readOnly = settings.forceReadOnly !== undefined ? settings.forceReadOnly : conn.readOnly !== false;
      const executeEnabled = args.execute !== false;

      const loader = { loadCatalog, loadTableDetails };
      const common = {
        conn,
        loader,
        database,
        question,
        llm,
        provider: route.provider,
        model: route.model,
        signal: exec.signal,
        inlineCharBudget: settings.inlineCharBudget,
        maxTables: settings.maxTables,
      };
      const hintTables = Array.isArray(args.tables) ? args.tables.filter((name) => typeof name === 'string') : undefined;
      let generated = await generateSql({ ...common, hintTables });
      let verdict = guard(generated.sql, { readOnly });
      if (!verdict.ok) {
        const notRun = executeEnabled ? '' : '（本次调用没有要求执行，仍然不会把写语句交回给模型）';
        // A read-only refusal is a policy answer, not a model failure: surface it as-is.
        if (generated.sql.trim().toUpperCase().startsWith('--')) {
          throw new Error(`模型表示无法回答该问题：${generated.sql.replace(/^--\s*/, '')}`);
        }
        throw new Error(`生成的 SQL 未通过安全检查${notRun}（${verdict.reason ?? '未知原因'}）。生成的语句：${generated.sql}`);
      }

      if (!executeEnabled) {
        const analysis = analyze(generated.sql);
        // Same teaching layout as the executed path, so "只生成 SQL 让我看看" is still a lesson.
        const planned = withRowLimit(generated.sql, rowLimit);
        const reply = [
          '### SQL 语句',
          '',
          '```sql',
          planned,
          '```',
          '',
          renderExplanation(explainSql(planned)),
          `> 本次调用要求只生成、不执行（\`execute: false\`），所以没有连库跑这条语句。`,
        ].join('\n');
        return {
          connection: conn.id,
          database,
          sql: planned,
          executed: false,
          guard: '未执行（execute=false）',
          statementKind: analysis.statementKind,
          risk: analysis.estimatedRisk,
          tablesUsed: generated.tables,
          rowCount: 0,
          elapsedMs: 0,
          truncated: false,
          resultTable: '',
          reply,
        };
      }

      // `finalSql` always holds the statement that actually ran, with the LIMIT we enforced and
      // without the MAX_EXECUTION_TIME hint `runQuery` adds. The repair path below must reassign it,
      // or a successfully repaired query would display the SQL that failed.
      let finalSql = withRowLimit(generated.sql, rowLimit);
      let result;
      let repairError;
      try {
        result = await runQuery(conn, database, finalSql, {
          rowLimit,
          maxCellChars: settings.maxCellChars,
          signal: exec.signal,
        });
      } catch (error) {
        const firstError = messageOf(error);
        // One repair round: hand the failing SQL and the server's message back to the model.
        const repaired = await generateSql({
          ...common,
          hintTables: generated.tables.length > 0 ? generated.tables : hintTables,
          prior: { sql: generated.sql, error: firstError },
        });
        const repairedVerdict = guard(repaired.sql, { readOnly });
        if (!repairedVerdict.ok) {
          throw new Error(`SQL 执行失败：${firstError}；重写后的语句也未通过安全检查：${repairedVerdict.reason ?? ''}`);
        }
        const repairedSql = withRowLimit(repaired.sql, rowLimit);
        try {
          result = await runQuery(conn, database, repairedSql, {
            rowLimit,
            maxCellChars: settings.maxCellChars,
            signal: exec.signal,
          });
        } catch (secondError) {
          throw new Error(`SQL 执行失败（已自动重试一次）：${firstError}；重写后仍然失败：${messageOf(secondError)}`);
        }
        generated = repaired;
        finalSql = repairedSql;
        repairError = firstError;
        verdict = repairedVerdict;
      }

      const analysis = analyze(generated.sql);
      // Either the server gave us more rows than we keep, or the statement returned exactly the cap
      // we asked for — both mean "there may be more rows", which is what the model needs to know.
      const hitCap = Number.isFinite(rowLimit) && result.rowCount >= rowLimit;
      const truncated = result.truncated || hitCap;
      const table = renderResultTable(result, { maxRows: Math.min(rowLimit, 50) });
      // The connection's `database` is `DATABASE()`, not necessarily what the statement read: a
      // model may emit `jwgl.student` while the connection sits on `world`. Keep the qualifiers so
      // the trace reports the schema actually queried instead of the connection's default.
      const tableRefs = referencedTables(finalSql);
      const summaryDatabase = databaseLabelOf(database, tableRefs);
      const summary = summarizeResult({ ...result, truncated, database: summaryDatabase });
      // Teaching output. The student must see *how* the answer was produced, not just the answer:
      // the steps taken, the SQL itself, and a clause-by-clause explanation. The explanation comes
      // from `explainSql` rather than the model on purpose — `generateSql`'s prompt forbids prose
      // (rule 4) so the SQL parser stays robust, and a deterministic explanation is always present
      // and never wrong. `finalSql` is shown instead of `result.sql` so the injected
      // MAX_EXECUTION_TIME hint does not clutter the statement the student is meant to read.
      const explanation = explainSql(finalSql);
      const replyParts = [];
      if (repairError !== undefined) replyParts.push(`（首次生成的 SQL 报错，已自动重写一次。原错误：${repairError}）`);
      replyParts.push(renderQuerySteps({
        connection: conn,
        database,
        readOnly,
        statementKind: analysis.statementKind,
        tables: tableRefs.length > 0 ? tableRefs : generated.tables,
        limitApplied: rowLimit,
        limitAdded: finalSql !== generated.sql,
        timeoutMs: conn.maxQueryMs ?? settings.maxQueryMs ?? DEFAULT_MAX_QUERY_MS,
        result: { ...result, truncated },
      }));
      if (args.show_sql !== false) {
        replyParts.push('', '### SQL 语句', '', '```sql', finalSql, '```', '');
      }
      replyParts.push(renderExplanation(explanation));
      replyParts.push(`### 查询结果（${summary}）`, '', table);
      if (truncated) replyParts.push('', `> 结果已按上限 ${rowLimit} 行截断，如需更多请提高 max_rows 或缩小查询范围。`);
      /** @type {Record<string, unknown>} */
      const value = {
        connection: conn.id,
        database,
        sql: finalSql,
        executed: true,
        guard: '通过只读安全检查',
        statementKind: analysis.statementKind,
        risk: analysis.estimatedRisk,
        tablesUsed: analysis.touchesTables.length > 0 ? analysis.touchesTables : generated.tables,
        rowCount: result.rowCount,
        elapsedMs: result.elapsedMs,
        truncated,
        resultTable: table,
        reply: replyParts.filter((part) => part !== undefined).join('\n'),
      };
      if (repairError !== undefined) value.repairError = repairError;
      return value;
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '查询 MySQL',
      kind: 'fetch',
      rawInput: args.question,
    }),
  });
}

/**
 * Best-effort working directory of the calling agent; falls back to the process directory.
 * @param {any} exec
 * @returns {string|undefined}
 */
function cwdOf(exec) {
  const explicit = exec?.cwd ?? exec?.agent?.cwd ?? exec?.agent?.meta?.cwd;
  return typeof explicit === 'string' && explicit !== '' ? explicit : process.cwd();
}
