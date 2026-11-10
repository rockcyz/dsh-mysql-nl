import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderConnection, renderResultTable, summarizeResult } from '../lib/core/format.js';

/** @returns {import('../lib/core/types.js').QueryResult} */
function result(overrides = {}) {
  return {
    database: 'world',
    sql: 'SELECT Name, Population FROM country LIMIT 3',
    columns: ['Name', 'Population'],
    rows: [
      ['China', 1277558000],
      ['India', 1013662000],
      ['United States', 278357000],
    ],
    rowCount: 3,
    truncated: false,
    elapsedMs: 7,
    ...overrides,
  };
}

describe('renderResultTable', () => {
  it('renders a markdown table with a header and divider', () => {
    const text = renderResultTable(result());
    const lines = text.split('\n');
    assert.equal(lines[0], '| Name | Population |');
    assert.equal(lines[1], '| --- | --- |');
    assert.equal(lines.length, 5);
    assert.match(lines[2], /\| China \| 1277558000 \|/);
  });

  it('reports an empty row set distinctly from an empty column set', () => {
    assert.match(renderResultTable(result({ rows: [], rowCount: 0 })), /没有匹配的数据行/);
    assert.match(renderResultTable(result({ columns: [], rows: [], rowCount: 0 })), /没有返回结果集/);
  });

  it('escapes pipes and newlines and caps cell length', () => {
    const text = renderResultTable(result({ columns: ['a'], rows: [['x|y\nz']], rowCount: 1 }));
    assert.match(text, /x\\\|y\\nz/);
    const long = renderResultTable(result({ columns: ['a'], rows: [['y'.repeat(500)]], rowCount: 1 }));
    assert.ok(long.includes('…'));
    assert.ok(!long.includes('y'.repeat(200)));
  });

  it('renders NULL for null and undefined cells', () => {
    const text = renderResultTable(result({ columns: ['a', 'b'], rows: [[null, undefined]], rowCount: 1 }));
    assert.match(text, /\| NULL \| NULL \|/);
  });

  it('truncates rows at maxRows and says how many were hidden', () => {
    const rows = Array.from({ length: 80 }, (_, index) => [`r${index}`, index]);
    const text = renderResultTable(result({ rows, rowCount: 80 }), { maxRows: 10 });
    assert.match(text, /另有 70 行未显示/);
    assert.equal(text.split('\n').length, 2 + 10 + 1);
  });

  it('renders JSON for object cells', () => {
    const text = renderResultTable(result({ columns: ['o'], rows: [[{ a: 1 }]], rowCount: 1 }));
    assert.match(text, /\{"a":1\}/);
  });
});

describe('summarizeResult', () => {
  it('reports rows, elapsed time, database and truncation', () => {
    assert.equal(summarizeResult(result()), '3 行 / 7ms · world');
    assert.equal(summarizeResult(result({ truncated: true })), '3 行 / 7ms · world（已截断）');
  });
});

describe('renderConnection', () => {
  it('never reveals the password but says whether one is configured', () => {
    const text = renderConnection({ id: 'local', user: 'root', host: '127.0.0.1', port: 3306, password: 'hunter2', database: 'sakila' });
    assert.ok(!text.includes('hunter2'));
    assert.match(text, /密码 已配置/);
    assert.match(text, /root@127\.0\.0\.1:3306/);
    assert.match(text, /只读/);
  });

  it('marks the default connection and says when no password is set', () => {
    const text = renderConnection({ id: 'main', user: 'app', host: 'db', port: 3307, password: '', readOnly: false, maxRows: 50, maxQueryMs: 5000 }, { isDefault: true });
    assert.match(text, /\*\*main\*\*（默认）/);
    assert.match(text, /密码 空/);
    assert.match(text, /读写/);
    assert.match(text, /最多 50 行 \/ 5000ms/);
  });
});
