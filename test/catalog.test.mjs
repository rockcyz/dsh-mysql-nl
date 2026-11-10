/**
 * Live integration tests for lib/core/catalog.js.
 * Introspection runs against the real local MySQL server (`world` for small/fast coverage,
 * `sakila` for foreign keys and composite indexes). Read-only: no schema or data is modified.
 * Run: node --test test/
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { disposeAll } from '../lib/core/client.js';
import {
  listDatabases,
  loadCatalog,
  loadTableDetails,
  pickRelevantTables,
  renderSchema,
} from '../lib/core/catalog.js';
import { testConn } from './helpers.mjs';

const worldConn = testConn({ database: 'world' });

after(async () => {
  await disposeAll();
});

test('listDatabases returns sorted user schemas and hides system schemas', async () => {
  const databases = await listDatabases(testConn());
  assert.ok(databases.includes('sakila'));
  assert.ok(databases.includes('world'));
  for (const system of ['information_schema', 'mysql', 'performance_schema', 'sys']) {
    assert.equal(databases.includes(system), false, `${system} should be hidden`);
  }
  assert.deepEqual(databases, [...databases].sort());
  assert.equal(new Set(databases).size, databases.length);
});

test('loadCatalog reports exactly the three world base tables with row estimates', async () => {
  const catalog = await loadCatalog(worldConn, 'world');
  assert.equal(catalog.database, 'world');
  assert.equal(catalog.detailed, false);
  assert.deepEqual(
    catalog.tables.map((table) => table.name),
    ['city', 'country', 'countrylanguage'],
  );
  for (const table of catalog.tables) {
    assert.deepEqual(table.columns, []);
    assert.deepEqual(table.indexes, []);
    assert.deepEqual(table.foreignKeys, []);
    assert.equal(typeof table.rowEstimate, 'number');
    assert.ok(table.rowEstimate > 0, `${table.name} should have a row estimate`);
    assert.equal(table.comment, undefined);
  }
  const city = catalog.tables.find((table) => table.name === 'city');
  assert.equal(city.rowEstimate, 4046);
  const country = catalog.tables.find((table) => table.name === 'country');
  assert.equal(country.rowEstimate, 239);
});

test('loadCatalog lists the sakila core tables', async () => {
  const catalog = await loadCatalog(testConn(), 'sakila');
  const names = catalog.tables.map((table) => table.name);
  assert.ok(names.length >= 10, `expected the full sakila schema, got ${names.length} tables`);
  for (const expected of ['actor', 'film', 'film_actor', 'payment', 'rental', 'customer']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  assert.deepEqual(names, [...names].sort());
});

test('loadTableDetails loads real columns, indexes and foreign keys for film/film_actor', async () => {
  const catalog = await loadTableDetails(testConn(), 'sakila', ['film', 'film_actor']);
  assert.equal(catalog.database, 'sakila');
  assert.equal(catalog.detailed, true);
  assert.deepEqual(
    catalog.tables.map((table) => table.name).sort(),
    ['film', 'film_actor'],
  );

  const film = catalog.tables.find((table) => table.name === 'film');
  // Column order must follow ORDINAL_POSITION exactly.
  assert.deepEqual(film.columns.slice(0, 3).map((column) => column.name), [
    'film_id',
    'title',
    'description',
  ]);
  const filmId = film.columns.find((column) => column.name === 'film_id');
  assert.equal(filmId.isPrimaryKey, true);
  assert.equal(filmId.nullable, false);
  assert.equal(filmId.autoIncrement, true);
  assert.match(filmId.type, /^smallint/);
  const title = film.columns.find((column) => column.name === 'title');
  assert.match(title.type, /^varchar/);
  assert.equal(title.nullable, false);
  assert.equal(title.isPrimaryKey, false);
  assert.equal(title.autoIncrement, undefined);
  assert.ok(film.indexes.some((index) => index.name === 'PRIMARY' && index.unique));
  assert.deepEqual(
    film.indexes.find((index) => index.name === 'PRIMARY').columns,
    ['film_id'],
  );
  assert.ok(film.indexes.some((index) => index.name === 'idx_title' && !index.unique));
  assert.deepEqual(
    film.foreignKeys.map((fk) => fk.referencedTable),
    ['language', 'language'],
  );
  assert.deepEqual(film.foreignKeys.map((fk) => fk.columns[0]), [
    'language_id',
    'original_language_id',
  ]);
  assert.ok(typeof film.rowEstimate === 'number');

  const filmActor = catalog.tables.find((table) => table.name === 'film_actor');
  assert.deepEqual(
    filmActor.columns.filter((column) => column.isPrimaryKey).map((column) => column.name),
    ['actor_id', 'film_id'],
  );
  assert.deepEqual(
    filmActor.indexes.find((index) => index.name === 'PRIMARY').columns,
    ['actor_id', 'film_id'],
  );
  const referenced = filmActor.foreignKeys.map((fk) => fk.referencedTable).sort();
  assert.deepEqual(referenced, ['actor', 'film']);
  assert.deepEqual(
    filmActor.foreignKeys.find((fk) => fk.referencedTable === 'film').referencedColumns,
    ['film_id'],
  );
});

test('loadTableDetails without tableNames covers every table in the database', async () => {
  const catalog = await loadTableDetails(worldConn, 'world');
  assert.equal(catalog.detailed, true);
  assert.deepEqual(
    catalog.tables.map((table) => table.name),
    ['city', 'country', 'countrylanguage'],
  );
  assert.ok(catalog.tables.every((table) => table.columns.length > 0));
  const city = catalog.tables.find((table) => table.name === 'city');
  assert.deepEqual(
    city.columns.map((column) => column.name),
    ['ID', 'Name', 'CountryCode', 'District', 'Population'],
  );
  assert.deepEqual(
    city.indexes.find((index) => index.name === 'PRIMARY').columns,
    ['ID'],
  );
  assert.deepEqual(city.foreignKeys, [
    {
      name: 'city_ibfk_1',
      columns: ['CountryCode'],
      referencedTable: 'country',
      referencedColumns: ['Code'],
    },
  ]);
  const country = catalog.tables.find((table) => table.name === 'country');
  assert.deepEqual(country.foreignKeys, []);
});

test('loadTableDetails returns an empty detailed catalog for unknown table names', async () => {
  const catalog = await loadTableDetails(worldConn, 'world', ['no_such_table']);
  assert.equal(catalog.detailed, true);
  assert.deepEqual(catalog.tables, []);
});

test('renderSchema produces compact deterministic text with keys, enums and foreign keys', async () => {
  const catalog = await loadTableDetails(testConn(), 'sakila', ['film', 'film_actor']);
  const text = renderSchema(catalog);

  assert.ok(text.startsWith('## DATABASE sakila'));
  assert.equal(text.includes('{'), false);
  assert.equal(text.includes('}'), false);
  assert.equal(text.includes('|'), false);
  assert.match(text, /### film \(≈\d+ rows\)/);
  assert.match(text, /- film_id smallint unsigned !NOT NULL \[PK\] \[AI\]/);
  assert.ok(text.includes("- rating enum('G','PG','PG-13','R','NC-17')"));
  assert.ok(text.includes('FK: film_actor.actor_id -> actor.actor_id'));
  assert.ok(text.includes('FK: film_actor.film_id -> film.film_id'));
  assert.ok(text.includes('IDX: idx_title(title)'));
  assert.ok(text.includes('### film_actor'));
  assert.equal(renderSchema(catalog), text);
  assert.ok(text.length <= 60000);
});

test('renderSchema drops whole tables to respect maxChars', async () => {
  const catalog = await loadTableDetails(testConn(), 'sakila', ['film', 'film_actor']);
  const tiny = renderSchema(catalog, { maxChars: 120 });
  assert.ok(tiny.length <= 120, `got ${tiny.length} chars`);
  assert.ok(tiny.startsWith('## DATABASE sakila'));
  assert.match(tiny, /\(还有 2 张表未展示\)/);

  const full = renderSchema(catalog);
  const medium = renderSchema(catalog, { maxChars: full.length - 10 });
  assert.ok(medium.length <= full.length - 10);
  assert.ok(medium.includes('### film'));
  assert.equal(medium.includes('### film_actor'), false);
  assert.match(medium, /\(还有 1 张表未展示\)/);
});

test('pickRelevantTables ranks the table a natural-language question is about', async () => {
  const sakila = await loadCatalog(testConn(), 'sakila');
  const world = await loadCatalog(worldConn, 'world');

  assert.equal(pickRelevantTables(sakila, '列出所有电影的名称和时长', 3)[0], 'film');
  assert.equal(pickRelevantTables(sakila, 'show me all films', 3)[0], 'film');
  assert.equal(pickRelevantTables(sakila, '列出所有演员', 3)[0], 'actor');
  assert.equal(pickRelevantTables(world, '哪些城市人口最多', 3)[0], 'city');
  assert.equal(pickRelevantTables(world, 'which countries have the most languages', 3)[0], 'country');
});

test('pickRelevantTables is deterministic, bounded and empty-safe', async () => {
  const world = await loadCatalog(worldConn, 'world');
  const first = pickRelevantTables(world, '城市和语言', 2);
  const second = pickRelevantTables(world, '城市和语言', 2);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ['city', 'countrylanguage']);
  assert.equal(pickRelevantTables(world, 'anything at all', 50).length, 3);
  assert.equal(pickRelevantTables(world, 'anything at all', 1).length, 1);
  assert.deepEqual(pickRelevantTables({ database: 'empty', tables: [], detailed: false }, 'x', 3), []);
});
