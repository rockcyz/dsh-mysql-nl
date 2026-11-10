/**
 * Tests for the deterministic SQL explainer and the teaching renderers.
 *
 * The explainer is the part of the student-facing output that must never be wrong: it runs on every
 * query in both the DSH plugin and the Agent Skill CLI, with no model in the loop to correct it.
 * The adversarial cases below (keywords inside literals/comments, nested subqueries, CTEs) are the
 * ones that a naive regex splitter gets wrong.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { explainSql } from '../lib/core/explain.js';
import { renderExplanation, renderQuerySteps } from '../lib/core/format.js';

/** @param {string} sql @returns {Record<string, string>} clause key -> text */
function clausesOf(sql) {
  return Object.fromEntries(explainSql(sql).clauses.map((clause) => [clause.key, clause.text]));
}

describe('explainSql — clause splitting', () => {
  it('splits a full SELECT into its clauses in source order', () => {
    const sql =
      'SELECT k.Name, COUNT(*) AS city_count FROM city c JOIN country k ON c.CountryCode = k.Code ' +
      "WHERE k.Continent = 'Asia' GROUP BY k.Name HAVING COUNT(*) > 5 ORDER BY city_count DESC LIMIT 10";
    assert.deepEqual(explainSql(sql).clauses.map((clause) => clause.key), [
      'select',
      'from',
      'join',
      'where',
      'group',
      'having',
      'order',
      'limit',
    ]);
    assert.equal(clausesOf(sql).limit, '10');
    assert.equal(clausesOf(sql).group, 'k.Name');
    assert.equal(clausesOf(sql).where, "k.Continent = 'Asia'");
  });

  it('keeps a clause keyword that appears inside a string literal out of the clause list', () => {
    const sql = "SELECT Name FROM country WHERE GovernmentForm = 'from where group by order by limit'";
    const keys = explainSql(sql).clauses.map((clause) => clause.key);
    assert.deepEqual(keys, ['select', 'from', 'where']);
    // The literal survives verbatim, because clause text is sliced out of the original statement.
    assert.match(clausesOf(sql).where, /'from where group by order by limit'/);
  });

  it('ignores keywords hidden in a trailing line comment', () => {
    const sql = 'SELECT 1 AS a FROM city -- where group by limit\nLIMIT 5';
    assert.deepEqual(explainSql(sql).clauses.map((clause) => clause.key), ['select', 'from', 'limit']);
  });

  it('does not treat a subquery inside parentheses as a top-level clause', () => {
    const sql = 'SELECT (SELECT COUNT(*) FROM city) AS n FROM country LIMIT 1';
    const keys = explainSql(sql).clauses.map((clause) => clause.key);
    assert.deepEqual(keys, ['select', 'from', 'limit']);
    assert.equal(clausesOf(sql).from, 'country');
    assert.equal(explainSql(sql).hasSubquery, true);
  });

  it('handles a CTE, treating the main SELECT as the outer query', () => {
    const sql = 'WITH big AS (SELECT Name FROM country WHERE Population > 1e6) SELECT Name FROM big ORDER BY Name';
    const keys = explainSql(sql).clauses.map((clause) => clause.key);
    assert.deepEqual(keys, ['with', 'select', 'from', 'order']);
    assert.equal(explainSql(sql).kind, 'with');
    assert.equal(clausesOf(sql).from, 'big');
  });

  it('recognises every JOIN flavour as one clause', () => {
    for (const join of ['JOIN', 'INNER JOIN', 'LEFT JOIN', 'LEFT OUTER JOIN', 'RIGHT JOIN', 'CROSS JOIN']) {
      const sql = `SELECT a.x FROM a ${join} b ON a.id = b.id`;
      assert.deepEqual(explainSql(sql).clauses.map((clause) => clause.key), ['select', 'from', 'join'], join);
    }
  });

  it('keeps the ON condition attached to its JOIN rather than emitting a clause of its own', () => {
    const sql = 'SELECT a.x FROM a JOIN b ON a.id = b.id JOIN c ON b.id = c.id WHERE a.x > 1';
    assert.deepEqual(explainSql(sql).clauses.map((clause) => clause.key), ['select', 'from', 'join', 'join', 'where']);
  });

  it('degrades gracefully on an unparseable statement instead of throwing', () => {
    for (const sql of ['SHOW TABLES', 'SELECT', '', 'not sql at all', '(((']) {
      assert.doesNotThrow(() => explainSql(sql), sql);
    }
    assert.deepEqual(explainSql('SHOW TABLES').clauses, []);
    assert.equal(explainSql('').kind, 'other');
  });

  it('never throws on non-string input', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      assert.doesNotThrow(() => explainSql(value));
    }
  });
});

describe('explainSql — joins and aggregates', () => {
  it('extracts table, alias and ON condition from each join', () => {
    const sql = 'SELECT 1 FROM `city` c LEFT JOIN `country` k ON `c`.`CountryCode` = `k`.`Code`';
    const { joins } = explainSql(sql);
    assert.equal(joins.length, 1);
    // The join clause names the table being *brought in*; `city` is the FROM table.
    assert.equal(joins[0].table, 'country');
    assert.equal(joins[0].alias, 'k');
    assert.match(joins[0].on, /CountryCode/);
    // Backticked identifiers keep their inner text in the FROM clause too.
    assert.equal(clausesOf(sql).from, '`city` c');
  });

  it('reports a join with no ON condition, which is how a cartesian product happens', () => {
    const sql = 'SELECT a.Name, b.Name FROM city a JOIN country b';
    const { joins, hints } = explainSql(sql);
    assert.equal(joins[0].on, undefined);
    assert.ok(hints.some((hint) => /笛卡尔积/.test(hint)));
  });

  it('detects the aggregate functions in use', () => {
    const sql = 'SELECT CountryCode, COUNT(*), SUM(Population), AVG(Population) FROM city GROUP BY CountryCode';
    assert.deepEqual(explainSql(sql).aggregates, ['COUNT', 'SUM', 'AVG']);
  });

  it('does not treat an aggregate name inside a literal as an aggregate', () => {
    assert.deepEqual(explainSql("SELECT 'COUNT(' AS note FROM city").aggregates, []);
  });
});

describe('explainSql — teaching hints', () => {
  it('warns that SELECT * returns every column', () => {
    assert.ok(explainSql('SELECT * FROM city').hints.some((hint) => hint.includes('SELECT *')));
  });

  it('does not fire the SELECT * hint for an explicit column list', () => {
    assert.equal(explainSql('SELECT ID, Name FROM city').hints.some((hint) => hint.includes('SELECT *')), false);
  });

  it('does not mistake a multiplication sign for SELECT *', () => {
    // `ROUND(Population / total * 100, 2)` is a percentage calculation. The old hint test matched
    // any star, so it told students their explicit column list was `SELECT *`.
    const sql = 'SELECT ROUND(Population / continent_total * 100, 2) AS pct FROM country';
    assert.equal(explainSql(sql).hints.some((hint) => hint.includes('SELECT *')), false);
  });

  it('does not mistake COUNT(*) for SELECT *', () => {
    assert.equal(explainSql('SELECT COUNT(*) AS n FROM country').hints.some((hint) => hint.includes('SELECT *')), false);
    assert.equal(
      explainSql('SELECT CountryCode, COUNT(*), SUM(Population) FROM city GROUP BY CountryCode')
        .hints.some((hint) => hint.includes('SELECT *')),
      false,
    );
  });

  it('still fires for every real wildcard form', () => {
    for (const sql of [
      'SELECT * FROM city',
      'SELECT DISTINCT * FROM city',
      'SELECT c.*, k.Name FROM city c JOIN country k ON c.CountryCode = k.Code',
    ]) {
      assert.ok(explainSql(sql).hints.some((hint) => hint.includes('SELECT *')), `${sql} should warn`);
    }
  });

  it('ignores a star inside a string literal', () => {
    assert.equal(explainSql("SELECT 'a, *' AS label, ID FROM city").hints.some((hint) => hint.includes('SELECT *')), false);
  });

  it('does not call a CTE body a subquery', () => {
    // `WITH x AS (SELECT …)` declares a named result set; the WITH clause explains it. Reporting a
    // subquery here contradicts the explanation right above it.
    const sql =
      'WITH continent_rank AS (SELECT Continent, Name, Population, SUM(Population) OVER (PARTITION BY Continent) AS t ' +
      'FROM country) SELECT Continent, t FROM continent_rank';
    const out = explainSql(sql);
    assert.equal(out.hasSubquery, false);
    assert.equal(out.hints.some((hint) => hint.includes('子查询')), false);
  });

  it('still reports a real subquery, including one inside a CTE body', () => {
    assert.ok(explainSql('SELECT Name FROM country WHERE Code IN (SELECT CountryCode FROM city)').hints.some((hint) => hint.includes('子查询')));
    const nested = explainSql('WITH x AS (SELECT a FROM t WHERE a IN (SELECT b FROM u)) SELECT a FROM x');
    assert.equal(nested.hasSubquery, true);
    assert.ok(nested.hints.some((hint) => hint.includes('子查询')));
  });

  it('still warns about SELECT * on the outer query of a CTE', () => {
    // The fix must not silence the hint where the wildcard really is: two independent detections.
    const sql = 'WITH x AS (SELECT Code FROM country) SELECT * FROM x';
    const out = explainSql(sql);
    assert.ok(out.hints.some((hint) => hint.includes('SELECT *')));
    assert.equal(out.hasSubquery, false);
  });

  it('catches an aggregate used in WHERE, which is the classic beginner mistake', () => {
    const sql = 'SELECT CountryCode FROM city WHERE COUNT(*) > 5 GROUP BY CountryCode';
    assert.ok(explainSql(sql).hints.some((hint) => /HAVING/.test(hint)));
  });

  it('flags ORDER BY without LIMIT', () => {
    assert.ok(explainSql('SELECT Name FROM country ORDER BY Name').hints.some((hint) => /没有 LIMIT/.test(hint)));
  });

  it('reports DISTINCT and subqueries as notes to explain', () => {
    const { hints } = explainSql('SELECT DISTINCT (SELECT 1 FROM city) AS x FROM country');
    assert.ok(hints.some((hint) => hint.includes('DISTINCT')));
    assert.ok(hints.some((hint) => hint.includes('子查询')));
  });

  it('emits no hints for a clean, fully explicit query', () => {
    const sql = 'SELECT Name, Population FROM country WHERE Continent = \'Asia\' ORDER BY Population DESC LIMIT 5';
    assert.deepEqual(explainSql(sql).hints, []);
  });
});

describe('renderQuerySteps', () => {
  const base = {
    connection: { id: 'local', host: '127.0.0.1', port: 3306 },
    database: 'world',
    readOnly: true,
    statementKind: 'select',
    tables: ['city', 'country'],
    result: { database: 'world', sql: '', columns: [], rows: [], rowCount: 5, truncated: false, elapsedMs: 12 },
  };

  it('states the target, the policy, the tables involved and the outcome', () => {
    const text = renderQuerySteps(base);
    assert.match(text, /127\.0\.0\.1:3306/);
    assert.match(text, /只读模式/);
    assert.match(text, /city、country/);
    assert.match(text, /12ms，返回 5 行/);
  });

  it('does not report the connection default database as the query target', () => {
    // Regression: the trace used to read `127.0.0.1:3306/world` for a `jwgl.…` query, because it
    // printed the connection's DATABASE() instead of the schema the statement named.
    const text = renderQuerySteps({ ...base, tables: [{ schema: 'jwgl', table: 'student' }] });
    assert.doesNotMatch(text, /3306\/world/);
    assert.match(text, /jwgl\.student/);
    assert.match(text, /不受连接默认库/);
  });

  it('says which tables fall back to the connection default when the list is mixed', () => {
    const text = renderQuerySteps({
      ...base,
      tables: [{ schema: 'jwgl', table: 'student' }, { schema: null, table: 'course' }],
    });
    assert.match(text, /jwgl\.student、course/);
    assert.match(text, /course 未写库名.*`world`/);
  });

  it('accepts plain table names and discloses the default schema they resolve against', () => {
    const text = renderQuerySteps({ ...base, tables: ['student'] });
    assert.match(text, /student 未写库名.*`world`/);
  });

  it('reports an added LIMIT as an explicit step', () => {
    const text = renderQuerySteps({ ...base, limitApplied: 200, limitAdded: true });
    assert.match(text, /自动补 LIMIT/);
    assert.match(text, /LIMIT 200/);
  });

  it('stays silent about a LIMIT the statement already carried', () => {
    // The SQL block shows the LIMIT; claiming a maxRows cap here would misstate what runs.
    const text = renderQuerySteps({ ...base, limitApplied: 200, limitAdded: false });
    assert.doesNotMatch(text, /自动补/);
    assert.doesNotMatch(text, /最多返回/);
  });

  it('names the injected timeout so the wrapper is not a mystery', () => {
    assert.match(renderQuerySteps({ ...base, timeoutMs: 15000 }), /MAX_EXECUTION_TIME\(15000\)/);
  });

  it('stops at the failure step when execution was rejected', () => {
    const text = renderQuerySteps({ ...base, failure: 'Unknown column' });
    assert.match(text, /执行失败/);
    assert.doesNotMatch(text, /返回 5 行/);
  });

  it('marks a truncated result', () => {
    const text = renderQuerySteps({ ...base, result: { ...base.result, truncated: true } });
    assert.match(text, /结果已被截断/);
  });
});

describe('renderExplanation', () => {
  it('lists every clause with its teaching note', () => {
    const text = renderExplanation(explainSql('SELECT Name FROM country WHERE Continent = \'Asia\''));
    assert.match(text, /\*\*SELECT\*\*/);
    assert.match(text, /\*\*FROM\*\*/);
    assert.match(text, /\*\*WHERE\*\*/);
    assert.match(text, /↳/);
  });

  it('surfaces hints under a teaching heading', () => {
    const text = renderExplanation(explainSql('SELECT * FROM city'));
    assert.match(text, /教学提示/);
    assert.match(text, /所有列/);
  });

  it('spells out the join relationship including the alias', () => {
    const text = renderExplanation(explainSql('SELECT 1 FROM city c JOIN country k ON c.CountryCode = k.Code'));
    assert.match(text, /连接关系/);
    assert.match(text, /别名/);
  });

  it('warns inline about a join with no ON condition', () => {
    const text = renderExplanation(explainSql('SELECT 1 FROM city c JOIN country k'));
    assert.match(text, /没有 ON 条件/);
  });

  it('collapses long clause text instead of flooding the output', () => {
    const sql = `SELECT ${Array.from({ length: 200 }, (_, index) => `col_${index}`).join(', ')} FROM t`;
    const text = renderExplanation(explainSql(sql));
    assert.ok(text.includes('…'));
    for (const line of text.split('\n')) assert.ok(line.length < 400, line.slice(0, 60));
  });

  it('handles a statement with no clauses at all', () => {
    assert.match(renderExplanation(explainSql('SHOW TABLES')), /没有可拆解的子句/);
  });
});

describe('explainSql — write statements', () => {
  it('breaks an UPDATE into UPDATE / SET / WHERE', () => {
    const out = explainSql("UPDATE `student` SET `Sname` = '李四' WHERE `Sno` = 2000014");
    assert.equal(out.kind, 'update');
    assert.deepEqual(out.clauses.map((clause) => clause.key), ['update', 'set', 'where']);
    assert.match(out.clauses[0].text, /`student`/);
    assert.match(out.clauses[1].text, /`Sname` = '李四'/);
  });

  it('breaks a DELETE into DELETE FROM / WHERE', () => {
    const out = explainSql('DELETE FROM `sc` WHERE `Grade` IS NULL');
    assert.equal(out.kind, 'delete');
    assert.deepEqual(out.clauses.map((clause) => clause.key), ['delete', 'where']);
    // `DELETE FROM` is one clause: splitting them would leave an empty DELETE body.
    assert.equal(out.clauses[0].label, 'DELETE FROM');
    assert.match(out.clauses[0].text, /`sc`/);
  });

  it('breaks an INSERT into INSERT INTO / VALUES', () => {
    const out = explainSql('INSERT INTO `sc` (`Sno`, `Cno`, `Grade`) VALUES (2000014, 1, 88)');
    assert.equal(out.kind, 'insert');
    assert.deepEqual(out.clauses.map((clause) => clause.key), ['insert', 'values']);
    assert.match(out.clauses[0].text, /`Sno`, `Cno`, `Grade`/);
  });

  it('recognises DDL statements and names what they touch', () => {
    assert.equal(explainSql('CREATE TABLE `t` (`id` INT PRIMARY KEY)').kind, 'create');
    assert.equal(explainSql('ALTER TABLE `t` ADD COLUMN `c` INT').kind, 'alter');
    assert.equal(explainSql('DROP TABLE `t`').kind, 'drop');
    assert.equal(explainSql('TRUNCATE TABLE `t`').kind, 'truncate');
    assert.match(explainSql('DROP TABLE `t`').clauses[0].note, /无法撤销/);
  });

  it('raises the missing-WHERE alarm for UPDATE and DELETE', () => {
    assert.ok(explainSql('DELETE FROM `student`').hints.some((hint) => /没有 WHERE 条件/.test(hint)));
    assert.ok(explainSql('UPDATE `student` SET `Sage` = 20').hints.some((hint) => /没有 WHERE 条件/.test(hint)));
    // A guarded write gets the "verify the scope first" advice instead of the alarm.
    const guarded = explainSql('DELETE FROM `student` WHERE `Sno` = 1').hints.join('\n');
    assert.doesNotMatch(guarded, /没有 WHERE 条件/);
    assert.match(guarded, /相同 WHERE 条件的 SELECT/);
  });

  it('warns about an INSERT with no column list', () => {
    assert.ok(explainSql('INSERT INTO `student` VALUES (1, "甲")').hints.some((hint) => /列清单/.test(hint)));
    // With an explicit list there is nothing to warn about.
    assert.ok(!explainSql('INSERT INTO `student` (`Sno`) VALUES (1)').hints.some((hint) => /列清单/.test(hint)));
  });

  it('does not mistake a quoted identifier for a clause keyword', () => {
    // `` `values` `` is a column name; treating it as a VALUES clause would mangle the explanation.
    const out = explainSql('SELECT `values` FROM `t`');
    assert.deepEqual(out.clauses.map((clause) => clause.key), ['select', 'from']);
  });

  it('never reports a write as a read kind', () => {
    for (const sql of [
      'INSERT INTO `t` (`a`) SELECT `a` FROM `u`',
      'WITH x AS (SELECT 1 AS a) DELETE FROM `t` WHERE `id` IN (SELECT `a` FROM x)',
    ]) {
      assert.ok(['insert', 'delete'].includes(explainSql(sql).kind), `${sql} explained as ${explainSql(sql).kind}`);
    }
  });
});
