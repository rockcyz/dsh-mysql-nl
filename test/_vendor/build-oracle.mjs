/**
 * Extract the host's JSON Schema subset validator from app.asar and stitch it into one standalone
 * ESM module, so tool schemas can be validated locally exactly as the running host validates them.
 */
import fs from 'node:fs';
import path from 'node:path';

const ASAR = 'C:\\Users\\rockc\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar';
const OUT = process.argv[2];
const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const buf = Buffer.alloc(headerSize);
fs.readSync(fd, buf, 0, headerSize, 16);
const header = JSON.parse(buf.toString('utf8'));
const base = 16 + headerSize;

function findNode(p) {
  const parts = p.split('/').filter(Boolean);
  let n = header;
  for (const q of parts) { if (!n.files || !n.files[q]) return null; n = n.files[q]; }
  return n;
}
function read(p) {
  const n = findNode(p);
  if (!n || n.files) return null;
  const b = Buffer.alloc(n.size);
  fs.readSync(fd, b, 0, n.size, base + parseInt(n.offset));
  return b.toString('utf8');
}

const source = read('/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
if (source === null) throw new Error('dsh-tools not found');

// Region markers delimit the emitted submodules inside the bundled file.
const regionRe = /\/\/#region ([^\n]+)\n([\s\S]*?)\/\/#endregion/g;
const regions = new Map();
for (const match of source.matchAll(regionRe)) regions.set(match[1].trim(), match[2]);
console.log('regions:', [...regions.keys()].join(' | '));

const wanted = [...regions.entries()].filter(([key]) => /json-schema|schema\.js/.test(key));
const body = wanted.map(([, text]) => text).join('\n');

// The extracted code references HarnessError, brandString, assertNever and json helpers; provide the
// minimal real implementations so the extracted logic behaves identically for schema validation.
const shim = `
class HarnessError extends Error {
  constructor(message, code) { super(message); this.name = 'HarnessError'; this.code = code; }
}
const brandString = (value) => value;
const assertNever = (value) => { throw new Error('assertNever: ' + String(value)); };
function deepFreeze(value) { return value; }
function isJsonValue(value) {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (kind === 'object') return Object.values(value).every(isJsonValue);
  return false;
}
function snapshotJsonValue(value) { return value; }
`;

const outFile = path.join(OUT, 'dsh-json-schema.mjs');
fs.mkdirSync(OUT, { recursive: true });
const names = [...new Set([...body.matchAll(/^(?:function|const|var|let|class) ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]))];
const exportLine = `\nexport { ${names.join(', ')} };\n`;
fs.writeFileSync(outFile, `${shim}\n${body}\n${exportLine}`);
console.log('wrote', outFile, fs.statSync(outFile).size, 'bytes');
fs.writeFileSync(path.join(OUT, 'exported-names.json'), JSON.stringify(names, null, 2));
console.log('declared:', names.join(', '));
