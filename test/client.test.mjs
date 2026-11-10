/**
 * Live integration tests for lib/core/client.js.
 * Every test talks to the real local MySQL server; nothing is mocked. The suite is read-only
 * apart from session-local state (`USE`) and the deliberately broken queries used to prove that a
 * destroyed connection cannot poison the pool.
 * Run: node --test test/
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { describeTarget, disposeAll, getPool, ping, runQuery } from '../lib/core/client.js';
import { HOST, PASSWORD, PORT, USER, testConn } from './helpers.mjs';

after(async () => {
  await disposeAll();
});

test('describeTarget exposes host/user/database but never the password', () => {
  const conn = testConn({ password: 'sup3r-secret-pw' });
  const target = describeTarget(conn);
  assert.deepEqual(target, {
    id: 'test',
    host: HOST,
    port: PORT,
    user: USER,
    readOnly: true,
    database: 'sakila',
  });
  assert.equal('password' in target, false);
  assert.equal(JSON.stringify(target).includes('sup3r-secret-pw'), false);
});

test('getPool reuses one pool per connection fingerprint', () => {
  const pool = getPool(testConn());
  assert.equal(getPool(testConn()), pool);
  assert.equal(getPool(testConn({ password: `${PASSWORD}-other` })) === pool, false);
  assert.equal(getPool(testConn({ database: 'world' })) === pool, false);
});

test('ping reports the live server version and account', async () => {
  const info = await ping(testConn());
  assert.match(info.version, /^8\./);
  assert.match(info.user, /^root@/);
});

test('runQuery returns rows, real column names and timing', async () => {
  const result = await runQuery(
    testConn(),
    'sakila',
    'SELECT title, release_year FROM film ORDER BY title LIMIT 5',
    { rowLimit: 200 },
  );
  assert.equal(result.database, 'sakila');
  assert.deepEqual(result.columns, ['title', 'release_year']);
  assert.equal(result.rowCount, 5);
  assert.equal(result.rows.length, 5);
  assert.equal(result.truncated, false);
  assert.equal(result.warning, undefined);
  assert.ok(result.elapsedMs >= 0);
  assert.deepEqual(result.rows[0], ['ACADEMY DINOSAUR', 2006]);
  assert.deepEqual(result.rows[4], ['AFRICAN EGG', 2006]);
  assert.ok(result.rows.every((row) => typeof row[0] === 'string' && Number.isInteger(row[1])));
  assert.match(result.sql, /^SELECT \/\*\+ MAX_EXECUTION_TIME\(15000\) \*\/ title/);
});

test('runQuery truncates oversized results to rowLimit and warns', async () => {
  const result = await runQuery(testConn(), 'sakila', 'SELECT * FROM film', { rowLimit: 3 });
  assert.equal(result.truncated, true);
  assert.equal(result.rowCount, 3);
  assert.equal(result.rows.length, 3);
  assert.equal(result.warning, '已限制返回行数为 3');
  assert.ok(result.columns.includes('film_id'));
  assert.ok(result.columns.includes('title'));
  assert.equal(result.rows[0].length, result.columns.length);
});

test('runQuery returns no row set for a statement without a result set', async () => {
  const result = await runQuery(testConn(), 'sakila', 'USE sakila');
  assert.deepEqual(result.columns, []);
  assert.deepEqual(result.rows, []);
  assert.equal(result.rowCount, 0);
  assert.equal(result.truncated, false);
});

test('runQuery normalizes bigint, decimal, binary and over-long cells', async () => {
  const result = await runQuery(
    testConn(),
    'sakila',
    'SELECT 9007199254740993 AS big, 42 AS small, CAST(3.50 AS DECIMAL(10,2)) AS amount, ' +
      "CAST('ab' AS BINARY(4)) AS bin, REPEAT('x', 500) AS long_text",
    { maxCellChars: 400 },
  );
  assert.deepEqual(result.columns, ['big', 'small', 'amount', 'bin', 'long_text']);
  const [big, small, amount, bin, longText] = result.rows[0];
  assert.equal(big, '9007199254740993');
  assert.equal(typeof big, 'string');
  assert.equal(small, 42);
  assert.equal(amount, '3.50');
  assert.equal(bin, '0x61620000');
  assert.equal(longText.length, 401);
  assert.ok(longText.endsWith('…'));
  assert.equal(longText.slice(0, 400), 'x'.repeat(400));
});

test('runQuery reads DECIMAL money columns as strings', async () => {
  const result = await runQuery(
    testConn(),
    'sakila',
    'SELECT amount FROM payment ORDER BY payment_id LIMIT 1',
  );
  assert.deepEqual(result.columns, ['amount']);
  assert.equal(typeof result.rows[0][0], 'string');
  assert.match(result.rows[0][0], /^\d+\.\d{2}$/);
});

test('runQuery enforces maxQueryMs with a hard client timeout', async () => {
  const conn = testConn({ maxQueryMs: 700 });
  const startedAt = Date.now();
  await assert.rejects(
    () => runQuery(conn, 'sakila', 'SELECT SLEEP(5)'),
    (error) => {
      assert.equal(error.code, 'DSH_QUERY_TIMEOUT');
      assert.equal(error.name, 'QueryTimeoutError');
      assert.match(error.message, /700ms/);
      return true;
    },
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 3000, `timeout took ${elapsed}ms, expected well under 3000ms`);
});

test('a destroyed connection cannot poison the pool', async () => {
  const conn = testConn({ maxQueryMs: 500 });
  await assert.rejects(
    () => runQuery(conn, 'sakila', 'DO SLEEP(3)'),
    (error) => error.code === 'DSH_QUERY_TIMEOUT',
  );
  const result = await runQuery(conn, 'sakila', 'SELECT 1 AS one');
  assert.deepEqual(result.rows, [[1]]);
});

test('a rejected database switch leaves the pool healthy', async () => {
  const conn = testConn();
  await assert.rejects(
    () => runQuery(conn, 'no_such_database_xyz', 'SELECT 1'),
    (error) => error.code === 'ER_BAD_DB_ERROR',
  );
  const result = await runQuery(conn, 'sakila', 'SELECT 2 AS two');
  assert.deepEqual(result.rows, [[2]]);
});

test('a statement with no result set reports affectedRows instead of an empty row count', async () => {
  // `DO 1` answers with an OkPacket and changes nothing, so it exercises the non-rowset branch of
  // runQuery without touching data. Before this mapping a successful UPDATE rendered as "0 rows",
  // which reads like the statement did nothing at all.
  const result = await runQuery(testConn(), 'world', 'DO 1');
  assert.deepEqual(result.columns, []);
  assert.equal(result.rowCount, 0);
  assert.equal(result.affectedRows, 0);
});

test('runQuery forwards MySQL errors with their code and the real table name', async () => {
  await assert.rejects(
    () => runQuery(testConn(), 'sakila', 'SELECT * FROM no_such_table_xyz'),
    (error) => {
      assert.equal(error.code, 'ER_NO_SUCH_TABLE');
      assert.match(error.message, /no_such_table_xyz/);
      return true;
    },
  );
});

test('an authentication failure never echoes the configured password', async () => {
  const password = 'p@ss-leak-check';
  await assert.rejects(
    () => runQuery({ ...testConn(), password }, 'sakila', 'SELECT 1'),
    (error) => {
      assert.equal(error.code, 'ER_ACCESS_DENIED_ERROR');
      assert.equal(error.message.includes(password), false);
      return true;
    },
  );
});

test('runQuery honours an AbortSignal', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    await assert.rejects(
      () => runQuery(testConn(), 'sakila', 'SELECT SLEEP(5)', { signal: controller.signal }),
      (error) => {
        assert.equal(error.code, 'DSH_QUERY_ABORTED');
        return true;
      },
    );
  } finally {
    clearTimeout(timer);
  }
});

test('disposeAll is idempotent and does not throw', async () => {
  await getPool(testConn()).query('SELECT 1 AS alive');
  await disposeAll();
  await disposeAll();
  const result = await runQuery(testConn(), 'sakila', 'SELECT 3 AS three');
  assert.deepEqual(result.rows, [[3]]);
});
