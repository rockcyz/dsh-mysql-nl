/**
 * Integration test for the agent-facing tool path: the plugin's `ctx.llm.stream` adapter, the model
 * route resolution, natural-language generation, execution, and the returned tool value.
 *
 * The host's `llm` service is replaced by a scripted stream, and the model route comes from a fake
 * `agentDefaultModel` — everything else (config file, real MySQL, real schema, real SQL) is real.
 * Skipped automatically when the test server is unreachable.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { disposeAll } from '../lib/core/client.js';
import { apply } from '../lib/plugin-mysql.js';

const HOST = process.env.DSH_TEST_MYSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.DSH_TEST_MYSQL_PORT ?? 3306);
const USER = process.env.DSH_TEST_MYSQL_USER ?? 'root';
const PASSWORD = process.env.DSH_TEST_MYSQL_PASSWORD ?? 'root';
const DATABASE = process.env.DSH_TEST_MYSQL_DATABASE ?? 'world';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mysql-nl-plugin-'));

/** Write the connection store the plugin will discover, and prove the server answers. */
async function prepareTarget() {
  const file = path.join(tempRoot, '.dsh-mysql.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    default: 'it',
    connections: [{ id: 'it', host: HOST, port: PORT, user: USER, password: PASSWORD, database: DATABASE, readOnly: true }],
  }, null, 2));
  return file;
}

const connectionsFile = await prepareTarget();

/**
 * A second store whose connection explicitly allows writes. The plugin must generate-and-hand-off
 * there too: "the account may write" is not permission for this tool to write.
 */
const readWriteConnectionsFile = await (async () => {
  const file = path.join(tempRoot, '.dsh-mysql-rw.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    default: 'rw',
    connections: [{ id: 'rw', host: HOST, port: PORT, user: USER, password: PASSWORD, database: DATABASE, readOnly: false }],
  }, null, 2));
  return file;
})();

let reachable = false;
try {
  const mysql = await import('mysql2/promise');
  const pool = mysql.createPool({ host: HOST, port: PORT, user: USER, password: PASSWORD, connectionLimit: 1, connectTimeout: 5000 });
  const [rows] = await pool.query('SELECT 1 AS ok');
  reachable = rows[0].ok === 1;
  await pool.end();
} catch {
  reachable = false;
}

after(async () => {
  await disposeAll();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

/**
 * @param {{chunks?: unknown[], failure?: string, route?: {provider: string, model: string}}} [options]
 */
function harness(options = {}) {
  const definitions = [];
  const seen = [];
  const chunks = options.chunks ?? [];
  const route = options.route ?? { provider: 'test-provider', model: 'test-model' };
  const ctx = {
    tools: { register: (definition) => { definitions.push(definition); return () => {}; } },
    effect: () => () => {},
    on: () => () => {},
    get(key) {
      if (key === 'agentDefaultModel') return { currentSelection: () => route };
      if (key === 'llm') {
        return {
          stream: (request) => {
            seen.push(request);
            // eslint-disable-next-line no-async-generator-functions
            return (async function* generate() {
              if (options.failure !== undefined) {
                yield { type: 'finish', reason: { kind: 'error', failure: { message: options.failure, code: 'TEST' } } };
                return;
              }
              for (const chunk of chunks) yield chunk;
              yield { type: 'finish', reason: { kind: 'stop' } };
            })();
          },
        };
      }
      return undefined;
    },
  };
  apply(ctx, { connectionsFile: options.connectionsFile ?? connectionsFile, maxRows: 20 });
  const tool = (toolName) => definitions.find((definition) => definition.name === toolName);
  return { definitions, seen, tool };
}

const exec = () => ({ signal: new AbortController().signal, agent: { cwd: tempRoot } });

describe('agent-facing tool path', { skip: !reachable }, () => {
  it('resolves the model route from the host default-model service', async () => {
    const { seen, tool } = harness({
      chunks: [{ type: 'text-delta', index: 0, text: 'SELECT `Name` FROM `country` LIMIT 2' }],
    });
    await tool('mysql_nl_query').execute({ question: '前两个国家' }, exec());
    assert.equal(seen.length, 1);
    assert.equal(seen[0].provider, 'test-provider');
    assert.equal(seen[0].model, 'test-model');
    assert.equal(seen[0].temperature, 0);
  });

  it('assembles streamed text deltas into the SQL that runs', async () => {
    const { seen, tool } = harness({
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '```sql\nSELECT `Name`, `Population` FROM `country`\n' },
        { type: 'text-delta', index: 0, text: 'ORDER BY `Population` DESC LIMIT 2\n```' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'ignored' } },
      ],
    });
    const value = await tool('mysql_nl_query').execute({ question: '人口最多的两个国家' }, exec());
    assert.equal(value.executed, true);
    assert.equal(value.connection, 'it');
    assert.equal(value.database, DATABASE);
    // `sql` is the statement the student is shown: the query as written, with the LIMIT we enforced
    // and *without* the MAX_EXECUTION_TIME hint client.js injects. Showing that hint would clutter
    // the statement a database course is trying to teach; the reply discloses it as a numbered step.
    assert.match(value.sql, /^SELECT `Name`, `Population` FROM `country`/);
    assert.doesNotMatch(value.sql, /MAX_EXECUTION_TIME/);
    // The model already bounded the result, so the plugin must not stack a second LIMIT; the row cap
    // is still enforced client-side by runQuery.
    assert.match(value.sql, /ORDER BY `Population` DESC LIMIT 2\s*$/);
    assert.equal(value.rowCount, 2);
    assert.deepEqual(value.tablesUsed, ['country']);
    assert.equal(value.risk, '低');
    // Teaching contract: steps, SQL, clause-by-clause explanation, then the result.
    assert.match(value.reply, /### 执行步骤/);
    assert.match(value.reply, /### SQL 语句/);
    assert.match(value.reply, /### 语句讲解/);
    assert.match(value.reply, /### 查询结果/);
    assert.match(value.reply, /\*\*ORDER BY\*\*/);
    assert.match(value.reply, /MAX_EXECUTION_TIME\(15000\)/);
    assert.match(value.resultTable, /\| Name \| Population \|/);
    assert.match(seen[0].system, /MySQL/);
    assert.match(seen[0].messages[0].content[0].text, /Population/);
  });

  it('appends the configured row cap when the model forgets a LIMIT', async () => {
    const { tool } = harness({
      chunks: [{ type: 'text-delta', index: 0, text: 'SELECT `Name` FROM `country` ORDER BY `Population` DESC' }],
    });
    // The connection file sets its own maxRows, which outranks the plugin default; max_rows on the
    // call is the tightest override, so ask for 7 explicitly.
    const value = await tool('mysql_nl_query').execute({ question: '所有国家按人口倒序', max_rows: 7 }, exec());
    assert.match(value.sql, /LIMIT 7\s*$/, 'the plugin must bound an unbounded model answer');
    assert.equal(value.rowCount, 7);
    assert.equal(value.truncated, true, 'hitting the cap means more rows may exist');
    assert.match(value.reply, /已限制|7 行/);
  });

  it('reports a provider failure instead of silently returning nothing', async () => {
    const { tool } = harness({ failure: 'rate limited' });
    await assert.rejects(
      () => tool('mysql_nl_query').execute({ question: '任意问题' }, exec()),
      /模型调用失败.*rate limited/,
    );
  });

  it('hands a write statement off for manual execution instead of rejecting it', async () => {
    const { tool } = harness({
      chunks: [{ type: 'text-delta', index: 0, text: 'DELETE FROM `country` WHERE `Code` = \'XXX\'' }],
    });
    // The refusal became a hand-off: the SQL is now the useful answer, because the plugin grounds it
    // in the real schema even though it must never run it.
    const value = await tool('mysql_nl_query').execute({ question: '删掉那个国家', execute: false }, exec());
    assert.equal(value.executed, false);
    assert.equal(value.rowCount, 0);
    assert.equal(value.elapsedMs, 0);
    assert.equal(value.statementKind, 'delete');
    assert.equal(value.risk, '高');
    assert.match(value.guard, /仅生成/);
    assert.match(value.reply, /写操作：只生成，不执行/);
    assert.match(value.reply, /### SQL 语句/);
    assert.match(value.reply, /### 语句讲解/);
    assert.match(value.reply, /\*\*DELETE FROM\*\*/);
    assert.match(value.reply, /DBeaver/);
    assert.match(value.reply, /在你的客户端执行/);
    assert.doesNotMatch(value.reply, /### 查询结果/);
  });

  it('returns a select without executing it when execute is false', async () => {
    const { tool } = harness({
      chunks: [{ type: 'text-delta', index: 0, text: 'SELECT `Name` FROM `country` LIMIT 3' }],
    });
    const value = await tool('mysql_nl_query').execute({ question: '三个国家', execute: false }, exec());
    assert.equal(value.executed, false);
    assert.equal(value.rowCount, 0);
    assert.equal(value.elapsedMs, 0);
    assert.match(value.sql, /SELECT `Name` FROM `country`/);
    assert.match(value.guard, /未执行/);
    assert.match(value.reply, /不执行/);
    // "只生成 SQL 让我看看" is still a lesson: the SQL and its explanation must both be present.
    assert.match(value.reply, /### SQL 语句/);
    assert.match(value.reply, /### 语句讲解/);
    assert.match(value.reply, /\*\*FROM\*\* `country`/);
    assert.doesNotMatch(value.reply, /### 查询结果/);
  });

  it('never executes a generated write, even on a read-write connection', async () => {
    const probe = '__dsh_write_probe';
    const mysql = await import('mysql2/promise');
    const pool = mysql.createPool({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: DATABASE, connectionLimit: 1 });
    const probeExists = async () => {
      const [rows] = await pool.query(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
        [DATABASE, probe],
      );
      return rows[0].n > 0;
    };
    try {
      await pool.query(`DROP TABLE IF EXISTS \`${probe}\``);
      assert.equal(await probeExists(), false, 'probe table must start absent');

      const { tool } = harness({
        connectionsFile: readWriteConnectionsFile,
        chunks: [{ type: 'text-delta', index: 0, text: `CREATE TABLE \`${probe}\` (\`id\` INT)` }],
      });
      // `readOnly: false` is the strongest case: the connection allows writes, and the plugin still
      // must not perform one. The probe makes "did not execute" observable on the server itself.
      const value = await tool('mysql_nl_query').execute({ question: '建一张探针表', connection: 'rw' }, exec());
      assert.equal(value.connection, 'rw');
      assert.equal(value.executed, false);
      assert.equal(value.statementKind, 'create');
      assert.match(value.guard, /仅生成/);
      assert.equal(await probeExists(), false, 'the generated CREATE TABLE must never have run');
    } finally {
      await pool.query(`DROP TABLE IF EXISTS \`${probe}\``);
      await pool.end();
    }
  });

  it('refuses management statements that are neither reads nor coursework SQL', async () => {
    const { tool } = harness({
      chunks: [{ type: 'text-delta', index: 0, text: "SET GLOBAL max_connections = 1" }],
    });
    await assert.rejects(
      () => tool('mysql_nl_query').execute({ question: '把最大连接数调成1' }, exec()),
      /不在支持范围/,
    );
  });

  it('lists the configured connection without a password and can ping it', async () => {
    const { tool } = harness();
    const value = await tool('mysql_list_connections').execute({ ping: true }, exec());
    assert.equal(value.profile, connectionsFile);
    assert.equal(value.connections.length, 1);
    const entry = value.connections[0];
    assert.equal(entry.id, 'it');
    assert.equal(entry.reachable, true);
    assert.match(entry.version, /^\d+\./);
    assert.ok(!JSON.stringify(value).includes('"password"'));
    assert.match(value.hint, /root@127\.0\.0\.1/);
    // The listing must not claim "密码 空" for a connection that does have one: the render object
    // used to drop `password`, so the indicator lied even though the secret was never printed.
    assert.match(value.hint, /密码 已配置/);
    assert.ok(Array.isArray(value.databases));
    assert.ok(value.databases.includes(DATABASE));
  });

  it('reads the real schema through the mysql_schema tool', async () => {
    const { tool } = harness();
    const value = await tool('mysql_schema').execute({}, exec());
    assert.equal(value.connection, 'it');
    assert.equal(value.database, DATABASE);
    assert.ok(value.tableCount > 0);
    assert.ok(value.tables.length > 0);
    assert.match(value.schema, new RegExp(DATABASE));
  });
});
