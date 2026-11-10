/**
 * End-to-end pipeline test: real MySQL server, real INFORMATION_SCHEMA introspection, real SQL
 * execution. Only the model call is injected, so this covers everything except the provider itself
 * (which the plugin entry test covers through the host's `llm` service).
 *
 * Skipped automatically when the test server is unreachable, so the suite still passes on a machine
 * without MySQL. Point it somewhere else with DSH_TEST_MYSQL_HOST/PORT/USER/PASSWORD.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { disposeAll, ping, runQuery } from '../lib/core/client.js';
import { listDatabases, loadCatalog, loadTableDetails, pickRelevantTables, renderSchema } from '../lib/core/catalog.js';
import { loadConnections, resolveConnection } from '../lib/core/config.js';
import { renderResultTable, summarizeResult } from '../lib/core/format.js';
import { generateSql } from '../lib/core/nl.js';
import { analyze, guard, withRowLimit } from '../lib/core/sql.js';

const HOST = process.env.DSH_TEST_MYSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.DSH_TEST_MYSQL_PORT ?? 3306);
const USER = process.env.DSH_TEST_MYSQL_USER ?? 'root';
const PASSWORD = process.env.DSH_TEST_MYSQL_PASSWORD ?? 'root';
const DATABASE = process.env.DSH_TEST_MYSQL_DATABASE ?? 'world';

let conn;
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mysql-nl-e2e-'));

/** Materialize a connection file so the config layer is exercised for real, not bypassed. */
async function writeConfig() {
  const file = path.join(tempRoot, '.dsh-mysql.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    default: 'test',
    connections: [
      { id: 'test', label: 'e2e', host: HOST, port: PORT, user: USER, password: PASSWORD, database: DATABASE, readOnly: true },
    ],
  }, null, 2));
  return file;
}

// Resolve the connection and probe the server at module scope so the suite's `skip` is a plain
// boolean instead of a lazily evaluated predicate.
conn = resolveConnection(await loadConnections({ explicit: await writeConfig() }), 'test');
let reachable = false;
try {
  await ping(conn);
  reachable = true;
} catch {
  reachable = false;
}

after(async () => {
  await disposeAll();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('real pipeline', { skip: !reachable }, () => {
  it('connects to the configured server', async () => {
    const info = await ping(conn);
    assert.match(info.version, /^\d+\./);
    assert.equal(typeof info.user, 'string');
    // A substring check would be fooled by "root" being both a password and a user name; assert the
    // exact shape instead: the probe reports only the server version and the authenticated user.
    assert.deepEqual(Object.keys(info).sort(), ['user', 'version']);
  });

  it('lists databases without system schemas', async () => {
    const databases = await listDatabases(conn);
    assert.ok(databases.length > 0);
    for (const system of ['information_schema', 'mysql', 'performance_schema', 'sys']) {
      assert.ok(!databases.includes(system), `${system} must be filtered out`);
    }
  });

  it('loads the real catalog for the configured database', async () => {
    const catalog = await loadCatalog(conn, DATABASE);
    assert.equal(catalog.database, DATABASE);
    assert.equal(catalog.detailed, false);
    assert.ok(catalog.tables.length > 0);
    for (const table of catalog.tables) {
      assert.equal(typeof table.name, 'string');
      assert.deepEqual(table.columns, []);
    }
  });

  it('renders a prompt-ready schema from real column metadata', async () => {
    const catalog = await loadTableDetails(conn, DATABASE);
    const text = renderSchema(catalog, { maxChars: 60000 });
    assert.match(text, new RegExp(DATABASE));
    assert.ok(text.length > 50);
    assert.ok(!text.includes('{"'), 'schema text must not be JSON');
  });

  it('scores real tables for a natural-language question', async () => {
    const catalog = await loadCatalog(conn, DATABASE);
    const picked = pickRelevantTables(catalog, '哪个国家人口最多', 3);
    assert.ok(picked.length > 0);
    assert.ok(picked.length <= 3);
  });

  it('generates SQL from the real schema and returns real rows', async () => {
    let promptSeen = '';
    const llm = async (options) => {
      promptSeen = options.prompt;
      // A realistic "model" answer; the assertion below is that the plugin fed it real column names.
      return '```sql\nSELECT `Name`, `Population` FROM `country` ORDER BY `Population` DESC LIMIT 3\n```';
    };
    const out = await generateSql({
      conn,
      loader: { loadCatalog, loadTableDetails },
      database: DATABASE,
      question: '人口最多的3个国家',
      llm,
      provider: 'test',
      model: 'test',
    });
    assert.match(promptSeen, /Population/);
    assert.equal(guard(out.sql, { readOnly: true }).ok, true);
    const result = await runQuery(conn, DATABASE, withRowLimit(out.sql, 50), { rowLimit: 50 });
    assert.equal(result.rowCount, 3);
    assert.deepEqual(result.columns, ['Name', 'Population']);
    assert.ok(Array.isArray(result.rows[0]));
    const table = renderResultTable(result);
    assert.match(table, /\| Name \| Population \|/);
    assert.match(summarizeResult(result), /3 行/);
    assert.match(analyze(out.sql).touchesTables.join(','), /country/);
  });

  it('truncates a large result and reports it', async () => {
    const result = await runQuery(conn, DATABASE, 'SELECT * FROM country', { rowLimit: 5 });
    assert.equal(result.rowCount, 5);
    assert.equal(result.truncated, true);
  });

  it('refuses a write through a real read-only connection before any statement runs', async () => {
    const verdict = guard('DELETE FROM country WHERE Code = "__does_not_exist__"', { readOnly: conn.readOnly !== false });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /只读/);
  });
});
