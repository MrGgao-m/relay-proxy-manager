'use strict';

// Swagger 2.0 / OpenAPI 3.x 本地解析：JSON、YAML，内部 $ref，allOf/oneOf/anyOf，默认取成功的 2xx 响应。

const yaml = require('js-yaml');

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const MAX_ENDPOINTS = 2000;
const MAX_DEPTH = 10;

function parseText(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_DOC_BYTES) throw new Error('文档超过 10 MB，已拒绝导入。');
  const trimmed = text.replace(/^﻿/, '');
  try { return JSON.parse(trimmed); } catch { /* 不是 JSON，继续按 YAML 解析 */ }
  try { return yaml.load(trimmed, { schema: yaml.JSON_SCHEMA }); } catch (err) {
    throw new Error(`文档不是有效的 JSON 或 YAML：${String(err.message).split('\n')[0]}`);
  }
}

/** 把 {id} 形式的路径参数转换成规则使用的 :id。 */
function toRulePath(path) {
  const converted = String(path).replace(/\{([^}/]+)\}/g, (_, name) => `:${name.replace(/[^A-Za-z0-9_]/g, '_')}`);
  return converted.startsWith('/') ? converted : `/${converted}`;
}

function createResolver(doc, warnings) {
  const pointer = (ref) => ref.slice(2).split('/').map((part) => decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~'));
  const lookup = (ref) => {
    if (!ref.startsWith('#/')) { warnings.add(`外部引用 ${ref} 未解析`); return undefined; }
    let node = doc;
    for (const part of pointer(ref)) { node = node?.[part]; if (node === undefined) break; }
    if (node === undefined) warnings.add(`引用 ${ref} 找不到`);
    return node;
  };

  /** 展开 $ref 与组合关键字，返回简化后的 schema；循环引用与过深嵌套被截断。 */
  function simplify(schema, stack = [], depth = 0) {
    if (!schema || typeof schema !== 'object') return {};
    if (depth > MAX_DEPTH) return {};
    if (schema.$ref) {
      if (stack.includes(schema.$ref)) return { type: 'object', description: '（循环引用，已截断）' };
      return simplify(lookup(schema.$ref), [...stack, schema.$ref], depth + 1);
    }
    let base = { ...schema };
    if (Array.isArray(schema.allOf)) {
      const merged = { type: 'object', properties: {}, required: [] };
      for (const part of schema.allOf.map((p) => simplify(p, stack, depth + 1))) {
        Object.assign(merged.properties, part.properties || {});
        merged.required.push(...(part.required || []));
        for (const k of ['type', 'items', 'enum', 'example', 'format']) if (part[k] !== undefined) merged[k] = part[k];
      }
      base = { ...merged, ...Object.fromEntries(Object.entries(schema).filter(([k]) => !['allOf'].includes(k))) };
      base.properties = { ...merged.properties, ...(schema.properties ? simplifyProps(schema.properties, stack, depth) : {}) };
    }
    for (const key of ['oneOf', 'anyOf']) {
      if (Array.isArray(schema[key]) && schema[key].length) base = { ...simplify(schema[key][0], stack, depth + 1), ...Object.fromEntries(Object.entries(base).filter(([k]) => !['oneOf', 'anyOf'].includes(k))) };
    }
    const out = {};
    for (const k of ['type', 'format', 'enum', 'example', 'default', 'description', 'nullable', 'minimum', 'maximum', 'required']) if (base[k] !== undefined) out[k] = base[k];
    if (base.properties) out.properties = simplifyProps(base.properties, stack, depth);
    if (base.items) out.items = simplify(base.items, stack, depth + 1);
    if (base.additionalProperties && typeof base.additionalProperties === 'object') out.additionalProperties = simplify(base.additionalProperties, stack, depth + 1);
    if (!out.type && out.properties) out.type = 'object';
    if (!out.type && out.items) out.type = 'array';
    return out;
  }
  function simplifyProps(props, stack, depth) {
    return Object.fromEntries(Object.entries(props).map(([name, child]) => [name, simplify(child, stack, depth + 1)]));
  }
  const deref = (node) => (node?.$ref ? lookup(node.$ref) : node);
  return { simplify, deref };
}

function pickExample(holder) {
  if (!holder) return undefined;
  if (holder.example !== undefined) return holder.example;
  if (holder.examples && typeof holder.examples === 'object') {
    const first = Object.values(holder.examples)[0];
    return first && typeof first === 'object' && 'value' in first ? first.value : first;
  }
  return undefined;
}

function pickSuccess(responses) {
  const numeric = Object.keys(responses).filter((s) => /^2\d\d$/.test(s)).sort();
  if (numeric.length) return { status: Number(numeric.includes('200') ? '200' : numeric[0]), note: null };
  if (responses['2XX'] || responses['2xx']) return { status: 200, note: '文档只声明了 2XX，按 200 处理' };
  if (responses.default) return { status: 200, note: '文档只声明了 default 响应，按 200 处理' };
  return { status: 200, note: '文档没有声明成功响应，按 200 处理' };
}

/** 解析 Swagger / OpenAPI 文本，返回 { info, endpoints, warnings }。 */
function parseOpenApi(text) {
  const doc = parseText(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('文档内容不是对象，不是 Swagger / OpenAPI 文档。');
  const isV2 = typeof doc.swagger === 'string' && doc.swagger.startsWith('2');
  const isV3 = typeof doc.openapi === 'string' && /^3\./.test(doc.openapi);
  if (!isV2 && !isV3) throw new Error('未找到 swagger: "2.0" 或 openapi: "3.x" 字段，不是受支持的 Swagger / OpenAPI 文档。');
  if (!doc.paths || typeof doc.paths !== 'object' || !Object.keys(doc.paths).length) throw new Error('文档中没有 paths，无法生成接口清单。');

  const warnings = new Set();
  const { simplify, deref } = createResolver(doc, warnings);
  const endpoints = [];

  for (const [rawPath, item] of Object.entries(doc.paths)) {
    const pathItem = deref(item) || {};
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      if (endpoints.length >= MAX_ENDPOINTS) throw new Error(`接口数量超过 ${MAX_ENDPOINTS}，请拆分文档后再导入。`);

      const paramMap = new Map();
      for (const raw of [...(pathItem.parameters || []), ...(op.parameters || [])]) {
        const param = deref(raw);
        if (!param?.name) continue;
        paramMap.set(`${param.in}:${param.name}`, param);
      }
      let requestBody = null;
      const params = [];
      for (const param of paramMap.values()) {
        if (param.in === 'body') { requestBody = { schema: simplify(param.schema), example: pickExample(param) }; continue; }
        params.push({ name: param.name, in: param.in, required: Boolean(param.required), type: simplify(param.schema || param).type || 'string', description: param.description || '' });
      }
      if (isV3 && op.requestBody) {
        const body = deref(op.requestBody);
        const content = body?.content?.['application/json'] || Object.values(body?.content || {})[0];
        if (content) requestBody = { schema: simplify(content.schema), example: pickExample(content) };
      }

      const responses = [];
      const declared = op.responses || {};
      for (const [status, raw] of Object.entries(declared)) {
        const resp = deref(raw) || {};
        let schema; let example;
        if (isV3) {
          const content = resp.content?.['application/json'] || Object.values(resp.content || {})[0];
          if (content) { schema = content.schema ? simplify(content.schema) : undefined; example = pickExample(content); }
        } else {
          schema = resp.schema ? simplify(resp.schema) : undefined;
          example = resp.examples ? (resp.examples['application/json'] ?? Object.values(resp.examples)[0]) : undefined;
        }
        if (example === undefined && schema?.example !== undefined) example = schema.example;
        responses.push({ status: /^\d+$/.test(status) ? Number(status) : status, description: resp.description || '', ...(schema ? { schema } : {}), ...(example !== undefined ? { example } : {}) });
      }
      const success = pickSuccess(declared);
      const needsConfirm = [];
      if (success.note) needsConfirm.push(success.note);
      const chosen = responses.find((r) => r.status === success.status) || responses.find((r) => r.status === 'default');
      if (!chosen || (!chosen.schema && chosen.example === undefined)) needsConfirm.push('成功响应没有 Schema 或示例，将生成空对象');

      const path = toRulePath(rawPath);
      endpoints.push({
        id: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path,
        summary: op.summary || op.description?.split('\n')[0] || op.operationId || '', tags: op.tags || [],
        params, requestBody, responses, successStatus: success.status, needsConfirm,
      });
    }
  }
  if (!endpoints.length) throw new Error('文档的 paths 下没有任何接口方法。');
  endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const info = { title: doc.info?.title || '', version: doc.info?.version || '', specVersion: doc.swagger || doc.openapi, basePath: isV2 ? (doc.basePath || '') : (doc.servers?.[0]?.url || '') };
  return { info, endpoints, warnings: [...warnings] };
}

module.exports = { parseOpenApi, parseText, toRulePath, MAX_DOC_BYTES };
