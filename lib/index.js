/**
 * Package entry point. The implementation lives in `./plugin-mysql.js`; this file exists so the
 * module URL the host loads is stable and explicit, and so a package published from a source tree has
 * one obvious entry.
 * @module dsh-mysql-nl
 */

export { apply, Config, inject, name } from './plugin-mysql.js';
