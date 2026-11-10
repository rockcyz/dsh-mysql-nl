import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderConnection, renderResultTable, renderWriteHandoff, renderQuerySteps, summarizeResult } from '../lib/core/format.js';
import { explainSql } from '../lib/core/explain.js';

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

  it('reports the affected rows of a DML statement, not "0 rows"', () => {
    // A successful UPDATE returns no result set. Summarising it as "0 行" read like a no-op.
    assert.equal(summarizeResult({ ...result(), columns: [], rows: [], rowCount: 0, affectedRows: 2 }), '影响 2 行 / 7ms · world');
    assert.equal(
      summarizeResult({ ...result(), columns: [], rows: [], rowCount: 0, affectedRows: 1, insertId: 42 }),
      '影响 1 行，首个自增 ID 42 / 7ms · world',
    );
  });
});

describe('renderQuerySteps for DML', () => {
  const steps = (overrides) =>
    renderQuerySteps({
      connection: { id: 'local', host: '127.0.0.1', port: 3306 },
      database: 'world',
      readOnly: false,
      statementKind: 'update',
      tables: [{ schema: null, table: 'country' }],
      ...overrides,
    });

  it('shows the changed-row count instead of a row count', () => {
    const text = steps({ result: { ...result(), columns: [], rows: [], rowCount: 0, affectedRows: 2 } });
    assert.match(text, /影响 2 行/);
    assert.doesNotMatch(text, /返回 0 行/);
  });

  it('says when no row matched', () => {
    const text = steps({ result: { ...result(), columns: [], rows: [], rowCount: 0, affectedRows: 0 } });
    assert.match(text, /影响 0 行/);
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

describe('renderQuerySteps in hand-off mode', () => {
  const steps = (overrides) =>
    renderQuerySteps({
      connection: { id: 'local', host: '127.0.0.1', port: 3306 },
      database: 'jwgl',
      readOnly: true,
      statementKind: 'delete',
      tables: [{ schema: null, table: 'student' }],
      policy: 'handoff',
      result: { database: 'jwgl', sql: '', columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0 },
      ...overrides,
    });

  it('grades the statement instead of claiming a read-only pass', () => {
    const text = steps();
    // The old wording ("通过检查，只允许 SELECT...") would contradict handing a DELETE to the user.
    assert.match(text, /语句分级/);
    assert.match(text, /写操作/);
    assert.match(text, /不执行/);
    assert.doesNotMatch(text, /通过检查（只允许 SELECT/);
  });

  it('never claims an execution happened', () => {
    const text = steps();
    assert.doesNotMatch(text, /耗时/);
    assert.match(text, /未执行/);
  });

  it('does not append LIMIT or timeout steps to a write', () => {
    const text = steps({ limitApplied: 200, limitAdded: true, timeoutMs: 15000 });
    assert.doesNotMatch(text, /自动补 LIMIT/);
    assert.doesNotMatch(text, /MAX_EXECUTION_TIME/);
  });
});

describe('renderWriteHandoff', () => {
  const connection = { id: 'local', host: '127.0.0.1', port: 3306 };
  const handoff = (overrides) =>
    renderWriteHandoff({
      sql: 'DELETE FROM `student` WHERE `Sno` = 2000014',
      statementKind: 'delete',
      grade: 'dml',
      hasWhere: true,
      connection,
      database: 'jwgl',
      tables: [{ schema: null, table: 'student' }],
      explanation: explainSql('DELETE FROM `student` WHERE `Sno` = 2000014'),
      ...overrides,
    });

  it('states plainly that it will not execute, and where to run it instead', () => {
    const text = handoff();
    assert.match(text, /只生成，不执行/);
    assert.match(text, /插件不会执行它/);
    assert.match(text, /DBeaver/);
    assert.match(text, /MySQL Workbench/);
    assert.match(text, /在你的客户端执行/);
  });

  it('hands over a statement that runs as pasted', () => {
    // `cleanSql` strips the terminator; a hand-off has to put it back or the pasted SQL is incomplete.
    assert.match(handoff({ sql: 'DELETE FROM `t`' }), /```sql\nDELETE FROM `t`;\n```/);
    assert.match(handoff({ sql: 'DELETE FROM `t`;;;' }), /```sql\nDELETE FROM `t`;\n```/);
  });

  it('warns loudly when an UPDATE or DELETE has no WHERE', () => {
    const text = handoff({ sql: 'UPDATE `student` SET `Sage` = 20', statementKind: 'update', hasWhere: false });
    assert.match(text, /没有 WHERE 条件/);
    assert.match(text, /整张表/);
    // The "run the same WHERE as a SELECT first" advice is meaningless here; the whole table is the scope.
    assert.match(text, /SELECT COUNT\(\*\)/);
  });

  it('tells the user to snapshot the structure for DDL, not to run a SELECT', () => {
    const text = handoff({
      sql: 'ALTER TABLE `student` ADD COLUMN `phone` VARCHAR(20)',
      statementKind: 'alter',
      grade: 'ddl',
      hasWhere: false,
      explanation: explainSql('ALTER TABLE `student` ADD COLUMN `phone` VARCHAR(20)'),
    });
    assert.match(text, /结构变更（DDL）/);
    assert.match(text, /SHOW CREATE TABLE/);
  });

  it('includes the clause-by-clause teaching section and the target schema', () => {
    const text = handoff();
    assert.match(text, /### 语句讲解/);
    assert.match(text, /\*\*DELETE FROM\*\*/);
    assert.match(text, /\*\*WHERE\*\*/);
    assert.match(text, /`jwgl`/);
  });
});
