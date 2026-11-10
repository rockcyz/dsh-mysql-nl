#!/usr/bin/env node
/**
 * Build the domain (business-semantic) skill bundles.
 *
 * A domain lives in `domains/<dir>/` and is made of two files:
 *
 *   SKILL.md        what the agent loads up front — scope, hard rules, traps, output contract
 *   semantic.json   the on-demand detail — entities, dictionaries, metric SQL, join paths, examples
 *
 * Why a build step instead of authoring straight into `.agents/skills/`: the scan root is
 * one-level-deep (`<root>/<name>/SKILL.md`), the skill name must be kebab-case, and SKILL.md has a
 * hard 8192-character ceiling (DSH prunes longer tool results). Validating those rules here means a
 * malformed domain fails the build instead of silently vanishing from the agent's skill catalog.
 *
 * The domain bundle deliberately contains **no code**: it reuses the single CLI shipped by the
 * `mysql-nl` skill. Copying `bin/` and `lib/core/` per domain would give you N forks of the
 * read-only guard, which is the exact drift the shared-core design exists to prevent.
 *
 * Usage:
 *   node scripts/build-domains.mjs [--check] [--out <dir>]
 *
 * @module dsh-mysql-nl/scripts/build-domains
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { stripByteOrderMark } from '../lib/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const WORKSPACE_ROOT = path.resolve(PACKAGE_ROOT, '..');
const DOMAINS_ROOT = path.join(PACKAGE_ROOT, 'domains');

/** DSH prunes a skill tool result above this many characters. */
const SKILL_CHAR_LIMIT = 8192;

/** Skill names must match this, and must equal their directory name. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

class BuildError extends Error {}

/** @param {string[]} argv */
function parseArgs(argv) {
  const flags = new Set();
  let out;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--out') {
      out = argv[index + 1];
      if (out === undefined) throw new BuildError('--out 需要一个目录');
      index += 1;
      continue;
    }
    if (token.startsWith('--')) {
      flags.add(token.slice(2));
      continue;
    }
    throw new BuildError(`无法识别的参数 "${token}"`);
  }
  return { flags, out };
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Parse the `name` out of a SKILL.md YAML frontmatter without pulling in a YAML dependency.
 * @param {string} text
 * @returns {string|null}
 */
function frontmatterName(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (block === null) return null;
  const name = /^name:\s*(\S+)\s*$/m.exec(block[1] ?? '');
  return name === null ? null : name[1];
}

/**
 * Load and validate one domain directory.
 * @param {string} dir
 * @param {string} name directory name
 */
async function loadDomain(dir, name) {
  const skillFile = path.join(dir, 'SKILL.md');
  const semanticFile = path.join(dir, 'semantic.json');

  const skillRaw = await readIfExists(skillFile);
  if (skillRaw === null) throw new BuildError(`${name}: 缺少 SKILL.md`);
  const skillText = stripByteOrderMark(skillRaw.toString('utf8'));

  const semanticRaw = await readIfExists(semanticFile);
  if (semanticRaw === null) throw new BuildError(`${name}: 缺少 semantic.json`);
  /** @type {any} */
  let spec;
  try {
    spec = JSON.parse(stripByteOrderMark(semanticRaw.toString('utf8')));
  } catch (error) {
    throw new BuildError(`${name}: semantic.json 不是合法 JSON — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new BuildError(`${name}: semantic.json 的根节点必须是对象`);
  }

  const skillName = typeof spec.domain === 'string' && spec.domain !== '' ? spec.domain : name;
  if (!SKILL_NAME_PATTERN.test(skillName)) {
    throw new BuildError(`${name}: domain "${skillName}" 不是合法的 kebab-case skill 名（^[a-z0-9]+(-[a-z0-9]+)*$）`);
  }
  const declared = frontmatterName(skillText);
  if (declared !== skillName) {
    throw new BuildError(`${name}: SKILL.md frontmatter 的 name 是 "${declared ?? '（缺失）'}"，但 semantic.json 的 domain 是 "${skillName}"，两者必须一致`);
  }
  if (skillText.length > SKILL_CHAR_LIMIT) {
    throw new BuildError(`${name}: SKILL.md 有 ${skillText.length} 字符，超过 DSH 的 ${SKILL_CHAR_LIMIT} 字符上限（超出的部分会被裁掉）`);
  }

  return { dir, name, skillName, skillText, semanticText: stripByteOrderMark(semanticRaw.toString('utf8')), spec };
}

/**
 * List `domains/*` that look like a domain (has a semantic.json).
 * @returns {Promise<Array<{dir: string, name: string}>>}
 */
async function listDomains() {
  let entries;
  try {
    entries = await fs.readdir(DOMAINS_ROOT, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const found = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(DOMAINS_ROOT, entry.name);
    if (await readIfExists(path.join(dir, 'semantic.json')) !== null) found.push({ dir, name: entry.name });
  }
  return found;
}

/** @param {ReturnType<Awaited<ReturnType<typeof loadDomain>>>} domain @param {string} out */
async function writeDomain(domain, out) {
  const target = path.join(out, domain.skillName);
  const changed = [];
  for (const [fileName, contents] of [
    ['SKILL.md', domain.skillText],
    ['semantic.json', domain.semanticText],
  ]) {
    const dest = path.join(target, fileName);
    const current = await readIfExists(dest);
    if (current !== null && current.toString('utf8') === contents) continue;
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(dest, contents);
    changed.push(`${domain.skillName}/${fileName}`);
  }
  return { target, changed };
}

/** @param {string} out */
async function checkDomains(out) {
  const domains = await listDomains();
  if (domains.length === 0) {
    process.stdout.write('（没有找到任何领域，跳过）\n');
    return;
  }
  /** @type {string[]} */
  const stale = [];
  for (const entry of domains) {
    const domain = await loadDomain(entry.dir, entry.name);
    const target = path.join(out, domain.skillName);
    for (const [fileName, contents] of [
      ['SKILL.md', domain.skillText],
      ['semantic.json', domain.semanticText],
    ]) {
      const current = await readIfExists(path.join(target, fileName));
      if (current === null) stale.push(`${domain.skillName}/${fileName}（缺失）`);
      else if (current.toString('utf8') !== contents) stale.push(`${domain.skillName}/${fileName}（内容不一致）`);
    }
  }
  if (stale.length > 0) {
    throw new BuildError(`领域 skill 与 domains/ 不同步，运行 node scripts/build-domains.mjs 重建：\n  - ${stale.join('\n  - ')}`);
  }
  process.stdout.write(`✓ ${domains.length} 个领域 skill 均已同步\n`);
}

async function main() {
  const { flags, out } = parseArgs(process.argv.slice(2));
  const target = path.resolve(out ?? path.join(WORKSPACE_ROOT, '.agents', 'skills'));

  if (flags.has('check')) {
    await checkDomains(target);
    return;
  }

  const domains = await listDomains();
  if (domains.length === 0) {
    process.stdout.write(`（${DOMAINS_ROOT} 下没有找到领域，跳过）\n`);
    return;
  }

  let totalChanged = 0;
  for (const entry of domains) {
    const domain = await loadDomain(entry.dir, entry.name);
    const { target: dir, changed } = await writeDomain(domain, target);
    totalChanged += changed.length;
    const tableCount = Object.keys(domain.spec.tables ?? {}).length;
    const metricCount = (domain.spec.metrics ?? []).length;
    const exampleCount = (domain.spec.examples ?? []).length;
    process.stdout.write(
      `✓ ${domain.skillName}（${domain.skillText.length} 字符 · ${tableCount} 表 · ${metricCount} 口径 · ${exampleCount} 示例）` +
        `${changed.length === 0 ? ' — 无变化' : ` — 更新 ${changed.length} 个文件`}\n  输出：${dir}\n`,
    );
  }

  const warnings = [];
  for (const entry of domains) {
    const domain = await loadDomain(entry.dir, entry.name);
    if (!(domain.spec.tables && Object.keys(domain.spec.tables).length > 0)) warnings.push(`${domain.skillName}: 没有声明任何表`);
    if (!(domain.spec.metrics && domain.spec.metrics.length > 0)) warnings.push(`${domain.skillName}: 没有声明任何口径（metrics）`);
    if (!(domain.spec.examples && domain.spec.examples.length > 0)) warnings.push(`${domain.skillName}: 没有声明任何示例（examples），verify 将无法回归`);
    if (domain.spec.forbidden === undefined) warnings.push(`${domain.skillName}: 没有声明 forbidden，垃圾表可能被误用`);
  }
  if (warnings.length > 0) {
    process.stdout.write(`\n建议补全：\n  - ${warnings.join('\n  - ')}\n`);
  }
  process.stdout.write(`\n共 ${domains.length} 个领域，更新 ${totalChanged} 个文件。\n校验语义层与真实库是否一致：\n  node bin/mysql-nl.mjs verify --semantic domains/<领域>/semantic.json\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`构建失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
