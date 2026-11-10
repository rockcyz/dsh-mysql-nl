/**
 * Tiny shared helper for the live-MySQL `node:test` suites (`client.test.mjs`,
 * `catalog.test.mjs`). Credentials come from the environment so the suite stays portable; the
 * defaults point at the local development server.
 */

export const HOST = process.env.DSH_TEST_MYSQL_HOST ?? '127.0.0.1';
export const PORT = Number(process.env.DSH_TEST_MYSQL_PORT ?? 3306);
export const USER = process.env.DSH_TEST_MYSQL_USER ?? 'root';
export const PASSWORD = process.env.DSH_TEST_MYSQL_PASSWORD ?? 'root';

/**
 * Connection options for the live test server (`sakila` unless overridden).
 * @param {Partial<import('../lib/core/types.js').ConnectionOptions>} [overrides]
 * @returns {import('../lib/core/types.js').ConnectionOptions}
 */
export function testConn(overrides = {}) {
  return {
    id: 'test',
    label: 'local test server',
    host: HOST,
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: 'sakila',
    readOnly: true,
    maxRows: 200,
    maxQueryMs: 15000,
    charset: 'utf8mb4',
    ...overrides,
  };
}
