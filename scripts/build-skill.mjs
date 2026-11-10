#!/usr/bin/env node
/**
 * Build the distributable **Agent Skill** bundle from the plugin's own sources.
 *
 * Why a build step instead of a hand-maintained second copy: `lib/core/**` is the single source of
 * truth. The DSH plugin and the cross-agent skill must run the *same* introspection, guard and
 * truncation code, or the two flavours drift and only one of them gets bug fixes. This script
 * copies the core into a self-contained skill directory and refuses to let the two diverge — see
 * `--check`.
 *
 * The output is a directory bundle that both DSH and OpenCode discover by scanning
 * `<root>/<name>/SKILL.md`:
 *
 *   <out>/SKILL.md            frontmatter (name must equal the directory name) + usage procedure
 *   <out>/bin/mysql-nl.mjs    the CLI
 *   <out>/lib/core/*.js       copied from ../../lib/core
 *   <out>/package.json        so `npm install --omit=dev` can vendor mysql2
 *   <out>/node_modules/       mysql2 and its deps, so the bundle runs with no install step
 *
 * Usage:
 *   node scripts/build-skill.mjs [--out <dir>] [--check] [--no-install] [--zip]
 *
 * @module dsh-mysql-nl/scripts/build-skill
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
/** Workspace root = the directory the plugin lives in. */
const WORKSPACE_ROOT = path.resolve(PACKAGE_ROOT, '..');
const SKILL_NAME = 'mysql-nl';

/** Files copied verbatim into the bundle, as `<source relative to package root>` -> `<dest relative to out>`. */
const COPY_MAP = [['skill/SKILL.md', 'SKILL.md'], ['bin/mysql-nl.mjs', 'bin/mysql-nl.mjs']];

/** MySQL driver version the bundle pins. Kept in sync with package.json by `--check`. */
const MYSQL2_RANGE = '^3.11.5';

// ---------------------------------------------------------------------------- helpers

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

/** Every `lib/core/*.js` file, as paths relative to the package root. */
async function coreFiles() {
  const dir = path.join(PACKAGE_ROOT, 'lib', 'core');
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => `lib/core/${entry.name}`)
    .sort();
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeFile(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

/**
 * Run a command with inherited stdio.
 *
 * `stdio: 'inherit'` is deliberate: under the DSH file sandbox a child process cannot open the
 * named pipes that `stdio: 'pipe'` needs, so capturing output here would fail with EPERM.
 *
 * Windows resolves `npm` to a `.cmd` shim, which `CreateProcess` cannot launch directly, so a shell
 * is required — and passing an args array *alongside* `shell: true` triggers DEP0190. The command
 * line is therefore quoted here and handed over as a single string.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv}} [options]
 */
function run(command, args, options = {}) {
  const env = options.env ?? process.env;
  return new Promise((resolve, reject) => {
    const child =
      process.platform === 'win32'
        ? spawn([command, ...args.map(quoteArg)].join(' '), {
            cwd: options.cwd,
            env,
            stdio: 'inherit',
            shell: true,
          })
        : spawn(command, args, { cwd: options.cwd, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(undefined);
      else reject(new BuildError(`${command} ${args.join(' ')} 退出码 ${code}`));
    });
  });
}

/**
 * Quote one argument for a shell-joined command line.
 * @param {string} value
 * @returns {string}
 */
function quoteArg(value) {
  if (value === '' || /[\s"^&|<>()]/.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
  return value;
}

// ---------------------------------------------------------------------------- steps

/** The generated `package.json` for the bundle. */
function manifest() {
  return `${JSON.stringify(
    {
      name: 'mysql-nl-skill',
      version: '0.1.0',
      type: 'module',
      description: 'Agent Skill：连接 MySQL，读取真实表结构，辅助生成并安全执行 SQL。',
      license: 'MIT',
      engines: { node: '>=20' },
      bin: { 'mysql-nl': './bin/mysql-nl.mjs' },
      dependencies: { mysql2: MYSQL2_RANGE },
      metadata: { skill: SKILL_NAME },
    },
    null,
    2,
  )}\n`;
}

/** The bundle's own README, written for whoever receives the zip. */
const BUNDLE_README = `# mysql-nl — Agent Skill

连接 MySQL，读取**真实**表结构，让 agent 写出能跑通的 SQL 并安全执行。

这个目录是一个标准的 Agent Skill bundle（目录名 = skill 名，含 \`SKILL.md\`），
同时也能当普通命令行工具用。

## 安装

把整个 \`mysql-nl\` 目录放到任一被扫描的 skill 根目录下：

| Agent | 目录 |
|---|---|
| DSH / OpenCode | \`<项目>/.agents/skills/mysql-nl/\` |
| DSH / OpenCode | \`~/.agents/skills/mysql-nl/\` |
| OpenCode | \`.opencode/skills/mysql-nl/\` |
| OpenCode | \`~/.config/opencode/skills/mysql-nl/\` |
| Claude Code | \`~/.claude/skills/mysql-nl/\` |

\`.agents/skills/\` 是 DSH 和 OpenCode 的**共同**扫描路径，放这里一份两边都能发现。

## 直接当 CLI 用

\`\`\`bash
node bin/mysql-nl.mjs list
node bin/mysql-nl.mjs schema --db world
node bin/mysql-nl.mjs query --sql "SELECT * FROM city LIMIT 5"
\`\`\`

## 配置

在工作目录建 \`mysql-nl.json\`（也兼容 \`.dsh-mysql.json\`）：

\`\`\`json
{
  "version": 1,
  "default": "local",
  "connections": [
    { "id": "local", "host": "127.0.0.1", "port": 3306, "user": "root",
      "password": "\${env:MYSQL_PWD}", "database": "world", "readOnly": true }
  ]
}
\`\`\`

\`readOnly\` 默认 \`true\`：只允许 SELECT / WITH / SHOW / DESCRIBE / EXPLAIN。
`;

/**
 * Copy the single-source files into the bundle and report what changed.
 * @param {string} out
 * @returns {Promise<string[]>} relative paths that were created or updated
 */
async function syncSources(out) {
  /** @type {string[]} */
  const changed = [];
  const entries = [...COPY_MAP, ...(await coreFiles()).map((file) => [file, file])];

  for (const [source, dest] of entries) {
    const from = path.join(PACKAGE_ROOT, source);
    const to = path.join(out, dest);
    const desired = await fs.readFile(from);
    const current = await readIfExists(to);
    if (current !== null && current.equals(desired)) continue;
    await writeFile(to, desired);
    changed.push(dest);
  }

  for (const [dest, contents] of [
    ['package.json', manifest()],
    ['README.md', BUNDLE_README],
  ]) {
    const to = path.join(out, dest);
    const current = await readIfExists(to);
    if (current !== null && current.toString('utf8') === contents) continue;
    await writeFile(to, contents);
    changed.push(dest);
  }

  return changed;
}

/**
 * Copy the core, then fail if the bundle differs from what the source would produce.
 * @param {string} out
 */
async function checkSources(out) {
  /** @type {string[]} */
  const stale = [];
  const entries = [...COPY_MAP, ...(await coreFiles()).map((file) => [file, file])];

  for (const [source, dest] of entries) {
    const desired = await fs.readFile(path.join(PACKAGE_ROOT, source));
    const current = await readIfExists(path.join(out, dest));
    if (current === null) stale.push(`${dest}（缺失）`);
    else if (!current.equals(desired)) stale.push(`${dest}（内容不一致）`);
  }
  for (const [dest, contents] of [
    ['package.json', manifest()],
    ['README.md', BUNDLE_README],
  ]) {
    const current = await readIfExists(path.join(out, dest));
    if (current === null || current.toString('utf8') !== contents) stale.push(`${dest}（缺失或过期）`);
  }

  if (stale.length > 0) {
    throw new BuildError(
      `skill bundle 与 lib/core 不同步，运行 node scripts/build-skill.mjs 重建：\n  - ${stale.join('\n  - ')}`,
    );
  }
}

/**
 * Ensure the bundle can run without an install step by vendoring mysql2.
 *
 * The cache lives inside the package rather than the user profile because the DSH sandbox denies
 * writes outside the workspace, which made the default npm cache fail with EPERM.
 *
 * @param {string} out
 */
async function ensureDependencies(out) {
  if (await readIfExists(path.join(out, 'node_modules', 'mysql2', 'package.json')) !== null) {
    return false;
  }
  process.stderr.write('正在把 mysql2 安装进 skill bundle（首次构建需要联网）…\n');
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: out,
    env: { ...process.env, npm_config_cache: path.join(PACKAGE_ROOT, '.npm-cache') },
  });
  return true;
}

/** @param {string} out */
async function zipBundle(out) {
  const archive = path.join(WORKSPACE_ROOT, 'dist', `${SKILL_NAME}-skill.zip`);
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.rm(archive, { force: true });
  // -a lets bsdtar pick the container format from the .zip suffix; supported on Windows 10+.
  await run('tar', ['-a', '-c', '-f', archive, '-C', path.dirname(out), path.basename(out)]);
  return archive;
}

// ---------------------------------------------------------------------------- entry

async function main() {
  const { flags, out } = parseArgs(process.argv.slice(2));
  const target = path.resolve(out ?? path.join(WORKSPACE_ROOT, '.agents', 'skills', SKILL_NAME));

  if (flags.has('check')) {
    await checkSources(target);
    process.stdout.write(`✓ skill bundle 与 lib/core 同步：${target}\n`);
    return;
  }

  const changed = await syncSources(target);
  process.stdout.write(
    changed.length === 0
      ? `✓ 无变化：${target}\n`
      : `✓ 已更新 ${changed.length} 个文件：\n  - ${changed.join('\n  - ')}\n  输出目录：${target}\n`,
  );

  if (!flags.has('no-install')) {
    const installed = await ensureDependencies(target);
    if (installed) process.stdout.write('  + node_modules（mysql2 及其依赖）\n');
  }

  if (flags.has('zip')) {
    const archive = await zipBundle(target);
    process.stdout.write(`✓ 已打包：${archive}\n`);
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`构建失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
