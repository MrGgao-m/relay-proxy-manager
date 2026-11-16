'use strict';

const { randomUUID } = require('node:crypto');
const { validateHeaders } = require('./validators');
const { compileTemplate } = require('./template');

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY'];
const MODES = ['mock', 'proxy'];
const SOURCE_TYPES = ['manual', 'trace', 'doc'];
const MAX_RULES = 500;
const MAX_SCENARIOS = 20;
const MAX_DELAY = 30_000;
const MAX_MOCK_BODY = 5 * 1024 * 1024;
const RANK = { static: 0, param: 1, wild: 2 };

/** 去掉查询串/锚点和末尾 /（根路径除外），保证以 / 开头。 */
function normalizePath(input) {
  let path = String(input ?? '').split(/[?#]/)[0].trim();
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

function safeDecode(segment) {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

function compilePattern(path) {
  return path === '/' ? [] : path.slice(1).split('/').map((segment) => {
    if (segment === '*') return { type: 'wild' };
    if (segment.startsWith(':')) return { type: 'param', name: segment.slice(1) };
    return { type: 'static', value: segment };
  });
}

function validatePattern(path) {
  if (!path.startsWith('/') || /[\s?#]/.test(path)) throw new Error('接口路径需以 / 开头，且不能包含空格、? 或 #。');
  const segments = path === '/' ? [] : path.slice(1).split('/');
  const params = new Set();
  segments.forEach((segment, index) => {
    if (segment.includes('*') && (segment !== '*' || index !== segments.length - 1)) throw new Error('通配符 * 只能单独作为路径的最后一段，例如 /files/*。');
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`路径参数「${segment}」不合法，应形如 :id。`);
      if (params.has(name)) throw new Error(`路径参数 :${name} 重复。`);
      params.add(name);
    }
  });
}

function validateRule(input, currentId) {
  if (!input || typeof input !== 'object') throw new Error('接口规则格式不正确。');
  const method = String(input.method || 'GET').trim().toUpperCase();
  if (!METHODS.includes(method)) throw new Error(`不支持的请求方法：${method}。`);
  const path = normalizePath(input.path);
  validatePattern(path);
  const mode = String(input.mode || 'mock');
  if (!MODES.includes(mode)) throw new Error('当前模式只能是「代理」或「Mock」。');
  const note = String(input.note || '').trim();
  if (note.length > 200) throw new Error('备注不能超过 200 个字符。');

  const sourceType = input.source?.type || 'manual';
  if (!SOURCE_TYPES.includes(sourceType)) throw new Error('规则来源不正确。');
  const source = { type: sourceType };
  if (input.source?.ref) source.ref = String(input.source.ref).slice(0, 200);

  const response = validateResponse(input.response);

  // Mock 场景：response 始终是“当前启用的场景”；同一接口的其他场景放在 alternatives 里
  const name = validateScenarioName(input.scenario?.name ?? DEFAULT_SCENARIO);
  const scenario = { id: input.scenario?.id || randomUUID(), name };
  const rawAlternatives = input.alternatives === undefined ? [] : input.alternatives;
  if (!Array.isArray(rawAlternatives)) throw new Error('Mock 场景列表格式不正确。');
  if (rawAlternatives.length + 1 > MAX_SCENARIOS) throw new Error(`同一个接口最多支持 ${MAX_SCENARIOS} 个 Mock 场景。`);
  const alternatives = rawAlternatives.map((alt) => ({ id: alt?.id || randomUUID(), name: validateScenarioName(alt?.name), response: validateResponse(alt?.response) }));
  const names = new Set([scenario.name]);
  const ids = new Set([scenario.id]);
  for (const alt of alternatives) {
    if (names.has(alt.name)) throw new Error(`Mock 场景名称「${alt.name}」重复，请换一个名称。`);
    if (ids.has(alt.id)) throw new Error('Mock 场景 ID 重复。');
    names.add(alt.name);
    ids.add(alt.id);
  }

  return {
    id: currentId || input.id || randomUUID(),
    method, path, mode, enabled: input.enabled !== false, note, source,
    response, scenario, alternatives,
  };
}

const DEFAULT_SCENARIO = '默认';

function validateScenarioName(input) {
  const value = String(input ?? '').trim();
  if (!value || value.length > 30) throw new Error('Mock 场景名称需为 1–30 个字符。');
  return value;
}

/** 校验一份响应配置（状态码、Header、Body、延迟、动态数据）。 */
function validateResponse(input) {
  const raw = input || {};
  const status = raw.status === undefined ? 200 : Number(raw.status);
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error('响应状态码需为 200–599 之间的整数。');
  const bodyEncoding = raw.bodyEncoding === 'base64' ? 'base64' : 'text';
  const body = String(raw.body ?? '');
  if (bodyEncoding === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(body.replace(/\s/g, ''))) throw new Error('Base64 响应内容格式不正确。');
  if (Buffer.byteLength(body, 'utf8') > MAX_MOCK_BODY) throw new Error('Mock 响应内容不能超过 5 MB。');
  const delayMs = raw.delayMs === undefined ? 0 : Number(raw.delayMs);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY) throw new Error(`响应延迟需为 0–${MAX_DELAY} 毫秒的整数。`);
  const dynamic = raw.dynamic === true;
  if (dynamic && bodyEncoding === 'base64') throw new Error('二进制（Base64）响应不支持动态数据占位符。');
  if (dynamic) compileTemplate(body); // 非法占位符在保存时就报错，而不是请求时才失败
  return { status, headers: validateHeaders(Array.isArray(raw.headers) ? raw.headers : []), body, bodyEncoding, dynamic, delayMs };
}

/** 切换启用的场景：当前场景与目标场景原位互换，规则的其余设置不变。 */
function switchScenario(rule, scenarioId) {
  if (rule.scenario.id === scenarioId) return rule;
  const index = rule.alternatives.findIndex((alt) => alt.id === scenarioId);
  if (index < 0) throw new Error('找不到此 Mock 场景，它可能已被删除。');
  const target = rule.alternatives[index];
  const alternatives = rule.alternatives.map((alt, i) => (i === index ? { id: rule.scenario.id, name: rule.scenario.name, response: rule.response } : alt));
  return { ...rule, scenario: { id: target.id, name: target.name }, response: target.response, alternatives };
}

/** 给规则追加一个（未启用的）场景；名称重复时自动加序号。 */
function addScenario(rule, name, response) {
  const taken = new Set([rule.scenario.name, ...rule.alternatives.map((a) => a.name)]);
  let finalName = validateScenarioName(name);
  for (let n = 2; taken.has(finalName); n += 1) finalName = `${validateScenarioName(name).slice(0, 26)} ${n}`;
  return validateRule({ ...rule, alternatives: [...rule.alternatives, { name: finalName, response }] });
}

function validateRules(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error('接口规则列表格式不正确。');
  if (input.length > MAX_RULES) throw new Error(`每个代理最多支持 ${MAX_RULES} 条接口规则。`);
  const rules = input.map((rule) => validateRule(rule));
  const seen = new Set();
  const ids = new Set();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new Error('接口规则 ID 重复。');
    ids.add(rule.id);
    const key = `${rule.method} ${rule.path.replace(/:[A-Za-z0-9_]+/g, ':')}`;
    if (seen.has(key)) throw new Error(`规则重复：${rule.method} ${rule.path}，同一接口只能配置一条。`);
    seen.add(key);
  }
  return rules;
}

function matchSegments(pattern, parts) {
  const wild = pattern.length && pattern[pattern.length - 1].type === 'wild';
  if (wild ? parts.length < pattern.length : parts.length !== pattern.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const segment = pattern[i];
    if (segment.type === 'wild') break;
    if (segment.type === 'static' && segment.value !== parts[i]) return null;
    if (segment.type === 'param') params[segment.name] = parts[i];
  }
  return params;
}

/** 返回 { rule, params } 或 null。优先级：静态 > 参数 > 通配；Method 精确 > ANY；定义顺序靠前者优先。 */
function matchRule(rules, method, requestPath) {
  const path = normalizePath(requestPath);
  const parts = path === '/' ? [] : path.slice(1).split('/').map(safeDecode);
  const upper = String(method).toUpperCase();
  let best = null;
  rules.forEach((rule, order) => {
    if (!rule.enabled) return;
    if (rule.method !== 'ANY' && rule.method !== upper) return;
    const pattern = rule.pattern || compilePattern(rule.path);
    const params = matchSegments(pattern, parts);
    if (!params) return;
    const candidate = { rule, params, pattern, order };
    if (!best || compare(candidate, best) < 0) best = candidate;
  });
  return best && { rule: best.rule, params: best.params };
}

/** 没有命中任何 Mock 时，给出最可能的原因（用于日志和请求详情）。 */
function explainMiss(rules, method, requestPath, prefix = '') {
  const path = normalizePath(requestPath);
  const parts = path === '/' ? [] : path.slice(1).split('/').map(safeDecode);
  const upper = String(method).toUpperCase();
  const patternOf = (rule) => rule.pattern || compilePattern(rule.path);
  const label = (rule) => `${rule.method} ${rule.path}`;

  const samePath = rules.filter((rule) => matchSegments(patternOf(rule), parts));
  if (samePath.length) {
    const sameMethod = samePath.filter((rule) => rule.method === 'ANY' || rule.method === upper);
    if (sameMethod.length) return `规则「${label(sameMethod[0])}」已停用，请在接口规则里勾选启用`;
    return `路径匹配规则「${samePath.map(label).join('、')}」，但请求方法是 ${upper}，方法不一致`;
  }
  const lower = parts.map((part) => part.toLowerCase());
  const caseHit = rules.find((rule) => matchSegments(patternOf(rule).map((seg) => (seg.type === 'static' ? { ...seg, value: seg.value.toLowerCase() } : seg)), lower));
  if (caseHit) return `规则「${label(caseHit)}」与请求路径 ${path} 只有大小写不同，规则区分大小写`;
  if (prefix) {
    const withPrefix = rules.find((rule) => (rule.path === prefix || rule.path.startsWith(`${prefix}/`)) && matchSegments(compilePattern(normalizePath(rule.path.slice(prefix.length) || '/')), parts));
    if (withPrefix) return `规则路径「${withPrefix.path}」带了代理前缀，应写成「${normalizePath(withPrefix.path.slice(prefix.length) || '/')}」`;
  }
  const tail = rules.find((rule) => rule.method === upper || rule.method === 'ANY' ? !/[:*]/.test(rule.path) && rule.path !== '/' && path.endsWith(rule.path) && path !== rule.path : false);
  if (tail) return `规则路径「${tail.path}」只是请求路径「${path}」的结尾部分，缺少前面的 ${path.slice(0, path.length - tail.path.length)}；规则需要写完整（去掉代理前缀后的）路径`;
  return `没有规则匹配「${upper} ${path}」（已配置 ${rules.length} 条；规则路径要去掉代理前缀，查询参数不参与匹配）`;
}

function compare(a, b) {
  const length = Math.max(a.pattern.length, b.pattern.length);
  for (let i = 0; i < length; i += 1) {
    const ra = a.pattern[i] ? RANK[a.pattern[i].type] : -1;
    const rb = b.pattern[i] ? RANK[b.pattern[i].type] : -1;
    if (ra !== rb) return ra - rb;
  }
  const ma = a.rule.method === 'ANY' ? 1 : 0;
  const mb = b.rule.method === 'ANY' ? 1 : 0;
  if (ma !== mb) return ma - mb;
  return a.order - b.order;
}

module.exports = { METHODS, MAX_DELAY, MAX_SCENARIOS, normalizePath, compilePattern, validateRule, validateRules, validateResponse, switchScenario, addScenario, matchRule, explainMiss };
