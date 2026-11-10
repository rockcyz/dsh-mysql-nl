import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Config, configJsonSchema, validateConfig } from '../lib/config-schema.js';
import { apply, inject, name } from '../lib/plugin-mysql.js';

/** Minimal Cordis-like context that records every registration the plugin makes. */
function fakeCtx(services = {}) {
  const definitions = [];
  const effects = [];
  const ctx = {
    tools: { register: (definition) => { definitions.push(definition); return () => {}; } },
    effect: (callback) => { effects.push(callback); return () => {}; },
    on: () => () => {},
    get: (key) => services[key],
  };
  return { ctx, definitions, effects };
}

const EXPECTED_TOOLS = ['mysql_list_connections', 'mysql_schema', 'mysql_nl_query'];

describe('plugin module shape', () => {
  it('exports the cordis host-plugin surface', () => {
    assert.equal(name, 'dsh-mysql-nl');
    assert.deepEqual(inject, ['tools']);
    assert.equal(typeof apply, 'function');
    assert.equal(typeof Config, 'object');
  });

  it('imports no @deepseek-ai package at runtime', async () => {
    const fs = await import('node:fs/promises');
    const files = [
      '../lib/plugin-mysql.js',
      '../lib/config-schema.js',
      '../lib/core/config.js',
      '../lib/core/client.js',
      '../lib/core/catalog.js',
      '../lib/core/sql.js',
      '../lib/core/nl.js',
      '../lib/core/format.js',
    ];
    for (const relative of files) {
      const source = await fs.readFile(new URL(relative, import.meta.url), 'utf8');
      assert.ok(!/from\s+['"]@deepseek-ai\//.test(source), `${relative} must not import a host package`);
    }
  });
});

describe('tool registration', () => {
  it('registers exactly the three documented tools', () => {
    const { ctx, definitions, effects } = fakeCtx();
    apply(ctx, {});
    assert.deepEqual(definitions.map((definition) => definition.name), EXPECTED_TOOLS);
    assert.equal(effects.length, 1, 'pool cleanup must be owned by the fiber');
  });

  it('gives every tool a complete, model-usable definition', () => {
    const { ctx, definitions } = fakeCtx();
    apply(ctx, {});
    for (const definition of definitions) {
      assert.equal(typeof definition.description, 'string');
      assert.ok(definition.description.length > 40, `${definition.name} needs a real description`);
      assert.equal(typeof definition.execute, 'function');
      // `parameters` reaches the registry verbatim, so its root must already be an object schema.
      assert.equal(definition.parameters.type, 'object', 'parameters must be an object-rooted raw schema');
      assert.equal(typeof definition.parameters.properties, 'object', 'parameters must carry a property map');
      // `output.schema` is a value-schema root.
      assert.equal(definition.output.schema.type, 'object');
      assert.equal(definition.output.schema.additionalProperties, false);
      assert.equal(typeof definition.output.render, 'function');
      assert.equal(typeof definition.presentCall, 'function');
    }
  });

  it('declares every required key inside properties', () => {
    const { ctx, definitions } = fakeCtx();
    apply(ctx, {});
    // Regression guard for the bug the first live installs caught: `parameters` and `output.schema` are
    // BOTH raw JSON Schema now. An author property map (`parameters: { key: { type: 'string' } }`) is
    // only valid inside `defineTool`, which the registry never calls — it forwards `parameters` to the
    // model untouched, so a map without `type` fails the request with HTTP 400.
    const checkParameters = (schema, name) => {
      assert.equal(schema.type, 'object', `${name}.parameters must be object-rooted raw JSON Schema`);
      assert.equal(typeof schema.properties, 'object', `${name}.parameters needs a property map`);
      assert.ok(schema.required === undefined || Array.isArray(schema.required),
        `${name}.parameters.required must be an array of property names`);
      for (const key of schema.required ?? []) {
        assert.ok(Object.hasOwn(schema.properties, key), `${name}.parameters.required names missing "${key}"`);
      }
      for (const [key, node] of Object.entries(schema.properties)) {
        assert.equal(node.required, undefined, `${name}.parameters.properties.${key} must not carry author-only required`);
        assert.equal(typeof node.type, 'string', `${name}.parameters.${key} needs a type`);
      }
    };
    const checkOutput = (node, path) => {
      assert.ok(node.required === undefined || Array.isArray(node.required),
        `${path}.required must be an array in raw JSON Schema`);
      if (node.type === 'object') {
        assert.equal(typeof node.additionalProperties, 'boolean', `${path} must declare additionalProperties`);
        for (const key of node.required ?? []) {
          assert.ok(Object.hasOwn(node.properties ?? {}, key), `${path}.required names missing "${key}"`);
        }
        for (const [key, child] of Object.entries(node.properties ?? {})) checkOutput(child, `${path}.${key}`);
      }
      if (node.type === 'array' && node.items !== undefined) checkOutput(node.items, `${path}[]`);
    };
    for (const definition of definitions) {
      checkParameters(definition.parameters, definition.name);
      checkOutput(definition.output.schema, `${definition.name}.output`);
    }
  });

  it('marks each always-present output field required and conditional fields not', () => {
    const { ctx, definitions } = fakeCtx();
    apply(ctx, {});
    const byName = Object.fromEntries(definitions.map((definition) => [definition.name, definition]));
    const requiredOf = (name) => byName[name].output.schema.required;
    assert.deepEqual(requiredOf('mysql_list_connections'), ['profile', 'connections', 'hint']);
    assert.deepEqual(requiredOf('mysql_schema'),
      ['connection', 'database', 'tableCount', 'tables', 'schema']);
    const queryRequired = requiredOf('mysql_nl_query');
    assert.ok(queryRequired.includes('reply'));
    assert.ok(queryRequired.includes('sql'));
    assert.ok(queryRequired.includes('truncated'));
    assert.ok(!queryRequired.includes('repairError'), 'repairError is conditional');
    // Nested connection entries mark their always-present keys too.
    const entry = byName.mysql_list_connections.output.schema.properties.connections.items;
    assert.deepEqual(entry.required, ['id', 'host', 'port', 'user', 'readOnly', 'isDefault']);
  });

  it('marks question as the only required parameter', () => {
    const { ctx, definitions } = fakeCtx();
    apply(ctx, {});
    const tool = definitions.find((definition) => definition.name === 'mysql_nl_query');
    assert.deepEqual(tool.parameters.required, ['question']);
    for (const definition of definitions.filter((entry) => entry.name !== 'mysql_nl_query')) {
      assert.equal(definition.parameters.required, undefined, `${definition.name} has no required parameter`);
    }
  });

  it('renders a text content block for every tool output', () => {
    const { ctx, definitions } = fakeCtx();
    apply(ctx, {});
    const renderConnectionList = definitions[0].output.render;
    const blocks = renderConnectionList({}, { profile: 'C:/x/.dsh-mysql.json', connections: [], hint: '提示文字' });
    assert.deepEqual(blocks, [{ type: 'text', text: '提示文字' }]);
  });
});

describe('plugin config', () => {
  it('exposes a Standard Schema validator', () => {
    const standard = Config['~standard'];
    assert.equal(typeof standard.validate, 'function');
    assert.equal(standard.version, 1);
    const outcome = standard.validate({ maxRows: 25, readOnly: true, profile: ' main ' });
    assert.deepEqual(outcome.value, { maxRows: 25, readOnly: true, profile: 'main' });
  });

  it('rejects unknown keys, wrong types, and out-of-range numbers', () => {
    assert.match(validateConfig({ maxRow: 5 }).issues[0].message, /未知的配置项 "maxRow"/);
    assert.match(validateConfig({ maxRows: 'x' }).issues[0].message, /必须是数字/);
    assert.match(validateConfig({ maxRows: 0 }).issues[0].message, /不能小于 1/);
    assert.match(validateConfig({ maxQueryMs: 99999999 }).issues[0].message, /不能大于 600000/);
    assert.match(validateConfig({ readOnly: 'yes' }).issues[0].message, /必须是 true 或 false/);
    assert.match(validateConfig({ maxTables: 1.5 }).issues[0].message, /必须是整数/);
  });

  it('treats a missing config as an empty valid config', () => {
    assert.deepEqual(validateConfig(undefined), { value: {} });
    assert.deepEqual(validateConfig(null), { value: {} });
    assert.deepEqual(validateConfig({}).value, {});
  });

  it('drops blank strings and rejects non-objects', () => {
    assert.deepEqual(validateConfig({ profile: '   ' }).value, {});
    assert.match(validateConfig([1]).issues[0].message, /必须是一个对象/);
  });

  it('projects a JSON Schema the Config inspector can render', () => {
    const schema = configJsonSchema();
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.maxRows.type, 'number');
    assert.equal(schema.properties.maxRows.minimum, 1);
    assert.equal(schema.properties.maxRows.maximum, 10000);
    assert.equal(schema.properties.readOnly.type, 'boolean');
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      'connectionsFile', 'inlineCharBudget', 'llmModel', 'llmProvider', 'maxCellChars',
      'maxQueryMs', 'maxRows', 'maxTables', 'profile', 'readOnly',
    ].sort());
  });
});

describe('config wiring into apply', () => {
  it('accepts an empty config without throwing', () => {
    const { ctx } = fakeCtx();
    assert.doesNotThrow(() => apply(ctx, {}));
  });

  it('accepts a fully specified config without throwing', () => {
    const { ctx } = fakeCtx();
    assert.doesNotThrow(() => apply(ctx, {
      connectionsFile: 'C:/x/.dsh-mysql.json',
      profile: 'main',
      readOnly: true,
      maxRows: 100,
      maxQueryMs: 5000,
      maxCellChars: 200,
      inlineCharBudget: 20000,
      maxTables: 8,
      llmProvider: 'custom',
      llmModel: 'custom-model',
    }));
  });

  it('fails loudly when SQL generation has no model route', async () => {
    const { ctx, definitions } = fakeCtx();
    apply(ctx, {});
    const tool = definitions.find((definition) => definition.name === 'mysql_nl_query');
    await assert.rejects(
      () => tool.execute({ question: '有多少国家' }, { signal: new AbortController().signal, agent: { cwd: process.cwd() } }),
      (error) => /无法确定用于生成 SQL 的模型|连接配置文件|找不到/.test(error.message),
    );
  });

  it('rejects an empty question before touching any service', async () => {
    const { ctx, definitions } = fakeCtx();
    apply(ctx, {});
    const tool = definitions.find((definition) => definition.name === 'mysql_nl_query');
    await assert.rejects(
      () => tool.execute({ question: '   ' }, { signal: new AbortController().signal }),
      /question 不能为空/,
    );
  });
});
