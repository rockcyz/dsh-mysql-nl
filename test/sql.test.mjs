import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  analyze,
  classify,
  cleanSql,
  guard,
  hasExecutableComment,
  maskLiterals,
  referencedTables,
  splitStatements,
  withRowLimit,
} from '../lib/core/sql.js';

describe('cleanSql', () => {
  it('strips a whole-response sql fence', () => {
    assert.equal(cleanSql('```sql\nSELECT 1\n```'), 'SELECT 1');
  });

  it('strips a bare fence', () => {
    assert.equal(cleanSql('```\nSELECT 1\n```'), 'SELECT 1');
  });

  it('keeps the widest fenced block when several exist', () => {
    const out = cleanSql('说明：\n```sql\nSELECT a FROM t\n```\n再补充：\n```\nSELECT b\n```');
    assert.equal(out, 'SELECT a FROM t');
  });

  it('drops a leading label in English and Chinese', () => {
    assert.equal(cleanSql('SQL: SELECT 1'), 'SELECT 1');
    assert.equal(cleanSql('查询语句：SELECT 1'), 'SELECT 1');
  });

  it('collapses whitespace and drops trailing semicolons', () => {
    assert.equal(cleanSql('SELECT\n  a,\n  b\nFROM t;;'), 'SELECT a, b FROM t');
  });

  it('returns an empty string for non-strings', () => {
    assert.equal(cleanSql(undefined), '');
    assert.equal(cleanSql(42), '');
  });

  it('does not split a semicolon inside a string literal', () => {
    assert.equal(cleanSql("SELECT 'a;b' AS x"), "SELECT 'a;b' AS x");
  });
});

describe('splitStatements', () => {
  it('splits two real statements', () => {
    assert.deepEqual(splitStatements('SELECT 1; SELECT 2'), ['SELECT 1', 'SELECT 2']);
  });

  it('ignores terminators inside literals and quoted identifiers', () => {
    assert.deepEqual(splitStatements("SELECT ';' AS a, `we;ird` FROM t;"), ["SELECT ';' AS a, `we;ird` FROM t"]);
  });

  it('drops a line comment that contains a terminator', () => {
    assert.deepEqual(splitStatements('SELECT 1 -- ;\n'), ['SELECT 1']);
  });

  it('ignores a terminator inside a quoted string with an escaped quote', () => {
    assert.deepEqual(splitStatements("SELECT 'it\\';s' AS a;"), ["SELECT 'it\\';s' AS a"]);
  });
});

describe('classify', () => {
  it('accepts read statements', () => {
    assert.equal(classify('SELECT 1').kind, 'select');
    // A CTE reports the statement it actually runs, which for a plain CTE read is `select`.
    assert.equal(classify('with x as (select 1) select * from x').kind, 'select');
    assert.equal(classify('SHOW TABLES').kind, 'show');
    assert.equal(classify('DESCRIBE country').kind, 'describe');
    assert.equal(classify('EXPLAIN SELECT 1').kind, 'select');
  });

  it('rejects empty input', () => {
    assert.equal(classify('').ok, false);
    assert.equal(classify('   ').ok, false);
  });

  it('rejects multiple statements', () => {
    const verdict = classify('SELECT 1; DROP TABLE t');
    assert.equal(verdict.ok, false);
    assert.equal(verdict.kind, 'multiple');
  });

  it('flags write statements by keyword', () => {
    assert.equal(classify('DELETE FROM t').kind, 'delete');
    assert.equal(classify('update t set a=1').kind, 'update');
  });
  it('classifies a CTE by the statement it really runs', () => {
    assert.equal(classify('WITH c AS (SELECT 1) SELECT * FROM country').kind, 'select');
    assert.equal(classify('WITH RECURSIVE c AS (SELECT 1 UNION SELECT 2) SELECT * FROM c').kind, 'select');
    assert.equal(classify('WITH c AS (SELECT 1 AS n) DELETE FROM country').kind, 'delete');
    assert.equal(classify('WITH c AS (SELECT 1) UPDATE country SET Name = Name').kind, 'update');
    assert.equal(classify('WITH a AS (SELECT 1), b AS (SELECT 2) INSERT INTO t SELECT * FROM a').kind, 'insert');
  });

  it('reports an unclosed WITH clause instead of guessing', () => {
    assert.equal(classify('WITH c AS (SELECT 1').ok, false);
  });

  it('classifies EXPLAIN by the statement it wraps', () => {
    assert.equal(classify('EXPLAIN SELECT 1').kind, 'select');
    assert.equal(classify('EXPLAIN DELETE FROM country').kind, 'delete');
    assert.equal(classify('EXPLAIN ANALYZE SELECT 1').kind, 'explain-analyze');
    assert.equal(classify('DESCRIBE country').kind, 'describe');
  });
});

describe('guard', () => {
  it('refuses a CTE that writes, not just a leading write keyword', () => {
    for (const sql of [
      'WITH c AS (SELECT 1 AS n) DELETE FROM country WHERE Code = "__x__"',
      'WITH c AS (SELECT 1) UPDATE country SET Name = Name WHERE Code = "__x__"',
      'WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c',
    ]) {
      const verdict = guard(sql, { readOnly: true });
      assert.equal(verdict.ok, false, sql);
      assert.match(verdict.reason ?? '', /只读模式/);
    }
  });

  it('refuses MySQL executable comments, which the masker cannot see into', () => {
    for (const sql of [
      'SELECT 1 /*!50000 INTO OUTFILE "/tmp/x" */',
      'SELECT 1 /*! DELETE FROM country */',
      '/*!50000 DELETE */ FROM country',
    ]) {
      assert.equal(guard(sql, { readOnly: true }).ok, false, sql);
    }
    assert.equal(hasExecutableComment('SELECT /*! STRAIGHT_JOIN */ a FROM t'), true);
    assert.equal(hasExecutableComment('SELECT a FROM t /* plain */'), false);
  });

  it('refuses EXPLAIN ANALYZE, which executes the statement', () => {
    assert.equal(guard('EXPLAIN ANALYZE SELECT * FROM country', { readOnly: true }).ok, false);
  });

  it('allows a plain CTE select and a plain EXPLAIN', () => {
    assert.equal(guard('WITH c AS (SELECT 1) SELECT * FROM c', { readOnly: true }).ok, true);
    assert.equal(guard('EXPLAIN SELECT * FROM country', { readOnly: true }).ok, true);
  });
  it('allows selects in read-only mode', () => {
    assert.equal(guard('SELECT * FROM film', { readOnly: true }).ok, true);
  });

  it('rejects every write statement in read-only mode with a helpful message', () => {
    for (const sql of ['DELETE FROM film', 'UPDATE film SET title=1', 'DROP TABLE film', 'TRUNCATE film', 'CALL p()']) {
      const verdict = guard(sql, { readOnly: true });
      assert.equal(verdict.ok, false, `${sql} should be refused`);
      assert.match(verdict.reason ?? '', /只读模式/);
    }
  });

  it('allows writes when read-only is off', () => {
    assert.equal(guard('DELETE FROM film WHERE film_id = -1', { readOnly: false }).ok, true);
  });

  it('refuses locking reads and file writes', () => {
    for (const sql of [
      'SELECT * FROM film FOR UPDATE',
      'SELECT * FROM film LOCK IN SHARE MODE',
      'SELECT * FROM film INTO OUTFILE "/tmp/x"',
      'SELECT LOAD_FILE("/etc/passwd")',
    ]) {
      assert.equal(guard(sql, { readOnly: true }).ok, false, sql);
    }
  });

  it('is not fooled by literals that contain forbidden keywords', () => {
    assert.equal(guard("SELECT 'for update' AS note FROM film", { readOnly: true }).ok, true);
    assert.equal(guard("SELECT 'delete from film' AS note", { readOnly: true }).ok, true);
  });
});

describe('withRowLimit', () => {
  it('appends a limit to a select without one', () => {
    assert.equal(withRowLimit('SELECT * FROM film', 25), 'SELECT * FROM film LIMIT 25');
  });

  it('keeps an existing limit', () => {
    assert.equal(withRowLimit('SELECT * FROM film LIMIT 5', 25), 'SELECT * FROM film LIMIT 5');
    assert.equal(withRowLimit('SELECT * FROM film limit 5 offset 2', 25), 'SELECT * FROM film limit 5 offset 2');
  });

  it('does not add a limit to an aggregate-free non-select', () => {
    assert.equal(withRowLimit('SHOW TABLES', 25), 'SHOW TABLES');
    assert.equal(withRowLimit('DELETE FROM film', 25), 'DELETE FROM film');
  });

  it('ignores a LIMIT that only appears inside a literal', () => {
    assert.equal(withRowLimit("SELECT 'limit 5' AS note FROM film", 25), "SELECT 'limit 5' AS note FROM film LIMIT 25");
  });

  it('never rewrites a locking read', () => {
    assert.equal(withRowLimit('SELECT * FROM film FOR UPDATE', 25), 'SELECT * FROM film FOR UPDATE');
  });
});

describe('analyze', () => {
  it('reports tables, joins, aggregates and risk', () => {
    const report = analyze('SELECT c.name, COUNT(*) FROM city c JOIN country k ON c.country_code = k.code GROUP BY c.name');
    assert.equal(report.statementKind, 'select');
    assert.deepEqual(report.touchesTables, ['city', 'country']);
    assert.equal(report.hasJoin, true);
    assert.equal(report.hasAggregate, true);
    assert.equal(report.estimatedRisk, '低');
  });

  it('marks a write as high risk', () => {
    assert.equal(analyze('UPDATE film SET title = "x"').estimatedRisk, '高');
  });

  it('unwraps backticks and schema qualifiers', () => {
    assert.deepEqual(analyze('SELECT * FROM `sakila`.`film`').touchesTables, ['film']);
  });
});

describe('maskLiterals', () => {
  it('preserves length while blanking literals and comments', () => {
    const sql = "SELECT 'abc' -- note\nFROM t";
    const masked = maskLiterals(sql);
    assert.equal(masked.length, sql.length);
    assert.ok(!masked.includes('abc'));
    assert.ok(!masked.includes('note'));
    assert.ok(masked.includes('SELECT'));
    assert.ok(masked.includes('FROM'));
  });
});

describe('referencedTables', () => {
  it('keeps the schema qualifier that analyze() drops', () => {
    // This is the distinction the teaching trace depends on: `jwgl.student` reads that schema no
    // matter what the connection's DATABASE() is; `student` resolves against DATABASE().
    assert.deepEqual(referencedTables('SELECT * FROM jwgl.student'), [{ schema: 'jwgl', table: 'student' }]);
    assert.deepEqual(referencedTables('SELECT * FROM student'), [{ schema: null, table: 'student' }]);
  });

  it('handles backticked and spaced qualifiers', () => {
    assert.deepEqual(referencedTables('SELECT * FROM `jwgl`.`student`'), [{ schema: 'jwgl', table: 'student' }]);
    assert.deepEqual(referencedTables('SELECT * FROM jwgl . student'), [{ schema: 'jwgl', table: 'student' }]);
  });

  it('collects every table from FROM and JOIN, in source order, without duplicates', () => {
    const sql = 'SELECT 1 FROM jwgl.sc JOIN jwgl.student ON student.Sno = sc.Sno JOIN jwgl.sc s2 ON s2.Sno = sc.Sno';
    assert.deepEqual(referencedTables(sql), [
      { schema: 'jwgl', table: 'sc' },
      { schema: 'jwgl', table: 'student' },
    ]);
  });

  it('ignores aliases and column qualifiers, which are not table references', () => {
    assert.deepEqual(referencedTables('SELECT s.Sno FROM jwgl.student s WHERE s.Sno > 0'), [
      { schema: 'jwgl', table: 'student' },
    ]);
  });

  it('ignores table names inside literals and comments', () => {
    assert.deepEqual(referencedTables("SELECT 'FROM secret.table' AS x FROM jwgl.student -- JOIN fake.tbl"), [
      { schema: 'jwgl', table: 'student' },
    ]);
  });

  it('does not fall for a comma-separated FROM list', () => {
    assert.deepEqual(referencedTables('SELECT 1 FROM jwgl.a, jwgl.b'), [
      { schema: 'jwgl', table: 'a' },
      { schema: 'jwgl', table: 'b' },
    ]);
  });

  it('returns an empty list for statements that read no table', () => {
    assert.deepEqual(referencedTables('SELECT 1'), []);
    assert.deepEqual(referencedTables(''), []);
    assert.deepEqual(referencedTables(undefined), []);
  });
});
