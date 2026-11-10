/**
 * Contract check against the host's own schema compiler.
 *
 * `test/_vendor/dsh-json-schema.mjs` is the enforced JSON Schema subset extracted from the installed
 * DeepSeek Harness build (see `_vendor/build-oracle.mjs`).
 *
 * `ctx.tools.register()` inserts a definition **verbatim**: `ToolRuntime.register()` asserts only
 * `output.schema` and forwards `parameters` to the model untouched. Both fields are therefore raw
 * JSON Schema, and `parameters` must be object-rooted. Compiling an author property map (per-property
 * `required: true`) is `defineTool`'s job; this plugin deliberately imports no host package, so it
 * ships the compiled form by hand.
 *
 * Handing an author property map to `register()` is exactly what broke the first live installs: the
 * model received a parameters schema without `type`, and every request died with HTTP 400
 * `Invalid schema for function '…': schema must be a JSON Schema of 'type: "object"', got 'type: null'`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import { apply, assertObjectRootedParameters } from '../lib/plugin-mysql.js';

const oracle = await import(pathToFileURL(path.join(import.meta.dirname, '_vendor', 'dsh-json-schema.mjs')).href);

function definitions() {
  const registered = [];
  const ctx = {
    tools: { register: (definition) => { registered.push(definition); return () => {}; } },
    effect: () => () => {},
    on: () => () => {},
    get: () => undefined,
  };
  apply(ctx, {});
  return registered;
}

describe('host schema contract', () => {
  it('ships every parameter schema in the raw object-rooted form the registry forwards', () => {
    const tools = definitions();
    assert.equal(tools.length, 3);
    for (const tool of tools) {
      // The registry forwards this object to the model as-is, so the enforced raw subset must accept it
      // and the root must be an object — a root without `type` is the live 400.
      oracle.assertSupportedJsonSchema(tool.parameters);
      assert.equal(tool.parameters.type, 'object', `${tool.name}.parameters must be object-rooted`);
      assert.equal(typeof tool.parameters.properties, 'object', `${tool.name} needs a property map`);
      const required = tool.parameters.required;
      assert.ok(required === undefined || Array.isArray(required),
        `${tool.name}.parameters.required must be an array in raw JSON Schema`);
      for (const key of required ?? []) {
        assert.ok(Object.hasOwn(tool.parameters.properties, key),
          `${tool.name}.parameters.required names missing "${key}"`);
      }
    }
  });

  it('does not leave an author property map for the host to compile', () => {
    // Regression guard for the live failure: `defineTool` is the only host call site that compiles an
    // author map, and `register()` never calls it. If these schemas were author maps, the oracle's
    // author compiler would accept them — that is precisely the shape that must NOT be shipped.
    for (const tool of definitions()) {
      assert.throws(() => oracle.parameterSchemaSpecToJsonSchema(tool.parameters),
        /must be a value schema object/,
        `${tool.name}.parameters is still an author property map`);
      for (const node of Object.values(tool.parameters.properties)) {
        assert.equal(node.required, undefined, `${tool.name} still carries per-property required`);
      }
    }
  });

  it('refuses to register a tool whose parameters root is not an object schema', () => {
    // The load-time guard that turns a session-poisoning 400 into a clear plugin-load error.
    const good = { name: 'x', parameters: { type: 'object', properties: { ping: { type: 'boolean' } } } };
    assert.equal(assertObjectRootedParameters(good), good);
    assert.equal(assertObjectRootedParameters({ name: 'x', parameters: { type: 'object', properties: {} } }).name, 'x');
    for (const bad of [
      { name: 'x', parameters: { ping: { type: 'boolean', required: true } } },   // author property map
      { name: 'x', parameters: { type: 'object' } },                              // properties missing
      { name: 'x', parameters: { type: 'object', properties: [] } },              // properties not a record
      { name: 'x', parameters: { type: 'array', items: { type: 'string' } } },    // array root
      { name: 'x', parameters: null },
      { name: 'x' },
    ]) {
      assert.throws(() => assertObjectRootedParameters(bad), /must be object-rooted|object 根/,
        `${bad.name} with ${JSON.stringify(bad.parameters)} must be rejected at load time`);
    }
  });

  it('registers nothing when a definition would poison the request', () => {
    // End to end: the guard runs inside apply(), before the definition reaches the registry.
    const registered = [];
    const ctx = {
      tools: { register: (definition) => { registered.push(definition); return () => {}; } },
      effect: () => () => {},
      on: () => () => {},
      get: () => undefined,
    };
    apply(ctx, {});
    assert.equal(registered.length, 3);
    for (const definition of registered) assertObjectRootedParameters(definition);
  });

  it('keeps question required through the root required array', () => {
    const tools = definitions();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(byName.mysql_nl_query.parameters.required, ['question']);
    for (const name of ['mysql_list_connections', 'mysql_schema']) {
      assert.equal(byName[name].parameters.required, undefined, `${name} has no mandatory parameter`);
    }
  });

  it('passes every tool output schema through assertSupportedJsonSchema', () => {
    // This is the exact call tools.register makes before accepting a definition.
    for (const tool of definitions()) {
      oracle.assertSupportedJsonSchema(tool.output.schema);
      assert.equal(tool.output.schema.type, 'object');
      assert.equal(tool.output.schema.additionalProperties, false);
      assert.ok(Array.isArray(tool.output.schema.required));
    }
  });

  it('rejects a bare author schema that the registry would refuse', () => {
    // Sanity check that the oracle is actually enforcing, not silently passing anything.
    assert.throws(
      () => oracle.parameterSchemaSpecToJsonSchema({ type: 'object', properties: { a: { type: 'string' } } }),
      /must be a value schema object/,
    );
    assert.throws(
      () => oracle.assertSupportedJsonSchema({
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'string', required: true } },
      }),
      /required is not supported on type "string"/,
    );
  });

  it('validates real argument shapes through the raw parameter schema', () => {
    const tool = definitions().find((candidate) => candidate.name === 'mysql_nl_query');
    const violations = (args) => oracle.validateJsonSchemaValue(tool.parameters, args, '');
    assert.deepEqual(violations({ question: '有多少国家' }), []);
    assert.ok(violations({}).length > 0, 'question is required');
    assert.deepEqual(violations({ question: 'x', max_rows: 5, execute: false }), []);
    assert.ok(violations({ question: 'x', max_rows: '5' }).length > 0, 'max_rows must be a number');
    assert.ok(violations({ question: 42 }).length > 0, 'question must be a string');
    // The raw parameter root stays open (the compiler adds no `additionalProperties: false`), so an
    // extra key is tolerated rather than fatal. Recorded here so a change is noticed.
    assert.equal(tool.parameters.additionalProperties, undefined);
    assert.deepEqual(violations({ question: 'x', unexpected: 1 }), []);
  });

  it('accepts a real tool value through the output schema validator', () => {
    const tool = definitions().find((candidate) => candidate.name === 'mysql_nl_query');
    const value = {
      connection: 'local',
      database: 'world',
      sql: 'SELECT 1',
      executed: true,
      guard: '通过只读安全检查',
      statementKind: 'select',
      risk: '低',
      tablesUsed: ['country'],
      rowCount: 1,
      elapsedMs: 2,
      truncated: false,
      resultTable: '| a |\n| --- |\n| 1 |',
      reply: 'ok',
    };
    assert.deepEqual(oracle.validateJsonSchemaValue(tool.output.schema, value, 'value'), []);
    // A missing required field and an unknown field are both reported.
    const { reply, ...missing } = value;
    void reply;
    assert.ok(oracle.validateJsonSchemaValue(tool.output.schema, missing, 'value').length > 0);
    assert.ok(oracle.validateJsonSchemaValue(tool.output.schema, { ...value, extra: 1 }, 'value').length > 0);
    // Types are enforced.
    assert.ok(oracle.validateJsonSchemaValue(tool.output.schema, { ...value, rowCount: '1' }, 'value').length > 0);
  });
});
