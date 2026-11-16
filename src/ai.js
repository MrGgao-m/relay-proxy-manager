'use strict';

// AI 辅助生成：只在主进程调用，只生成“候选数据”，不介入运行时的请求链路。
// 不依赖供应商的 response_format：用提示词约束 + 本地校验，不合格自动重试 1 次。

const Ajv = require('ajv');
const { compileTemplate } = require('./template');
const { toRulePath } = require('./openapi');

const PROVIDERS = ['openai', 'anthropic'];
const DEFAULT_SETTINGS = { provider: 'openai', baseUrl: '', model: '', timeoutMs: 60_000, customPrompt: '' };
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const MAX_SAMPLE_CHARS = 60_000;
const CHUNK_CHARS = 24_000;
const MAX_CHUNKS = 8;

const PLACEHOLDER_SPEC = `占位符语法（写在 JSON 的字符串值里，每次请求会被渲染成不同的值）：
{{uuid}} {{name}}(中文姓名) {{phone}} {{email}} {{city}} {{bool}} {{int 最小 最大}} {{float 最小 最大 小数位}} {{date 最早偏移天 最晚偏移天}} {{datetime 最早偏移天 最晚偏移天}} {{pick 选项1 选项2}} {{text 字数}} {{seq}} {{params.字段}} {{query.字段}}
规则：1) 整个字符串值恰好是一个占位符时会输出对应类型（"{{int 1 9}}" 输出数字，"{{bool}}" 输出布尔）；2) 数组的第一个元素写 "{{repeat 最少 最多}}"，其后的元素会被重复生成若干轮；3) 只能使用上面列出的占位符，不要自造。`;

function validateAiSettings(input) {
  const provider = String(input?.provider || DEFAULT_SETTINGS.provider);
  if (!PROVIDERS.includes(provider)) throw new Error('接口类型只能是 OpenAI 兼容或 Anthropic。');
  const baseUrl = String(input?.baseUrl || '').trim().replace(/\/+$/, '');
  if (baseUrl) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new Error('API 地址格式不正确，需包含 http:// 或 https://。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('API 地址只支持 HTTP / HTTPS，且不能包含账号密码。');
    if (url.search || url.hash) throw new Error('API 地址不能包含查询参数或 # 锚点。');
  }
  const model = String(input?.model || '').trim();
  if (model.length > 100) throw new Error('模型名称不能超过 100 个字符。');
  const timeoutMs = input?.timeoutMs === undefined ? DEFAULT_SETTINGS.timeoutMs : Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 300_000) throw new Error('超时时间需为 5–300 秒。');
  const customPrompt = String(input?.customPrompt || '').trim();
  if (customPrompt.length > 2000) throw new Error('自定义提示词不能超过 2000 个字符。');
  return { provider, baseUrl, model, timeoutMs, customPrompt };
}

const redact = (text, key) => (key ? String(text).split(key).join('****') : String(text));

function endpointUrl(settings) {
  const base = settings.baseUrl;
  if (settings.provider === 'anthropic') return `${base.replace(/\/v1$/, '')}/v1/messages`;
  return `${base}/chat/completions`;
}

function describeHttpError(status, detail) {
  const tail = detail ? `：${detail}` : '';
  if (status === 401 || status === 403) return `API Key 无效或没有权限（HTTP ${status}）${tail}`;
  if (status === 404) return `API 地址或模型名称不正确（HTTP 404）${tail}`;
  if (status === 429) return `请求过于频繁或额度不足（HTTP 429）${tail}`;
  if (status >= 500) return `AI 服务暂时不可用（HTTP ${status}）${tail}`;
  return `AI 服务返回错误（HTTP ${status}）${tail}`;
}

class AiClient {
  constructor({ getSettings, getApiKey, fetchImpl }) {
    this.getSettings = getSettings;
    this.getApiKey = getApiKey;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async chat({ system, user, signal }) {
    const settings = this.getSettings();
    const key = await this.getApiKey();
    if (!settings.baseUrl || !settings.model) throw new Error('请先在「AI 设置」中填写 API 地址和模型名称。');
    if (!key) throw new Error('请先在「AI 设置」中填写 API Key。');
    const fullSystem = settings.customPrompt ? `${system}\n\n用户补充要求：${settings.customPrompt}` : system;
    const anthropic = settings.provider === 'anthropic';
    const headers = anthropic
      ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { 'content-type': 'application/json', authorization: `Bearer ${key}` };
    const body = anthropic
      ? { model: settings.model, max_tokens: 4096, system: fullSystem, messages: [{ role: 'user', content: user }] }
      : { model: settings.model, messages: [{ role: 'system', content: fullSystem }, { role: 'user', content: user }] };

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, settings.timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    try {
      let response;
      try {
        response = await this.fetch(endpointUrl(settings), { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      } catch (err) {
        if (timedOut) throw new Error(`AI 请求超时（${Math.round(settings.timeoutMs / 1000)} 秒），可以在「AI 设置」中调大超时时间。`);
        if (signal?.aborted) throw new Error('已取消。');
        const code = err.cause?.code || err.code || err.message;
        throw new Error(`无法连接到 AI 服务（${new URL(settings.baseUrl).origin}）：${redact(code, key)}`);
      }
      const raw = await response.text();
      let payload;
      try { payload = JSON.parse(raw); } catch { payload = null; }
      if (!response.ok) {
        const message = payload?.error?.message || payload?.message || (typeof payload?.error === 'string' ? payload.error : '') || raw.slice(0, 200);
        throw new Error(describeHttpError(response.status, redact(String(message).slice(0, 200), key)));
      }
      const text = anthropic
        ? (payload?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('')
        : payload?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('AI 服务返回了空内容或无法识别的响应格式。');
      return text;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async testConnection() {
    const started = Date.now();
    await this.chat({ system: '你是连接测试助手。', user: '请只回复 OK' });
    return { ok: true, ms: Date.now() - started, model: this.getSettings().model };
  }

  /** 把一份固定样例改写成动态模板。返回 { template, preview }。 */
  async templateFromSample(sampleText, { hint = '', signal } = {}) {
    if (String(sampleText).length > MAX_SAMPLE_CHARS) throw new Error('样例过长（超过 6 万字符），请先精简后再生成。');
    let sample; let sampleIsJson = false;
    try { sample = JSON.parse(sampleText); sampleIsJson = sample !== null && typeof sample === 'object'; } catch { /* 纯文本样例 */ }
    const system = `你是 API Mock 数据助手。把用户给出的固定响应样例改写成“动态模板”，只输出模板本身，不要解释，不要使用 Markdown 代码块。\n${PLACEHOLDER_SPEC}`;
    const user = `${hint ? `接口说明：${hint}\n` : ''}要求：保持与样例完全相同的结构和字段名；把适合随机的值（姓名、手机号、ID、数量、金额、日期、布尔、枚举等）换成占位符；code、status、message 等表示结果的字段保持不变；列表用 repeat 让条数随机；不要新增或删除字段。\n样例：\n${sampleText}`;
    return this.#withRetry(system, user, (text) => {
      const template = stripFence(text);
      if (sampleIsJson) {
        let parsed;
        try { parsed = JSON.parse(template); } catch { throw new Error('返回的模板不是合法 JSON'); }
        const diff = sameShape(sample, parsed);
        if (diff) throw new Error(`模板结构与样例不一致：${diff}`);
      }
      const compiled = compileTemplate(template); // 占位符非法时在此抛出
      if (!compiled.dynamic) throw new Error('返回的内容没有使用任何占位符');
      const rendered = compiled.render({ params: {}, query: {} });
      if (sampleIsJson) JSON.parse(rendered);
      return { template: prettyIfJson(template), preview: prettyIfJson(rendered) };
    }, signal);
  }

  /** 依据接口文档（Schema 或示例）生成响应 Body；dynamic 为 true 时生成模板。返回 { body, dynamic }。 */
  async generateBody(endpoint, { dynamic = false, signal } = {}) {
    const chosen = (endpoint.responses || []).find((r) => r.status === endpoint.successStatus) || (endpoint.responses || []).find((r) => r.status === 'default');
    if (!chosen || (!chosen.schema && chosen.example === undefined)) throw new Error('该接口没有响应 Schema 或示例，无法生成，请先补充文档。');
    const validate = chosen.schema ? compileSchema(chosen.schema) : null;
    const system = `你是 API Mock 数据助手。根据接口文档生成响应数据，只输出结果本身，不要解释，不要使用 Markdown 代码块。${dynamic ? `\n${PLACEHOLDER_SPEC}` : ''}`;
    const user = [
      `接口：${endpoint.method} ${endpoint.path}${endpoint.summary ? `（${endpoint.summary}）` : ''}`,
      chosen.schema ? `响应 JSON Schema：\n${JSON.stringify(chosen.schema)}` : '',
      chosen.example !== undefined ? `文档中的响应示例：\n${typeof chosen.example === 'string' ? chosen.example : JSON.stringify(chosen.example)}` : '',
      dynamic
        ? '请生成“动态模板”：保持 Schema 规定的结构、字段名和类型；适合随机的字段用占位符，列表用 repeat；渲染后必须符合 Schema。'
        : '请生成一份符合 Schema 的 JSON 响应数据：字段齐全、类型正确，使用真实感强的中文业务数据，列表给 2–3 条。',
    ].filter(Boolean).join('\n');
    return this.#withRetry(system, user, (text) => {
      const out = stripFence(text);
      const compiled = compileTemplate(out);
      if (dynamic && !compiled.dynamic) throw new Error('返回的内容没有使用任何占位符');
      const rendered = compiled.render({ params: {}, query: {} });
      let value;
      try { value = JSON.parse(rendered); } catch { throw new Error('返回的内容不是合法 JSON'); }
      if (validate && !validate(value)) throw new Error(`不符合响应 Schema：${(validate.errors || []).slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message}`).join('；')}`);
      if (!validate && chosen.example && typeof chosen.example === 'object') {
        let parsed;
        try { parsed = JSON.parse(out); } catch { throw new Error('模板不是合法 JSON'); }
        const diff = sameShape(chosen.example, parsed);
        if (diff) throw new Error(`与文档示例结构不一致：${diff}`);
      }
      return { body: prettyIfJson(out), dynamic: dynamic && compiled.dynamic };
    }, signal);
  }

  /** 从 Markdown 文档提取接口清单（长文档按标题分块）。返回 { endpoints, warnings }。 */
  async extractEndpoints(markdown, { signal } = {}) {
    const chunks = chunkMarkdown(markdown);
    if (chunks.length > MAX_CHUNKS) throw new Error(`文档过长（需要 ${chunks.length} 次请求，上限 ${MAX_CHUNKS}），请拆分文档后再导入。`);
    const endpoints = []; const seen = new Set(); const warnings = [];
    for (const [index, chunk] of chunks.entries()) {
      const system = '你是 API 文档解析助手。只输出 JSON 数组，不要解释，不要使用 Markdown 代码块。';
      const user = `从下面的接口文档中提取接口清单。输出 JSON 数组，每项形如：
{"method":"GET","path":"/patient/detail/{id}","summary":"患者详情","params":[{"name":"id","in":"path","required":true,"type":"string","description":""}],"status":200,"responseExample":{},"needsConfirm":[]}
规则：只提取文档中明确存在的接口，不要编造；文档没写的信息不要猜测，把不确定之处写进 needsConfirm；没有响应示例时 responseExample 为 null；status 文档没写就用 200 并在 needsConfirm 里说明；路径参数统一写成 {name}；文档里写了“统一前缀”或“接口一览”（完整路径）时，path 必须写完整路径，不要只写标题里的短路径；示例里的注释、省略号（...）要去掉，输出合法 JSON。没有任何接口时输出 []。
文档：
${chunk}`;
      const items = await this.#withRetry(system, user, (text) => {
        let parsed;
        try { parsed = JSON.parse(extractJsonText(text)); } catch { throw new Error('返回的不是合法 JSON 数组'); }
        if (!Array.isArray(parsed)) throw new Error('返回的不是 JSON 数组');
        return parsed.map(normalizeAiEndpoint);
      }, signal);
      for (const endpoint of items) {
        if (seen.has(endpoint.id)) { warnings.push(`重复接口 ${endpoint.id} 已忽略`); continue; }
        seen.add(endpoint.id); endpoints.push(endpoint);
      }
      if (chunks.length > 1) warnings.push(`第 ${index + 1}/${chunks.length} 段识别出 ${items.length} 个接口`);
    }
    return { endpoints, warnings };
  }

  async #withRetry(system, user, parse, signal) {
    let lastError;
    let prompt = user;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const text = await this.chat({ system, user: prompt, signal });
      try { return parse(text); } catch (err) {
        lastError = err;
        prompt = `${user}\n\n上一次的输出有问题：${err.message}。请修正后重新输出（仍然只输出结果本身）。上一次的输出：\n${text.slice(0, 4000)}`;
      }
    }
    throw new Error(`AI 生成的内容未通过校验（已自动重试 1 次）：${lastError.message}`);
  }
}

// ---------- 校验与辅助 ----------

function stripFence(text) {
  const trimmed = String(text).trim();
  const fence = trimmed.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  return (fence ? fence[1] : trimmed).trim();
}

function extractJsonText(text) {
  const stripped = stripFence(text);
  try { JSON.parse(stripped); return stripped; } catch { /* 尝试截取首个 JSON 片段 */ }
  const start = stripped.search(/[[{]/);
  const end = Math.max(stripped.lastIndexOf(']'), stripped.lastIndexOf('}'));
  return start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
}

function prettyIfJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function sameShape(a, b, path = '$') {
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return `${path} 应为数组`;
    const items = typeof b[0] === 'string' && /^\{\{\s*repeat/.test(b[0]) ? b.slice(1) : b;
    return a.length && items.length ? sameShape(a[0], items[0], `${path}[0]`) : null;
  }
  if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return `${path} 应为对象`;
    const missing = Object.keys(a).filter((k) => !(k in b));
    const extra = Object.keys(b).filter((k) => !(k in a));
    if (missing.length) return `${path} 缺少字段 ${missing.join('、')}`;
    if (extra.length) return `${path} 多出字段 ${extra.join('、')}`;
    for (const key of Object.keys(a)) { const diff = sameShape(a[key], b[key], `${path}.${key}`); if (diff) return diff; }
  }
  return null;
}

const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'required' && !Array.isArray(value)) continue; // Swagger 2 属性级 required: true
    if (key === 'example' || key === 'description') continue;
    out[key] = key === 'properties' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanSchema(v)])) : cleanSchema(value);
  }
  return out;
}
function compileSchema(schema) {
  try { return ajv.compile(cleanSchema(schema)); } catch { return null; } // Schema 本身有问题时不做校验，不阻塞生成
}

function chunkMarkdown(text) {
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks = []; let current = '';
  for (const line of text.split(/\r?\n/)) {
    if (current.length + line.length > CHUNK_CHARS && /^#{1,6}\s/.test(line) && current) { chunks.push(current); current = ''; }
    current += `${line}\n`;
    if (current.length > CHUNK_CHARS * 1.5) { chunks.push(current); current = ''; } // 没有标题可切时硬切，避免无限增长
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function normalizeAiEndpoint(item) {
  const method = String(item?.method || '').toUpperCase();
  if (!METHODS.includes(method)) throw new Error(`接口 ${JSON.stringify(item?.path)} 的 method 不合法`);
  const rawPath = String(item?.path || '').trim();
  if (!rawPath.startsWith('/')) throw new Error(`接口路径必须以 / 开头：${rawPath || '(空)'}`);
  const path = toRulePath(rawPath.split('?')[0]);
  const needsConfirm = Array.isArray(item.needsConfirm) ? item.needsConfirm.map(String).filter(Boolean) : [];
  needsConfirm.push('由 AI 从文档提取，请核对方法、路径和响应');
  const status = Number.isInteger(Number(item.status)) && item.status >= 200 && item.status <= 599 ? Number(item.status) : 200;
  const example = item.responseExample === null || item.responseExample === undefined ? undefined : item.responseExample;
  if (example === undefined) needsConfirm.push('没有响应示例，将生成空对象');
  return {
    id: `${method} ${path}`, method, path, summary: String(item.summary || '').slice(0, 200), tags: [],
    params: (Array.isArray(item.params) ? item.params : []).filter((p) => p?.name).map((p) => ({ name: String(p.name), in: String(p.in || 'query'), required: Boolean(p.required), type: String(p.type || 'string'), description: String(p.description || '') })),
    requestBody: null, responses: [{ status, description: '', ...(example !== undefined ? { example } : {}) }], successStatus: status, needsConfirm,
  };
}

/** 有限并发执行；worker 抛错只影响该项。signal 取消后剩余项标记为已取消。 */
async function runBatch(items, limit, worker, { signal, onProgress } = {}) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next; next += 1;
      if (signal?.aborted) { results[index] = { ok: false, error: '已取消' }; onProgress?.(index, results[index]); continue; }
      onProgress?.(index, { running: true });
      try { results[index] = { ok: true, value: await worker(items[index], index) }; } catch (err) { results[index] = { ok: false, error: err.message }; }
      onProgress?.(index, results[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

module.exports = { AiClient, validateAiSettings, DEFAULT_SETTINGS, PLACEHOLDER_SPEC, sameShape, runBatch, chunkMarkdown, redact };
