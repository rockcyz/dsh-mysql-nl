/**
 * Real-filesystem tests for lib/core/config.js.
 *
 * Every fixture is created under os.tmpdir() with mkdtemp and removed in after(); no database
 * and no shared test helper module is required.
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CONNECTION_FILE_NAMES,
  findConnectionsFile,
  loadConnections,
  resolveConnection,
} from '../lib/core/config.js';

/** @type {string[]} */
const TEMP_DIRS = [];

/**
 * @returns {Promise<string>} Fresh unique directory under the OS temp dir.
 */
async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-mysql-config-'));
  TEMP_DIRS.push(dir);
  return dir;
}

/**
 * @param {string} filePath Destination file.
 * @param {unknown} value JSON-serializable document.
 * @returns {Promise<void>}
 */
async function writeJson(filePath, value) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {string} filePath Destination file.
 * @param {string} text Raw file text.
 * @returns {Promise<void>}
 */
async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, 'utf8');
}

/**
 * @param {string} a First path.
 * @param {string} b Second path.
 * @returns {boolean} True when both resolve to the same location (case-insensitive on Windows).
 */
function samePath(a, b) {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * Set/delete an environment variable for the duration of `fn`, then restore it exactly.
 *
 * @template T
 * @param {string} name Variable name.
 * @param {string|undefined} value Value to set, or undefined to delete.
 * @param {() => Promise<T>} fn Body to run.
 * @returns {Promise<T>} The body's result.
 */
async function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[name] = previous;
    else delete process.env[name];
  }
}

/** @param {unknown[]} connections @param {object} [extra] */
function doc(connections, extra = {}) {
  return { version: 1, ...extra, connections };
}

/** A minimal valid connection. */
const MINIMAL = { id: 'local', user: 'root', password: 'p' };

/**
 * Assert the documented defaults are materialized (not left undefined).
 *
 * @param {Record<string, unknown>} connection Normalized connection.
 * @param {string} filePath File the connection was loaded from.
 */
function assertDefaults(connection, filePath) {
  assert.strictEqual(connection.host, '127.0.0.1');
  assert.strictEqual(connection.port, 3306);
  assert.strictEqual(connection.ssl, false);
  assert.strictEqual(connection.readOnly, true);
  assert.strictEqual(connection.maxRows, 200);
  assert.strictEqual(connection.maxQueryMs, 15000);
  assert.strictEqual(connection.charset, 'utf8mb4');
  assert.strictEqual(connection.isDefault, false);
  assert.strictEqual(connection.password, '');
  assert.strictEqual(connection.database, undefined);
  assert.ok(path.isAbsolute(connection.sourcePath));
  assert.ok(samePath(connection.sourcePath, filePath));
}

after(async () => {
  await Promise.all(TEMP_DIRS.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('CONNECTION_FILE_NAMES', () => {
  test('is an ordered, unique list of relative file names', () => {
    assert.ok(Array.isArray(CONNECTION_FILE_NAMES));
    assert.ok(CONNECTION_FILE_NAMES.length >= 2);
    for (const name of CONNECTION_FILE_NAMES) {
      assert.strictEqual(typeof name, 'string');
      assert.ok(name.trim() !== '');
      assert.ok(!path.isAbsolute(name));
    }
    assert.strictEqual(new Set(CONNECTION_FILE_NAMES).size, CONNECTION_FILE_NAMES.length);
    assert.strictEqual(CONNECTION_FILE_NAMES[0], '.dsh-mysql.json');
    assert.ok(CONNECTION_FILE_NAMES.includes('dsh-mysql.json'));
  });
});

describe('findConnectionsFile discovery', () => {
  test('finds a config at the workspace root when cwd is a nested subdirectory', async () => {
    const root = await makeTempDir();
    const nested = path.join(root, 'packages', 'app', 'src');
    await mkdir(nested, { recursive: true });
    const file = path.join(root, '.dsh-mysql.json');
    await writeJson(file, doc([{ id: 'local', user: 'root', password: 'p', database: 'app' }]));

    const found = await findConnectionsFile({ cwd: nested });
    assert.ok(found !== null);
    assert.ok(samePath(found, file));

    const config = await loadConnections({ cwd: nested });
    assert.ok(path.isAbsolute(config.path));
    assert.ok(samePath(config.path, file));
    assert.strictEqual(config.connections.length, 1);
    assert.strictEqual(config.connections[0].id, 'local');
  });

  test('prefers the nearest ancestor when several ancestors hold a config', async () => {
    const root = await makeTempDir();
    const workspace = path.join(root, 'ws');
    const deep = path.join(workspace, 'nested', 'deep');
    await mkdir(deep, { recursive: true });
    await writeJson(path.join(root, '.dsh-mysql.json'), doc([{ id: 'outer', user: 'root' }]));
    await writeJson(path.join(workspace, '.dsh-mysql.json'), doc([{ id: 'inner', user: 'root' }]));

    const found = await findConnectionsFile({ cwd: deep });
    assert.ok(found !== null);
    assert.ok(samePath(found, path.join(workspace, '.dsh-mysql.json')));
    const config = await loadConnections({ cwd: deep });
    assert.strictEqual(config.connections[0].id, 'inner');
  });

  test('probes CONNECTION_FILE_NAMES in order within one directory', async () => {
    const dir = await makeTempDir();
    for (let index = 0; index < CONNECTION_FILE_NAMES.length; index += 1) {
      await writeJson(
        path.join(dir, CONNECTION_FILE_NAMES[index]),
        doc([{ id: `c${index}`, user: 'root' }], { default: `c${index}` }),
      );
    }
    for (let index = 0; index < CONNECTION_FILE_NAMES.length; index += 1) {
      const expected = path.join(dir, CONNECTION_FILE_NAMES[index]);
      const found = await findConnectionsFile({ cwd: dir });
      assert.ok(found !== null);
      assert.ok(samePath(found, expected), `expected ${expected}, got ${found}`);
      const config = await loadConnections({ cwd: dir });
      assert.strictEqual(config.connections[0].id, `c${index}`);
      await rm(expected, { force: true });
    }
  });

  test('returns null (and loadConnections throws) when nothing is found anywhere', async (t) => {
    const dir = await makeTempDir();
    const nested = path.join(dir, 'a', 'b');
    await mkdir(nested, { recursive: true });

    const found = await findConnectionsFile({ cwd: nested });
    if (found !== null) {
      t.skip(`a real connections file exists on this machine (${found}); skipping the null case`);
      return;
    }
    assert.strictEqual(found, null);
    await assert.rejects(() => loadConnections({ cwd: nested }), /未找到数据库连接配置文件/);
  });
});

describe('explicit path handling', () => {
  test('a missing explicit path throws and never falls back to a discovered file', async () => {
    const dir = await makeTempDir();
    await writeJson(path.join(dir, '.dsh-mysql.json'), doc([{ id: 'local', user: 'root' }]));
    const missing = path.join(dir, 'nowhere', 'missing.json');

    await assert.rejects(() => findConnectionsFile({ cwd: dir, explicit: 'nowhere/missing.json' }), (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /找不到连接配置文件/);
      assert.match(err.message, /missing\.json/);
      return true;
    });
    await assert.rejects(() => findConnectionsFile({ cwd: dir, explicit: missing }), /找不到连接配置文件/);
    await assert.rejects(() => loadConnections({ cwd: dir, explicit: 'nowhere/missing.json' }), /找不到连接配置文件/);
  });

  test('a relative explicit path resolves against cwd', async () => {
    const dir = await makeTempDir();
    const configDir = path.join(dir, 'configs');
    const file = path.join(configDir, 'conn.json');
    await writeJson(file, doc([{ id: 'from-explicit', user: 'root' }]));

    const found = await findConnectionsFile({ cwd: configDir, explicit: 'conn.json' });
    assert.ok(found !== null);
    assert.ok(samePath(found, file));

    const config = await loadConnections({ cwd: configDir, explicit: './conn.json' });
    assert.ok(samePath(config.path, file));
    assert.strictEqual(config.connections[0].id, 'from-explicit');
  });

  test('an absolute explicit path works from an unrelated cwd', async () => {
    const dir = await makeTempDir();
    const other = await makeTempDir();
    const file = path.join(dir, 'custom-name.json');
    await writeJson(file, doc([{ id: 'absolute', user: 'root' }]));

    const config = await loadConnections({ cwd: other, explicit: file });
    assert.ok(samePath(config.path, file));
    assert.strictEqual(config.connections[0].id, 'absolute');
  });

  test('a directory or non-string explicit value throws', async () => {
    const dir = await makeTempDir();
    await mkdir(path.join(dir, 'configs'), { recursive: true });
    await assert.rejects(() => findConnectionsFile({ cwd: dir, explicit: 'configs' }), /不是普通文件/);
    await assert.rejects(() => findConnectionsFile({ cwd: dir, explicit: 42 }), /explicit 必须是文件路径字符串/);
  });

  test('a whitespace-only explicit value falls back to the normal search', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, '.dsh-mysql.json');
    await writeJson(file, doc([MINIMAL]));

    const found = await findConnectionsFile({ cwd: dir, explicit: '   ' });
    assert.ok(found !== null);
    assert.ok(samePath(found, file));
  });
});

describe('${env:NAME} substitution', () => {
  test('resolves whole-string and embedded references, including $ characters in values', async () => {
    const dir = await makeTempDir();
    await writeJson(
      path.join(dir, '.dsh-mysql.json'),
      doc([
        {
          id: 'local',
          user: 'root',
          password: '${env:DSH_TEST_PWD}',
          database: 'app-${env:DSH_TEST_HOST}-1',
          label: 'pre-${env:DSH_TEST_HOST}-post',
        },
      ]),
    );

    await withEnv('DSH_TEST_PWD', 'p$a$&word$$', async () => {
      await withEnv('DSH_TEST_HOST', 'db.internal', async () => {
        const config = await loadConnections({ cwd: dir });
        const connection = config.connections[0];
        assert.strictEqual(connection.password, 'p$a$&word$$');
        assert.strictEqual(connection.database, 'app-db.internal-1');
        assert.strictEqual(connection.label, 'pre-db.internal-post');
      });
    });
  });

  test('a missing or empty environment variable throws naming the variable and the file', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, '.dsh-mysql.json');
    await writeJson(file, doc([{ id: 'local', user: 'root', password: '${env:DSH_TEST_MISSING}' }]));

    await withEnv('DSH_TEST_MISSING', undefined, async () => {
      await assert.rejects(() => loadConnections({ cwd: dir }), (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /DSH_TEST_MISSING/);
        assert.ok(
          err.message.toLowerCase().includes(file.toLowerCase()),
          `message should name the file: ${err.message}`,
        );
        return true;
      });
    });
    await withEnv('DSH_TEST_MISSING', '', async () => {
      await assert.rejects(() => loadConnections({ cwd: dir }), /DSH_TEST_MISSING/);
    });
  });

  test('an empty ${env:} reference throws', async () => {
    const dir = await makeTempDir();
    await writeJson(
      path.join(dir, '.dsh-mysql.json'),
      doc([{ id: 'local', user: 'root', password: '${env:}' }]),
    );
    await assert.rejects(() => loadConnections({ cwd: dir }), /空的 \$\{env:\}/);
  });

  test('never substitutes inside object keys', async () => {
    const dir = await makeTempDir();
    await writeJson(
      path.join(dir, '.dsh-mysql.json'),
      doc([{ id: 'local', user: 'root', '${env:DSH_TEST_KEY}': 'x' }]),
    );

    await withEnv('DSH_TEST_KEY', 'password', async () => {
      await assert.rejects(() => loadConnections({ cwd: dir }), (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /\$\{env:DSH_TEST_KEY\}/);
        return true;
      });
    });
  });
});

describe('accepted document shapes and normalization', () => {
  test('shape 1: { version, default, connections }', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, '.dsh-mysql.json');
    await writeJson(file, doc([MINIMAL], { default: 'local' }));

    const config = await loadConnections({ cwd: dir });
    assert.strictEqual(config.defaultId, 'local');
    assert.ok(samePath(config.path, file));
    const connection = config.connections[0];
    assert.strictEqual(connection.id, 'local');
    assert.strictEqual(connection.user, 'root');
    assert.strictEqual(connection.password, 'p');
    assert.strictEqual(connection.host, '127.0.0.1');
    assert.strictEqual(connection.port, 3306);
    assert.strictEqual(connection.readOnly, true);
    assert.strictEqual(connection.maxRows, 200);
    assert.ok(samePath(connection.sourcePath, file));
  });

  test('shape 2: { default, connections } without version', async () => {
    const dir = await makeTempDir();
    await writeJson(
      path.join(dir, '.dsh-mysql.json'),
      { default: 'b', connections: [{ id: 'a', user: 'root' }, { id: 'b', user: 'root' }] },
    );

    const config = await loadConnections({ cwd: dir });
    assert.strictEqual(config.defaultId, 'b');
    assert.strictEqual(config.connections.length, 2);
  });

  test('shape 3: a bare array; a single entry becomes the default', async () => {
    const singleDir = await makeTempDir();
    await writeJson(path.join(singleDir, 'dsh-mysql.json'), [{ id: 'solo', user: 'root' }]);
    const single = await loadConnections({ cwd: singleDir });
    assert.strictEqual(single.connections.length, 1);
    assert.strictEqual(single.defaultId, 'solo');
    assert.strictEqual(single.connections[0].readOnly, true);

    const multiDir = await makeTempDir();
    await writeJson(path.join(multiDir, 'dsh-mysql.json'), [
      { id: 'one', user: 'root' },
      { id: 'two', user: 'root' },
    ]);
    const multi = await loadConnections({ cwd: multiDir });
    assert.strictEqual(multi.connections.length, 2);
    assert.strictEqual(multi.defaultId, undefined);
    assert.strictEqual('defaultId' in multi, false);
  });

  test('shape 4: a single connection object without a wrapper gets id "default"', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, '.dsh-mysql.json');
    await writeJson(file, { host: 'db.example.com', user: 'root', password: 'pw', database: 'shop' });

    const config = await loadConnections({ cwd: dir });
    assert.strictEqual(config.connections.length, 1);
    const connection = config.connections[0];
    assert.strictEqual(connection.id, 'default');
    assert.strictEqual(connection.host, 'db.example.com');
    assert.strictEqual(connection.database, 'shop');
    assert.strictEqual(config.defaultId, 'default');
    assert.strictEqual(resolveConnection(config), connection);
  });

  test('materializes every documented default', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, '.dsh-mysql.json');
    await writeJson(file, doc([{ id: 'bare', user: 'root' }]));
    const config = await loadConnections({ cwd: dir });
    assertDefaults(config.connections[0], file);
  });

  test('{ "mysql": { ... } } is accepted as a root alias', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, '.dsh-mysql.json');
    await writeJson(file, {
      mysql: { version: 1, default: 'local', connections: [MINIMAL] },
    });
    const config = await loadConnections({ cwd: dir });
    assert.strictEqual(config.defaultId, 'local');
    assert.strictEqual(config.connections[0].id, 'local');
    assert.ok(samePath(config.path, file));

    const singleDir = await makeTempDir();
    await writeJson(path.join(singleDir, '.dsh-mysql.json'), {
      mysql: { host: 'alias-host', user: 'root' },
    });
    const single = await loadConnections({ cwd: singleDir });
    assert.strictEqual(single.connections[0].id, 'default');
    assert.strictEqual(single.connections[0].host, 'alias-host');
  });

  test('clamps maxRows to 1..10000 and maxQueryMs to 100..600000', async () => {
    const dir = await makeTempDir();
    await writeJson(
      path.join(dir, '.dsh-mysql.json'),
      doc([
        { id: 'low', user: 'root', maxRows: 0, maxQueryMs: 1 },
        { id: 'high', user: 'root', maxRows: 999999, maxQueryMs: 99999999 },
      ]),
    );
    const config = await loadConnections({ cwd: dir });
    const low = config.connections.find((connection) => connection.id === 'low');
    const high = config.connections.find((connection) => connection.id === 'high');
    assert.ok(low && high);
    assert.strictEqual(low.maxRows, 1);
    assert.strictEqual(low.maxQueryMs, 100);
    assert.strictEqual(high.maxRows, 10000);
    assert.strictEqual(high.maxQueryMs, 600000);
  });

  test('accepts explicit values and numeric-string ports', async () => {
    const dir = await makeTempDir();
    await writeJson(
      path.join(dir, '.dsh-mysql.json'),
      doc([
        {
          id: 'full',
          label: '生产库',
          host: '10.0.0.5',
          port: '3307',
          user: 'app',
          password: '',
          database: 'shop',
          ssl: true,
          readOnly: false,
          maxRows: 50,
          maxQueryMs: 2000,
          charset: 'utf8',
          isDefault: true,
        },
      ]),
    );
    const config = await loadConnections({ cwd: dir });
    const connection = config.connections[0];
    assert.strictEqual(connection.port, 3307);
    assert.strictEqual(connection.label, '生产库');
    assert.strictEqual(connection.host, '10.0.0.5');
    assert.strictEqual(connection.password, '');
    assert.strictEqual(connection.database, 'shop');
    assert.strictEqual(connection.ssl, true);
    assert.strictEqual(connection.readOnly, false);
    assert.strictEqual(connection.maxRows, 50);
    assert.strictEqual(connection.maxQueryMs, 2000);
    assert.strictEqual(connection.charset, 'utf8');
    assert.strictEqual(connection.isDefault, true);
    assert.strictEqual(config.defaultId, 'full');
  });

  test('adds sourcePath to every connection', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, '.dsh-mysql.json');
    await writeJson(file, doc([{ id: 'a', user: 'root' }, { id: 'b', user: 'root' }]));
    const config = await loadConnections({ cwd: dir });
    for (const connection of config.connections) {
      assert.ok(path.isAbsolute(connection.sourcePath));
      assert.ok(samePath(connection.sourcePath, file));
    }
  });
});

describe('loadConnections validation failures', () => {
  test('rejects malformed documents with clear errors', async (t) => {
    const dir = await makeTempDir();
    const file = path.join(dir, '.dsh-mysql.json');

    const cases = [
      {
        name: 'duplicate ids throw',
        document: doc([{ id: 'dup', user: 'root' }, { id: 'dup', user: 'root' }]),
        expected: /重复的连接 id/,
      },
      {
        name: 'unknown connection key throws naming the key and connection',
        document: doc([{ id: 'local', user: 'root', passwd: 'oops' }]),
        expected: /passwd[\s\S]*"local"|"local"[\s\S]*passwd/,
      },
      {
        name: 'empty connections array throws',
        document: doc([]),
        expected: /未找到任何数据库连接配置/,
      },
      { name: 'port 0 throws', document: doc([{ id: 'a', user: 'root', port: 0 }]), expected: /1\.\.65535/ },
      { name: 'port 70000 throws', document: doc([{ id: 'a', user: 'root', port: 70000 }]), expected: /1\.\.65535/ },
      { name: 'non-integer port throws', document: doc([{ id: 'a', user: 'root', port: 3.5 }]), expected: /必须是整数/ },
      { name: 'non-numeric port throws', document: doc([{ id: 'a', user: 'root', port: 'abc' }]), expected: /必须是整数/ },
      { name: 'boolean port throws', document: doc([{ id: 'a', user: 'root', port: true }]), expected: /必须是整数/ },
      { name: 'missing user throws', document: doc([{ id: 'a' }]), expected: /缺少必填的非空字符串 "user"/ },
      { name: 'empty user throws', document: doc([{ id: 'a', user: '   ' }]), expected: /缺少必填的非空字符串 "user"/ },
      { name: 'missing id in an array entry throws', document: doc([{ user: 'root' }]), expected: /缺少必填的 "id"/ },
      { name: 'empty id throws', document: doc([{ id: '  ', user: 'root' }]), expected: /"id" 必须是非空字符串/ },
      { name: 'empty host throws', document: doc([{ id: 'a', user: 'root', host: '' }]), expected: /"host" 必须是非空字符串/ },
      { name: 'non-boolean ssl throws', document: doc([{ id: 'a', user: 'root', ssl: 'yes' }]), expected: /"ssl" 必须是 true 或 false/ },
      { name: 'non-boolean readOnly throws', document: doc([{ id: 'a', user: 'root', readOnly: 1 }]), expected: /"readOnly" 必须是 true 或 false/ },
      { name: 'non-boolean isDefault throws', document: doc([{ id: 'a', user: 'root', isDefault: 'true' }]), expected: /"isDefault" 必须是 true 或 false/ },
      { name: 'non-integer maxRows throws', document: doc([{ id: 'a', user: 'root', maxRows: 1.5 }]), expected: /必须是整数/ },
      { name: 'empty charset throws', document: doc([{ id: 'a', user: 'root', charset: '' }]), expected: /"charset" 必须是非空字符串/ },
      { name: 'non-string default throws', document: doc([MINIMAL], { default: 5 }), expected: /default 必须是字符串/ },
      { name: 'default pointing at an unknown id throws', document: doc([MINIMAL], { default: 'nope' }), expected: /已知连接/ },
      {
        name: 'several isDefault flags throw',
        document: doc([
          { id: 'a', user: 'root', isDefault: true },
          { id: 'b', user: 'root', isDefault: true },
        ]),
        expected: /只能有一个默认连接/,
      },
      { name: 'unknown top-level key throws', document: { connections: [MINIMAL], bogus: 1 }, expected: /bogus/ },
      { name: 'connections that is not an array throws', document: { connections: { id: 'a' } }, expected: /"connections" 必须是数组/ },
      { name: 'a non-object connection entry throws', document: doc(['nope']), expected: /connections\[0\] 必须是对象/ },
      { name: 'a numeric top level throws', document: 42, expected: /顶层必须是对象或数组/ },
      { name: 'a null top level throws', document: null, expected: /顶层必须是对象或数组/ },
      {
        name: 'a stray key next to the mysql alias throws',
        document: { mysql: { connections: [MINIMAL] }, oops: true },
        expected: /oops/,
      },
    ];

    for (const testCase of cases) {
      await t.test(testCase.name, async () => {
        await writeJson(file, testCase.document);
        await assert.rejects(() => loadConnections({ cwd: dir }), testCase.expected);
      });
    }
  });

  test('the empty-connections error names the resolved file path', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, '.dsh-mysql.json');
    await writeJson(file, doc([]));
    await assert.rejects(() => loadConnections({ cwd: dir }), (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /未找到任何数据库连接配置/);
      assert.ok(
        err.message.toLowerCase().includes(file.toLowerCase()),
        `message should name the file: ${err.message}`,
      );
      return true;
    });
  });

  test('bad JSON reports the file path and the parser message', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, '.dsh-mysql.json');
    await writeText(file, '{ "connections": [ }');
    await assert.rejects(() => loadConnections({ cwd: dir }), (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /不是合法的 JSON/);
      assert.ok(
        err.message.toLowerCase().includes(file.toLowerCase()),
        `message should name the file: ${err.message}`,
      );
      assert.match(err.message, /解析错误：/);
      return true;
    });
  });

  test('never includes the password in thrown messages', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, '.dsh-mysql.json');
    const secret = 'super-secret-pw';
    const documents = [
      doc([{ id: 'local', user: 'root', password: secret, port: 0 }]),
      doc([{ id: 'local', user: 'root', password: secret, passwd: 'typo' }]),
      doc([{ id: 'local', user: 'root', password: secret }, { id: 'local', user: 'root', password: secret }]),
    ];
    for (const document of documents) {
      await writeJson(file, document);
      await assert.rejects(() => loadConnections({ cwd: dir }), (err) => {
        assert.ok(err instanceof Error);
        assert.strictEqual(err.message.includes(secret), false, `password leaked: ${err.message}`);
        return true;
      });
    }
  });
});

describe('resolveConnection', () => {
  test('returns the exact configured object for an explicit id', async () => {
    const dir = await makeTempDir();
    await writeJson(
      path.join(dir, '.dsh-mysql.json'),
      doc([{ id: 'first', user: 'root' }, { id: 'second', user: 'root' }], { default: 'second' }),
    );
    const config = await loadConnections({ cwd: dir });

    const first = resolveConnection(config, 'first');
    assert.strictEqual(first, config.connections[0]);
    assert.strictEqual(first.id, 'first');
    assert.strictEqual(resolveConnection(config, 'second'), config.connections[1]);
  });

  test('falls back to defaultId for undefined and empty ids', async () => {
    const dir = await makeTempDir();
    await writeJson(
      path.join(dir, '.dsh-mysql.json'),
      doc([{ id: 'first', user: 'root' }, { id: 'second', user: 'root' }], { default: 'second' }),
    );
    const config = await loadConnections({ cwd: dir });
    assert.strictEqual(resolveConnection(config), config.connections[1]);
    assert.strictEqual(resolveConnection(config, ''), config.connections[1]);
    assert.strictEqual(resolveConnection(config, '   '), config.connections[1]);
  });

  test('uses the single connection when no default is declared', async () => {
    const dir = await makeTempDir();
    await writeJson(path.join(dir, '.dsh-mysql.json'), doc([{ id: 'only', user: 'root' }]));
    const config = await loadConnections({ cwd: dir });
    assert.strictEqual(resolveConnection(config), config.connections[0]);
  });

  test('throws and lists known ids when the id is unknown or required', async () => {
    const dir = await makeTempDir();
    await writeJson(
      path.join(dir, '.dsh-mysql.json'),
      doc([{ id: 'first', user: 'root' }, { id: 'second', user: 'root' }]),
    );
    const config = await loadConnections({ cwd: dir });
    assert.strictEqual(config.defaultId, undefined);

    assert.throws(() => resolveConnection(config, 'missing'), (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /未知的连接 id/);
      assert.match(err.message, /first/);
      assert.match(err.message, /second/);
      return true;
    });
    assert.throws(() => resolveConnection(config), (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /first/);
      assert.match(err.message, /second/);
      return true;
    });
  });

  test('throws for an empty or inconsistent config', () => {
    assert.throws(() => resolveConnection({ connections: [] }), /没有可用的数据库连接配置/);
    assert.throws(() => resolveConnection(undefined), /没有可用的数据库连接配置/);
    assert.throws(
      () => resolveConnection({ connections: [{ id: 'a', user: 'root' }], defaultId: 'ghost' }),
      /已知连接/,
    );
  });

  test('honours a connection isDefault flag when the file has no default field', async () => {
    const dir = await makeTempDir();
    await writeJson(
      path.join(dir, '.dsh-mysql.json'),
      doc([{ id: 'a', user: 'root' }, { id: 'b', user: 'root', isDefault: true }]),
    );
    const config = await loadConnections({ cwd: dir });
    assert.strictEqual(config.defaultId, 'b');
    assert.strictEqual(resolveConnection(config), config.connections[1]);
  });
});
