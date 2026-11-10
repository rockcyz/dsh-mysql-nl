import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateSql, renderCatalogIndex, selectTables } from '../lib/core/nl.js';

/** A catalog shaped exactly like catalog.js returns. */
const CATALOG = {
  database: 'world',
  detailed: false,
  tables: [
    { name: 'city', rowEstimate: 4079, comment: '城市', columns: [], indexes: [], foreignKeys: [] },
    { name: 'country', rowEstimate: 239, comment: '国家', columns: [], indexes: [], foreignKeys: [] },
    { name: 'countrylanguage', rowEstimate: 984, comment: '', columns: [], indexes: [], foreignKeys: [] },
  ],
};

const DETAIL = {
  database: 'world',
  detailed: true,
  tables: [
    {
      name: 'city',
      rowEstimate: 4079,
      comment: '城市',
      columns: [
        { name: 'ID', type: 'int', nullable: false, isPrimaryKey: true },
        { name: 'Name', type: 'char(35)', nullable: false, isPrimaryKey: false },
        { name: 'CountryCode', type: 'char(3)', nullable: false, isPrimaryKey: false },
        { name: 'Population', type: 'int', nullable: false, isPrimaryKey: false },
      ],
      indexes: [],
      foreignKeys: [],
    },
    {
      name: 'country',
      rowEstimate: 239,
      comment: '国家',
      columns: [
        { name: 'Code', type: 'char(3)', nullable: false, isPrimaryKey: true },
        { name: 'Name', type: 'char(52)', nullable: false, isPrimaryKey: false },
        { name: 'Continent', type: 'enum(...)', nullable: false, isPrimaryKey: false },
      ],
      indexes: [],
      foreignKeys: [],
    },
  ],
};

/** Records every call so assertions can inspect the prompt the model actually received. */
function fakeLoader(calls) {
  return {
    async loadCatalog(_conn, database) {
      calls.push(['loadCatalog', database]);
      return CATALOG;
    },
    async loadTableDetails(_conn, database, tables) {
      calls.push(['loadTableDetails', database, tables]);
      if (Array.isArray(tables)) {
        return { ...DETAIL, tables: DETAIL.tables.filter((table) => tables.includes(table.name)) };
      }
      return DETAIL;
    },
  };
}

const CONN = { id: 'local', host: '127.0.0.1', database: 'world' };

describe('renderCatalogIndex', () => {
  it('lists every table with its estimate and comment', () => {
    const text = renderCatalogIndex(CATALOG);
    assert.match(text, /## 数据库 world（共 3 张表）/);
    assert.match(text, /- city ≈4079行 -- 城市/);
    assert.match(text, /- countrylanguage ≈984行/);
  });
});

describe('selectTables', () => {
  it('parses a JSON table list and keeps only known names', async () => {
    const llm = async () => '```json\n{"tables":["city","country","nope"],"reason":"需要城市与国家"}\n```';
    const picked = await selectTables({ catalog: CATALOG, question: '城市数量', llm, provider: 'p', model: 'm' });
    assert.deepEqual(picked.tables, ['city', 'country']);
    assert.equal(picked.strategy, 'llm');
    assert.equal(picked.reason, '需要城市与国家');
  });

  it('falls back to the catalog head when the model answers nothing usable', async () => {
    const llm = async () => '抱歉，我无法判断。';
    const picked = await selectTables({ catalog: CATALOG, question: 'x', llm, provider: 'p', model: 'm', maxTables: 2 });
    assert.deepEqual(picked.tables, ['city', 'country']);
  });

  it('parses a bare list when the model ignores the JSON instruction', async () => {
    const llm = async () => '需要 countrylanguage 表';
    const picked = await selectTables({ catalog: CATALOG, question: 'x', llm, provider: 'p', model: 'm' });
    assert.deepEqual(picked.tables, ['countrylanguage']);
  });

  it('returns the empty result for an empty catalog without calling the model', async () => {
    let called = false;
    const llm = async () => {
      called = true;
      return '{}';
    };
    const picked = await selectTables({ catalog: { database: 'd', tables: [], detailed: false }, question: 'x', llm, provider: 'p', model: 'm' });
    assert.deepEqual(picked.tables, []);
    assert.equal(called, false);
  });
});

describe('generateSql', () => {
  it('inlines the full schema when it fits the budget and sends real column names', async () => {
    const calls = [];
    let seenPrompt = '';
    const llm = async (options) => {
      seenPrompt = options.prompt;
      return '```sql\nSELECT Name, Population FROM city ORDER BY Population DESC LIMIT 10\n```';
    };
    const out = await generateSql({
      conn: CONN,
      loader: fakeLoader(calls),
      database: 'world',
      question: '人口最多的10个城市',
      llm,
      provider: 'p',
      model: 'm',
    });
    assert.equal(out.sql, 'SELECT Name, Population FROM city ORDER BY Population DESC LIMIT 10');
    assert.equal(out.stage, 'full-schema');
    assert.deepEqual(out.selection.tables, ['city', 'country', 'countrylanguage']);
    assert.match(seenPrompt, /Population/);
    assert.match(seenPrompt, /用户需求：人口最多的10个城市/);
    // one catalog pass plus one detail pass
    assert.deepEqual(calls.map((call) => call[0]), ['loadCatalog', 'loadTableDetails']);
    assert.equal(calls[1][2], undefined, 'full-detail pass must not filter tables');
  });

  it('honours hint tables and still loads real column detail for them', async () => {
    const calls = [];
    const llm = async () => 'SELECT Code, Name FROM country LIMIT 5';
    const out = await generateSql({
      conn: CONN,
      loader: fakeLoader(calls),
      database: 'world',
      question: '国家代码和名称',
      hintTables: ['country'],
      llm,
      provider: 'p',
      model: 'm',
    });
    assert.equal(out.stage, 'hint-schema');
    assert.deepEqual(out.selection, { strategy: 'hint', tables: ['country'] });
    assert.deepEqual(calls[1], ['loadTableDetails', 'world', ['country']]);
  });

  it('ignores hint table names that do not exist in the database', async () => {
    const calls = [];
    const llm = async () => 'SELECT 1 LIMIT 1';
    await generateSql({
      conn: CONN,
      loader: fakeLoader(calls),
      database: 'world',
      question: 'x',
      hintTables: ['not_a_table'],
      llm,
      provider: 'p',
      model: 'm',
    });
    // no hint pass happened, so the second call is the full-detail pass with no filter
    assert.deepEqual(calls[1], ['loadTableDetails', 'world', undefined]);
  });

  it('runs table selection first when the catalog exceeds the inline budget', async () => {
    const calls = [];
    const prompts = [];
    const llm = async (options) => {
      prompts.push(options.prompt);
      if (prompts.length === 1) return '{"tables":["country"],"reason":"只需要国家表"}';
      return 'SELECT Name FROM country LIMIT 3';
    };
    const out = await generateSql({
      conn: CONN,
      loader: fakeLoader(calls),
      database: 'world',
      question: '列出国家',
      llm,
      provider: 'p',
      model: 'm',
      inlineCharBudget: 40,
    });
    assert.equal(out.stage, 'selected-schema');
    assert.ok(out.selection.tables.includes('country'));
    assert.equal(prompts.length, 2, 'selection then generation');
    assert.match(prompts[0], /可用表清单/);
    assert.deepEqual(calls[1][2], out.selection.tables);
  });

  it('sends the failing SQL and the server error when repairing', async () => {
    const calls = [];
    let prompt = '';
    const llm = async (options) => {
      prompt = options.prompt;
      return 'SELECT Name FROM city LIMIT 5';
    };
    await generateSql({
      conn: CONN,
      loader: fakeLoader(calls),
      database: 'world',
      question: '城市',
      llm,
      provider: 'p',
      model: 'm',
      prior: { sql: 'SELECT Nmae FROM city', error: "Unknown column 'Nmae' in 'field list'" },
    });
    assert.match(prompt, /上一次生成的 SQL 执行失败/);
    assert.match(prompt, /Unknown column 'Nmae'/);
    assert.match(prompt, /SELECT Nmae FROM city/);
  });

  it('throws EMPTY_SQL when the model returns nothing', async () => {
    await assert.rejects(
      generateSql({
        conn: CONN,
        loader: fakeLoader([]),
        database: 'world',
        question: 'x',
        llm: async () => '   ',
        provider: 'p',
        model: 'm',
      }),
      /EMPTY_SQL/,
    );
  });

  it('rejects a two-statement answer', async () => {
    await assert.rejects(
      generateSql({
        conn: CONN,
        loader: fakeLoader([]),
        database: 'world',
        question: 'x',
        llm: async () => 'SELECT 1; DROP TABLE city',
        provider: 'p',
        model: 'm',
      }),
      /无法识别/,
    );
  });

  it('refuses to guess when the database has no tables', async () => {
    await assert.rejects(
      generateSql({
        conn: CONN,
        loader: { async loadCatalog() { return { database: 'd', tables: [], detailed: false }; }, async loadTableDetails() { return { database: 'd', tables: [], detailed: true }; } },
        database: 'd',
        question: 'x',
        llm: async () => 'SELECT 1',
        provider: 'p',
        model: 'm',
      }),
      /没有任何表/,
    );
  });
});
