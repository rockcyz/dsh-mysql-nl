/**
 * Facade over the core engine modules. Library consumers (and tests) can import one module instead of
 * the individual files; the Cordis entry point imports the specific modules it needs directly.
 * @module dsh-mysql-nl/core
 */

export { CONNECTION_FILE_NAMES, findConnectionsFile, loadConnections, resolveConnection, stripByteOrderMark } from './config.js';
export { describeTarget, disposeAll, getPool, ping, runQuery } from './client.js';
export { listDatabases, loadCatalog, loadTableDetails, pickRelevantTables, renderSchema } from './catalog.js';
export {
  analyze,
  classify,
  cleanSql,
  guard,
  maskLiterals,
  referencedTables,
  scanSpans,
  splitStatements,
  withRowLimit,
} from './sql.js';
export { explainSql } from './explain.js';
export { generateSql, renderCatalogIndex, selectTables } from './nl.js';
export {
  renderConnection,
  renderExplanation,
  renderQuerySteps,
  renderResultTable,
  summarizeResult,
} from './format.js';
