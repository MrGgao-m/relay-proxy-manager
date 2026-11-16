'use strict';

// 把文档里的接口变成“规则草稿”（预览用，不落盘），确认后再合并进目标代理 / Mock 服务。

const { exampleFromSchema, templatizeSample } = require('./sample-gen');
const { validateRule, validateRules } = require('./rules');

const ruleKey = (rule) => `${rule.method} ${rule.path.replace(/:[A-Za-z0-9_]+/g, ':')}`;

function chooseResponse(endpoint) {
  const responses = endpoint.responses || [];
  return responses.find((r) => r.status === endpoint.successStatus) || responses.find((r) => r.status === 'default') || responses[0];
}

/** 本地生成响应 Body：优先用文档里的示例；没有示例时由 Schema 生成；dynamic 时输出占位符模板。 */
function localBody(endpoint, { dynamic = false } = {}) {
  const chosen = chooseResponse(endpoint);
  let value;
  if (chosen?.schema) value = (!dynamic && chosen.example !== undefined) ? chosen.example : exampleFromSchema(chosen.schema, { dynamic });
  else if (chosen?.example !== undefined) value = dynamic && typeof chosen.example === 'object' ? templatizeSample(chosen.example) : chosen.example;
  else value = {};
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { body, dynamic: dynamic && typeof value === 'object' && /\{\{/.test(body) };
}

/** 规则路径要去掉代理前缀：文档写的是完整路径（/cgw/aiadmin/x）时，生成到代理里就应是 /x。 */
function relativePath(path, prefix) {
  if (!prefix) return { path, adjusted: false };
  if (path === prefix) return { path: '/', adjusted: true };
  return path.startsWith(`${prefix}/`) ? { path: path.slice(prefix.length), adjusted: true } : { path, adjusted: false };
}

function buildDraft(docId, endpoint, { body, dynamic }, existing = [], { prefix = '' } = {}) {
  const target = relativePath(endpoint.path, prefix);
  const isJson = (() => { try { JSON.parse(body); return true; } catch { return /\{\{/.test(body) && /^\s*[{[]/.test(body); } })();
  const rule = {
    method: endpoint.method, path: target.path, mode: 'mock', enabled: true, note: String(endpoint.summary || '').slice(0, 200),
    source: { type: 'doc', ref: `${docId}:${endpoint.id}`.slice(0, 200) },
    response: {
      status: Number.isInteger(endpoint.successStatus) ? endpoint.successStatus : 200,
      headers: isJson ? [{ name: 'Content-Type', value: 'application/json; charset=utf-8', enabled: true }] : [],
      body, bodyEncoding: 'text', dynamic: Boolean(dynamic), delayMs: 0,
    },
  };
  const valid = validateRule(rule); // 生成结果同样要通过规则校验
  const warn = [];
  if (!isJson && /^\s*[{[]/.test(body)) warn.push('响应 Body 看起来是 JSON，但不是合法 JSON，请检查后再保存');
  return {
    endpointId: endpoint.id, rule: valid, needsConfirm: [...(endpoint.needsConfirm || []), ...warn],
    pathAdjusted: target.adjusted ? `已去掉代理前缀 ${prefix}（文档路径 ${endpoint.path}）` : null,
    conflict: existing.some((r) => ruleKey(r) === ruleKey(valid)),
  };
}

function localDrafts(docId, endpoints, options, existing, context) {
  return endpoints.map((endpoint) => buildDraft(docId, endpoint, localBody(endpoint, options), existing, context));
}

/** 合并草稿：冲突时跳过或覆盖（覆盖保留原规则 ID）。全部校验通过才返回，失败则抛错、不改动原规则。 */
function applyDrafts(existing, drafts, { conflict = 'skip', forceMock = false } = {}) {
  const rules = existing.map((rule) => ({ ...rule }));
  const counts = { added: 0, overwritten: 0, skipped: 0 };
  for (const draft of drafts) {
    const fresh = validateRule({ ...draft.rule, id: undefined });
    const index = rules.findIndex((r) => ruleKey(r) === ruleKey(fresh));
    // 覆盖时只替换当前启用场景的数据，保留其他场景
    if (index < 0) { rules.push(fresh); counts.added += 1; } else if (conflict === 'overwrite') { rules[index] = { ...rules[index], response: fresh.response, note: fresh.note, source: fresh.source }; counts.overwritten += 1; } else counts.skipped += 1;
  }
  const validated = validateRules(rules);
  return { rules: forceMock ? validated.map((r) => ({ ...r, mode: 'mock' })) : validated, ...counts };
}

module.exports = { localBody, buildDraft, localDrafts, applyDrafts, chooseResponse, ruleKey };
