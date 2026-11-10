/**
 * Plugin configuration: field descriptions, a dependency-free Standard Schema validator, and a JSON
 * Schema projection for DSH's Config inspection.
 *
 * Why not `@deepseek-ai/schemastery`: a plugin installed into a profile resolves its imports from the
 * profile, not from the dsh installation, so depending on a bundled package would either fail to
 * resolve or install a second copy. Cordis only requires `Config['~standard'].validate(config)`, and
 * the host already tolerates a non-Schemastery schema (it lists it as `unsupported`), so the protocol
 * is implemented directly here.
 * @module dsh-mysql-nl/config-schema
 */

/** Machine-readable field descriptions, also used for the JSON Schema projection and the README. */
export const FIELDS = [
  ['connectionsFile', 'string', '连接配置文件路径；默认从当前工作目录向上查找 .dsh-mysql.json'],
  ['profile', 'string', '默认使用的连接 id；缺省时使用配置文件里的 default'],
  ['readOnly', 'boolean', '强制只读：true 时任何写语句都被拒绝，false 时允许写；缺省跟随连接的 readOnly'],
  ['maxRows', 'number', '单次查询最多返回的行数，默认 200，范围 1..10000'],
  ['maxQueryMs', 'number', '单条 SQL 的超时毫秒数，默认 15000，范围 100..600000'],
  ['maxCellChars', 'number', '单个单元格保留的最大字符数，默认 400，范围 20..10000'],
  ['inlineCharBudget', 'number', '表结构直接放入提示词的字符预算，超出后先让模型选表，默认 60000'],
  ['maxTables', 'number', '参与生成 SQL 的表数量上限，默认 12，范围 1..50'],
  ['llmProvider', 'string', '生成 SQL 使用的 provider；缺省取当前会话的默认模型'],
  ['llmModel', 'string', '生成 SQL 使用的模型；缺省取当前会话的默认模型'],
];

/** @type {Record<string, {kind: string, min?: number, max?: number}>} */
const RULES = {
  connectionsFile: { kind: 'string' },
  profile: { kind: 'string' },
  readOnly: { kind: 'boolean' },
  maxRows: { kind: 'number', min: 1, max: 10000 },
  maxQueryMs: { kind: 'number', min: 100, max: 600000 },
  maxCellChars: { kind: 'number', min: 20, max: 10000 },
  inlineCharBudget: { kind: 'number', min: 1000, max: 2000000 },
  maxTables: { kind: 'number', min: 1, max: 50 },
  llmProvider: { kind: 'string' },
  llmModel: { kind: 'string' },
};

/**
 * Validate and normalize a raw plugin config row.
 * @param {unknown} input
 * @returns {{value: Record<string, unknown>} | {issues: Array<{message: string, path?: Array<string|number>}>}}
 */
export function validateConfig(input) {
  if (input === undefined || input === null) return { value: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { issues: [{ message: 'config 必须是一个对象' }] };
  }
  const issues = [];
  const value = {};
  for (const [key, raw] of Object.entries(input)) {
    const rule = RULES[key];
    if (rule === undefined) {
      issues.push({ message: `未知的配置项 ${JSON.stringify(key)}；可用项：${Object.keys(RULES).join(', ')}`, path: [key] });
      continue;
    }
    if (raw === undefined || raw === null) continue;
    if (rule.kind === 'string') {
      if (typeof raw !== 'string') {
        issues.push({ message: `${key} 必须是字符串`, path: [key] });
        continue;
      }
      if (raw.trim() === '') continue;
      value[key] = raw.trim();
      continue;
    }
    if (rule.kind === 'boolean') {
      if (typeof raw !== 'boolean') {
        issues.push({ message: `${key} 必须是 true 或 false`, path: [key] });
        continue;
      }
      value[key] = raw;
      continue;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      issues.push({ message: `${key} 必须是数字`, path: [key] });
      continue;
    }
    if (!Number.isInteger(raw)) {
      issues.push({ message: `${key} 必须是整数`, path: [key] });
      continue;
    }
    if (rule.min !== undefined && raw < rule.min) {
      issues.push({ message: `${key} 不能小于 ${rule.min}`, path: [key] });
      continue;
    }
    if (rule.max !== undefined && raw > rule.max) {
      issues.push({ message: `${key} 不能大于 ${rule.max}`, path: [key] });
      continue;
    }
    value[key] = raw;
  }
  return issues.length > 0 ? { issues } : { value };
}

/**
 * JSON Schema 2020-12 projection of {@link FIELDS}, used by Config inspection and by tooling that
 * wants to render a form.
 * @returns {Record<string, unknown>}
 */
export function configJsonSchema() {
  /** @type {Record<string, unknown>} */
  const properties = {};
  for (const [key, kind, description] of FIELDS) {
    const rule = RULES[key];
    /** @type {Record<string, unknown>} */
    const node = { type: kind, description };
    if (rule?.min !== undefined) node.minimum = rule.min;
    if (rule?.max !== undefined) node.maximum = rule.max;
    properties[key] = node;
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties,
  };
}

/**
 * The plugin's `Config` export: a Standard Schema object with an optional JSON Schema projection.
 * @type {object}
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-mysql-nl',
    validate: validateConfig,
    jsonSchema: {
      input: () => configJsonSchema(),
      output: () => configJsonSchema(),
    },
  },
};
