'use strict';

// 本地生成 Mock 响应：由 JSON Schema 生成样例，或把固定样例改写成动态模板。不依赖 AI。

const KEEP_FIXED = /^(code|status|success|ok|msg|message|errno|errcode|ret|result)$/i;

// 按字段名推断语义：[字段名正则, 静态样例, 动态占位符]；占位符作用于 string / number 类型
const SEMANTIC = [
  [/(^|_)(id|uuid|guid)$|Id$|^编号$/, { string: ['a1b2c3d4', '{{uuid}}'], number: [1, '{{int 1 99999}}'] }],
  [/name|姓名|^xm$|realname|username|nickname/i, { string: ['张三', '{{name}}'] }],
  [/phone|mobile|tel|手机|电话/i, { string: ['13800000000', '{{phone}}'] }],
  [/e-?mail|邮箱/i, { string: ['user@example.com', '{{email}}'] }],
  [/city|城市/i, { string: ['北京', '{{city}}'] }],
  [/(create|update|modify|submit|birth|begin|start|end)?_?(time|date)$|时间|日期/i, { string: ['2026-01-01 08:00:00', '{{datetime -30 0}}'] }],
  [/^age$|年龄/i, { number: [30, '{{int 18 80}}'] }],
  [/total|count|num$|总数|数量/i, { number: [10, '{{int 0 500}}'] }],
  [/price|amount|money|金额|价格/i, { number: [99.5, '{{float 1 1000 2}}'] }],
];

function semantic(key, type) {
  if (!key) return null;
  for (const [pattern, byType] of SEMANTIC) if (pattern.test(key) && byType[type]) return byType[type];
  return null;
}

const FORMATS = { 'date-time': ['2026-01-01T08:00:00Z', '{{datetime -30 0}}'], date: ['2026-01-01', '{{date -30 0}}'], uuid: ['3f2b8c1e-5a7d-4e1b-9c3a-0d6f2a9b7e41', '{{uuid}}'], email: ['user@example.com', '{{email}}'] };

/** 由简化后的 JSON Schema 生成样例值（dynamic 为 true 时叶子值用占位符，数组用 repeat）。 */
function exampleFromSchema(schema, { dynamic = false, key = '', depth = 0 } = {}) {
  if (!schema || typeof schema !== 'object' || depth > 8) return null;
  if (schema.example !== undefined && !dynamic) return schema.example;
  if (schema.default !== undefined && !dynamic) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const strings = schema.enum.every((v) => typeof v === 'string' && /^[^\s{}]+$/.test(v));
    return dynamic && strings && schema.enum.length > 1 ? `{{pick ${schema.enum.join(' ')}}}` : schema.enum[0];
  }
  const type = schema.type || (schema.properties ? 'object' : schema.items ? 'array' : 'string');
  const pick = (pair) => (dynamic ? pair[1] : pair[0]);
  if (type === 'object') {
    const out = {};
    for (const [name, child] of Object.entries(schema.properties || {})) out[name] = exampleFromSchema(child, { dynamic, key: name, depth: depth + 1 });
    return out;
  }
  if (type === 'array') {
    const item = exampleFromSchema(schema.items || {}, { dynamic, key, depth: depth + 1 });
    return dynamic ? ['{{repeat 3 8}}', item] : [item];
  }
  if (type === 'integer' || type === 'number') {
    const hit = semantic(key, 'number');
    if (hit) return type === 'integer' && !Number.isInteger(hit[0]) ? pick([Math.round(hit[0]), '{{int 1 1000}}']) : pick(hit);
    return type === 'integer' ? pick([0, '{{int 0 100}}']) : pick([0, '{{float 0 100 2}}']);
  }
  if (type === 'boolean') return pick([true, '{{bool}}']);
  if (schema.format && FORMATS[schema.format]) return pick(FORMATS[schema.format]);
  const hit = semantic(key, 'string');
  return hit ? pick(hit) : pick(['string', '{{text 8}}']);
}

/** 把一份固定样例（JSON 值）改写成动态模板；无法判断语义的文本保持原样。 */
function templatizeSample(value, key = '') {
  if (Array.isArray(value)) {
    if (!value.length) return value;
    return [`{{repeat ${Math.min(value.length, 3)} ${Math.max(value.length, 5)}}}`, templatizeSample(value[0], key)];
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, templatizeSample(v, k)]));
  }
  if (KEEP_FIXED.test(key)) return value;
  if (typeof value === 'boolean') return '{{bool}}';
  if (typeof value === 'number') {
    const hit = semantic(key, 'number');
    if (hit && (Number.isInteger(value) || !Number.isInteger(hit[0]))) return hit[1];
    return Number.isInteger(value) ? `{{int 0 ${Math.max(100, Math.abs(value) * 2)}}}` : `{{float 0 ${Math.max(100, Math.ceil(Math.abs(value)) * 2)} 2}}`;
  }
  if (typeof value === 'string') {
    const hit = semantic(key, 'string');
    return hit ? hit[1] : value;
  }
  return value;
}

module.exports = { exampleFromSchema, templatizeSample };
