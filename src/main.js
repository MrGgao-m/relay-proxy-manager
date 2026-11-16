'use strict';

const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const { ProxyManager, validateProxy, validateMockService, validateHeaders } = require('./proxy-manager');
const { validateRules, validateRule, switchScenario, addScenario } = require('./rules');
const { compileTemplate } = require('./template');
const store = require('./store');
const { exportMockConfig, importMockConfig } = require('./mock-io');
const { parseOpenApi } = require('./openapi');
const { parseMarkdownDoc } = require('./markdown-doc');
const { localDrafts, buildDraft, applyDrafts } = require('./doc-drafts');
const { templatizeSample } = require('./sample-gen');
const { AiClient, validateAiSettings, DEFAULT_SETTINGS, runBatch } = require('./ai');
const secrets = require('./secrets');

const deps = { validateProxy, validateMockService };
const MAX_DOCS = 20;
const jobs = new Map(); // AI 批量任务：jobId → AbortController

const ai = new AiClient({
  getSettings: () => config.app.ai,
  getApiKey: () => secrets.loadApiKey(dataDir(), safeStorage),
});

let mainWindow;
let config = store.defaultConfig();
let migrationIssues = [];
let logs = [];
let writing = Promise.resolve();
const MAX_LOGS = 5000;
const MAX_TRACES = 300;
const traces = new Map();
const SKIP_COPY_HEADERS = new Set(['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'date', 'server', 'vary']);

const dataDir = () => app.getPath('userData');

function safeData() {
  const project = store.activeProject(config);
  return {
    // 旧界面字段：当前项目的代理与公共 Header
    proxies: project.proxies,
    mockServices: project.mockServices,
    docs: project.docs.map(docSummary),
    globalHeaders: project.headers,
    running: manager.status(),
    projects: config.projects.map((p) => ({ id: p.id, name: p.name, proxyCount: p.proxies.length, mockCount: p.mockServices.length })),
    activeProjectId: config.activeProjectId,
    migrationIssues,
  };
}

function docSummary(doc) {
  return {
    id: doc.id, name: doc.name, type: doc.type, importedAt: doc.importedAt, info: doc.info,
    endpointCount: doc.endpoints.length, needsConfirmCount: doc.endpoints.filter((e) => e.needsConfirm.length).length,
    warnings: doc.warnings, skipped: doc.skipped,
  };
}

function publish() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:changed', safeData());
  }
}

const manager = new ProxyManager((entry) => {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('log:added', entry);
}, publish, (trace) => {
  traces.set(trace.id, trace);
  if (traces.size > MAX_TRACES) traces.delete(traces.keys().next().value);
});

function syncProjectHeaders() {
  for (const project of config.projects) manager.setProjectHeaders(project.id, project.headers);
}

async function loadData() {
  const loaded = await store.loadConfig(dataDir(), deps);
  config = loaded.config;
  try { config.app.ai = validateAiSettings(config.app.ai); } catch { config.app.ai = { ...DEFAULT_SETTINGS }; }
  migrationIssues = loaded.issues;
  syncProjectHeaders();
  if (loaded.migrated) console.log(`已从 v1.2 迁移配置，${loaded.issues.length} 条需要处理。`);
}

function saveData() {
  writing = writing.then(() => store.saveConfig(dataDir(), config)).catch((err) => console.error('保存配置失败：', err));
  return writing;
}

/** 代理和独立 Mock 服务共用启停与规则接口；proxy 字段是 item 的别名。 */
function locate(id) {
  const found = store.findService(config, id);
  if (!found) throw new Error('找不到此代理或 Mock 服务，它可能已被删除。');
  return { project: found.project, proxy: found.item, item: found.item, kind: found.kind };
}

function runtimeConfig({ project, proxy }) { return { ...proxy, projectId: project.id }; }

function clearRuntimeData(ids) {
  const set = new Set(ids);
  logs = logs.filter((log) => !set.has(log.proxyId));
  for (const [traceId, trace] of traces) if (set.has(trace.proxyId)) traces.delete(traceId);
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    try { return { ok: true, data: await callback(...args) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
}

handle('state:get', () => safeData());

// ---------- 项目 ----------
handle('project:add', async (name) => {
  const project = store.addProject(config, name);
  await saveData();
  publish();
  return { id: project.id, name: project.name };
});
handle('project:rename', async (id, name) => {
  store.renameProject(config, id, name);
  await saveData();
  publish();
});
handle('project:select', async (id) => {
  store.setActiveProject(config, id);
  await saveData();
  publish();
});
handle('project:delete', async (id) => {
  const ids = store.deleteProject(config, id);
  await Promise.all(ids.map((serviceId) => manager.stop(serviceId)));
  clearRuntimeData(ids);
  await saveData();
  publish();
});

// ---------- Header / 代理 ----------
const saveProjectHeaders = async (headers) => {
  const project = store.activeProject(config);
  project.headers = validateHeaders(headers);
  manager.setProjectHeaders(project.id, project.headers);
  await saveData();
  publish();
  return project.headers;
};
handle('global-headers:save', saveProjectHeaders);
handle('project-headers:save', saveProjectHeaders);

handle('proxy:save', async (input, id) => {
  const existing = id ? store.findProxy(config, id) : null;
  if (id && !existing) throw new Error('找不到此代理，它可能已被删除。');
  // 编辑代理表单不包含接口规则，必须沿用原有规则，否则会被清空
  const proxy = validateProxy({ ...input, rules: existing ? existing.proxy.rules : [] }, id);
  store.assertPortFree(config, proxy.port, id);
  if (existing) existing.project.proxies[existing.project.proxies.indexOf(existing.proxy)] = proxy;
  else store.activeProject(config).proxies.push(proxy);
  await saveData();
  publish();
  return proxy;
});
handle('proxy:delete', async (id) => {
  const { project, kind } = locate(id);
  if (kind !== 'proxy') throw new Error('这不是代理，请使用删除 Mock 服务。');
  await manager.stop(id);
  project.proxies = project.proxies.filter((p) => p.id !== id);
  clearRuntimeData([id]);
  await saveData();
  publish();
});
handle('proxy:start', async (id) => {
  const found = locate(id);
  try { await manager.start(runtimeConfig(found)); }
  catch (err) {
    manager.log(id, 'error', 'error', `启动失败：${err.message}`);
    throw err;
  }
});
handle('proxy:stop', (id) => manager.stop(id));
handle('proxy:restart', async (id) => {
  await manager.stop(id);
  await manager.start(runtimeConfig(locate(id)));
});

// ---------- 独立 Mock 服务 ----------
handle('mock:save', async (input, id) => {
  const existing = id ? store.findService(config, id) : null;
  if (id && (!existing || existing.kind !== 'mock')) throw new Error('找不到此 Mock 服务，它可能已被删除。');
  const service = validateMockService({ ...input, rules: existing ? existing.item.rules : [] }, id);
  store.assertPortFree(config, service.port, id);
  if (existing) existing.project.mockServices[existing.project.mockServices.indexOf(existing.item)] = service;
  else store.activeProject(config).mockServices.push(service);
  await saveData();
  publish();
  return service;
});
handle('mock:delete', async (id) => {
  const found = locate(id);
  if (found.kind !== 'mock') throw new Error('这不是 Mock 服务。');
  await manager.stop(id);
  found.project.mockServices = found.project.mockServices.filter((m) => m.id !== id);
  clearRuntimeData([id]);
  await saveData();
  publish();
});
handle('mock:duplicate', async (id) => {
  const found = locate(id);
  if (found.kind !== 'mock') throw new Error('这不是 Mock 服务。');
  const copy = store.duplicateMockService(config, found.project, id, validateMockService);
  await saveData();
  publish();
  return copy;
});
handle('mock:export', async () => {
  const project = store.activeProject(config);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出 Mock 配置',
    defaultPath: path.join(app.getPath('documents'), `mock-config-${project.name}-${new Date().toISOString().slice(0, 10)}.json`),
    filters: [{ name: 'Relay Mock 配置', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return null;
  const data = exportMockConfig(project);
  await fs.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf8');
  return { path: result.filePath, mockServices: data.mockServices.length, proxyRules: data.proxyRules.reduce((n, p) => n + p.rules.length, 0) };
});
handle('mock:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: '导入 Mock 配置', properties: ['openFile'], filters: [{ name: 'Relay Mock 配置', extensions: ['json'] }] });
  if (result.canceled || !result.filePaths?.length) return null;
  const file = result.filePaths[0];
  if ((await fs.stat(file)).size > 20 * 1024 * 1024) throw new Error('配置文件超过 20 MB，已拒绝导入。');
  let data;
  try { data = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw new Error('文件不是有效的 JSON。'); }
  const report = importMockConfig(config, store.activeProject(config), data, deps);
  await saveData();
  publish();
  return report;
});

// ---------- 接口规则（代理内手动 Mock）----------
handle('rules:get', (proxyId) => locate(proxyId).proxy.rules);
/** 切换某个接口启用的 Mock 场景，运行中即时生效。 */
handle('rules:switch', async (proxyId, ruleId, scenarioId) => {
  const { proxy } = locate(proxyId);
  const index = proxy.rules.findIndex((r) => r.id === ruleId);
  if (index < 0) throw new Error('找不到此接口规则，它可能已被删除。');
  proxy.rules = proxy.rules.map((r, i) => (i === index ? switchScenario(r, scenarioId) : r));
  if (manager.isRunning(proxyId)) manager.setRules(proxyId, proxy.rules);
  await saveData();
  publish();
  return proxy.rules[index];
});
handle('rules:save', async (proxyId, rules) => {
  const { proxy, kind } = locate(proxyId);
  proxy.rules = validateRules(rules);
  if (kind === 'mock') proxy.rules = proxy.rules.map((rule) => ({ ...rule, mode: 'mock' }));
  if (manager.isRunning(proxyId)) manager.setRules(proxyId, proxy.rules); // 运行中即时生效
  await saveData();
  publish();
  return proxy.rules;
});
/** 预览：按当前（未保存）的规则内容渲染一次响应 Body，路径参数用示例值。 */
handle('rules:preview', (draft) => {
  const rule = validateRule(draft);
  if (!rule.response.dynamic) return rule.response.body;
  const params = Object.fromEntries(rule.path.split('/').filter((seg) => seg.startsWith(':')).map((seg) => [seg.slice(1), `${seg.slice(1)}-示例`]));
  return compileTemplate(rule.response.body).render({ params, query: {} });
});
// ---------- 从真实响应生成 Mock ----------
const ruleKey = (r) => `${r.method} ${r.path.replace(/:[A-Za-z0-9_]+/g, ':')}`;

/** 取出可用于生成 Mock 的真实响应；不完整、被截断、二进制、解压失败的都明确拒绝。 */
function traceSample(traceId) {
  const trace = traces.get(traceId);
  if (!trace) throw new Error('此请求详情已不在最近 300 条记录中。');
  if (trace.source !== 'PROXY' || !trace.response) throw new Error('只有已收到后端响应的代理请求才能生成 Mock。');
  const body = trace.response.body;
  if (!body?.complete) throw new Error('响应内容尚未接收完整，请稍后再试。');
  if (body.truncated) throw new Error('响应超过 256 KB，预览不完整，不能生成 Mock。');
  if (body.binary) throw new Error('这是二进制响应，不能生成 Mock。');
  if (body.failed) throw new Error('响应内容解压失败，不能生成 Mock。');
  return { trace, text: body.body };
}

function copiedHeaders(trace) {
  const headers = [];
  for (const [name, value] of Object.entries(trace.response.headers || {})) {
    const lower = name.toLowerCase();
    if (SKIP_COPY_HEADERS.has(lower) || lower.startsWith('access-control-') || Array.isArray(value)) continue;
    try { headers.push(...validateHeaders([{ name, value: String(value), enabled: true }])); } catch { /* 无法安全复制的 Header 直接略过 */ }
  }
  return headers;
}

/**
 * 预览：根据一条真实响应生成规则草稿（不保存）。
 * mode：fixed 原样；dynamic 本地按字段名改写成动态模板；ai 由 AI 改写成模板。
 * 保存到代理时路径去掉代理前缀；保存到独立 Mock 服务时保持客户端看到的完整路径。
 */
async function draftFromTrace(traceId, { targetId, mode = 'fixed' } = {}) {
  const { trace, text } = traceSample(traceId);
  const origin = locate(trace.proxyId);
  const target = locate(targetId || trace.proxyId);
  const fullPath = trace.request.url.split('?')[0] || '/';
  const path = target.kind === 'mock' ? fullPath : (fullPath.slice(origin.proxy.prefix.length) || '/');
  const label = `${trace.request.method} ${path}`;

  let body = text; let dynamic = false; let preview = null;
  if (mode === 'dynamic') {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('响应不是 JSON，无法按字段名生成动态模板。'); }
    if (!parsed || typeof parsed !== 'object') throw new Error('响应不是 JSON 对象或数组，无法生成动态模板。');
    body = JSON.stringify(templatizeSample(parsed), null, 2);
    dynamic = true;
  } else if (mode === 'ai') {
    const result = await ai.templateFromSample(text, { hint: label });
    body = result.template; preview = result.preview; dynamic = true;
  } else if (mode !== 'fixed') throw new Error('不支持的生成方式。');

  const rule = validateRule({
    method: trace.request.method, path, mode: 'mock', enabled: true, source: { type: 'trace', ref: traceId }, note: '来自真实响应',
    response: { status: trace.response.status, headers: copiedHeaders(trace), body, bodyEncoding: 'text', dynamic, delayMs: 0 },
  });
  const existing = target.proxy.rules.find((r) => ruleKey(r) === ruleKey(rule));
  return {
    rule, preview, sampleBytes: Buffer.byteLength(text, 'utf8'),
    target: { id: target.proxy.id, name: target.proxy.name, kind: target.kind },
    existing: existing ? { id: existing.id, scenarios: [existing.scenario.name, ...existing.alternatives.map((a) => a.name)] } : null,
  };
}

/** 确认创建：新接口 → 新规则；该接口已有规则 → 追加为新场景（enabled 为 true 时立即切换到它）。 */
async function applyTraceDraft(targetId, input, { enabled = false } = {}) {
  const { proxy, kind } = locate(targetId);
  const rule = validateRule({ ...input, id: undefined, mode: 'mock', enabled: true });
  const existing = proxy.rules.find((r) => ruleKey(r) === ruleKey(rule));
  let saved;
  if (existing) {
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    saved = addScenario(existing, `真实响应 ${stamp}`, rule.response);
    if (enabled) saved = { ...switchScenario(saved, saved.alternatives.at(-1).id), enabled: true, mode: 'mock' };
    proxy.rules = proxy.rules.map((r) => (r.id === existing.id ? saved : r));
  } else {
    saved = { ...rule, enabled: Boolean(enabled) };
    proxy.rules = validateRules([...proxy.rules, saved]);
    saved = proxy.rules.find((r) => r.id === saved.id);
  }
  if (kind === 'mock') proxy.rules = proxy.rules.map((r) => ({ ...r, mode: 'mock' }));
  if (manager.isRunning(proxy.id)) manager.setRules(proxy.id, proxy.rules);
  await saveData();
  publish();
  return { ...saved, addedAsScenario: Boolean(existing) };
}

handle('rules:draft-from-trace', (traceId, options) => draftFromTrace(traceId, options));
handle('rules:apply-trace-draft', (targetId, rule, options) => applyTraceDraft(targetId, rule, options));
/** 一键创建（兼容旧入口）：原样数据，默认停用。 */
handle('rules:from-trace', async (traceId) => {
  const draft = await draftFromTrace(traceId);
  return applyTraceDraft(draft.target.id, draft.rule, { enabled: false });
});

// ---------- 接口文档（阶段 4）----------
const findDoc = (id) => {
  const doc = store.activeProject(config).docs.find((d) => d.id === id);
  if (!doc) throw new Error('找不到此接口文档，它可能已被删除。');
  return doc;
};
const pickEndpoints = (doc, ids) => {
  if (!Array.isArray(ids) || !ids.length) throw new Error('请先勾选要生成 Mock 的接口。');
  const wanted = new Set(ids);
  const endpoints = doc.endpoints.filter((e) => wanted.has(e.id));
  if (!endpoints.length) throw new Error('勾选的接口在文档中不存在。');
  return endpoints;
};

handle('docs:import', async (kind) => {
  if (!['openapi', 'markdown', 'markdown-ai'].includes(kind)) throw new Error('不支持的文档类型。');
  const project = store.activeProject(config);
  if (project.docs.length >= MAX_DOCS) throw new Error(`每个项目最多保留 ${MAX_DOCS} 份接口文档，请先删除不用的文档。`);
  const filters = kind === 'openapi'
    ? [{ name: 'Swagger / OpenAPI', extensions: ['json', 'yaml', 'yml'] }]
    : [{ name: 'Markdown 接口文档', extensions: ['md', 'markdown', 'txt'] }];
  const result = await dialog.showOpenDialog(mainWindow, { title: '导入接口文档', properties: ['openFile'], filters });
  if (result.canceled || !result.filePaths?.length) return null;
  const file = result.filePaths[0];
  if ((await fs.stat(file)).size > 10 * 1024 * 1024) throw new Error('文档超过 10 MB，已拒绝导入。');
  const text = await fs.readFile(file, 'utf8');

  let parsed;
  if (kind === 'openapi') parsed = { ...parseOpenApi(text), skipped: [] };
  else if (kind === 'markdown') {
    parsed = { info: {}, ...parseMarkdownDoc(text) };
    if (!parsed.endpoints.length) throw new Error(`没有识别到任何接口。${parsed.skipped.length ? `有 ${parsed.skipped.length} 个章节缺少请求方法或路径。` : ''}可以改用「Markdown（AI 提取）」。`);
  } else parsed = { info: {}, skipped: [], ...(await ai.extractEndpoints(text)) };
  if (!parsed.endpoints.length) throw new Error('AI 没有从文档中提取到任何接口。');

  const doc = {
    id: randomUUID(), name: store.uniqueName(project.docs.map((d) => d.name), path.basename(file)), type: kind === 'openapi' ? 'openapi' : 'markdown',
    importedAt: new Date().toISOString(), info: parsed.info || {}, warnings: parsed.warnings || [], skipped: parsed.skipped || [], endpoints: parsed.endpoints,
  };
  project.docs.push(doc); // 只保存文档本身，不会改动任何现有接口规则
  await saveData();
  publish();
  return docSummary(doc);
});
handle('docs:get', (id) => findDoc(id));
handle('docs:delete', async (id) => {
  const project = store.activeProject(config);
  findDoc(id);
  project.docs = project.docs.filter((d) => d.id !== id);
  await saveData();
  publish();
});
/** 预览：把勾选的接口在本地生成成规则草稿，不保存。 */
handle('docs:preview', (docId, endpointIds, options = {}) => {
  const doc = findDoc(docId);
  const target = locate(options.targetId);
  return localDrafts(doc.id, pickEndpoints(doc, endpointIds), { dynamic: Boolean(options.dynamic) }, target.proxy.rules, { prefix: target.kind === 'proxy' ? target.proxy.prefix : '' });
});
/** 确认：把（用户可能已编辑过的）草稿合并进目标。 */
handle('docs:apply', async (targetId, drafts, options = {}) => {
  const { proxy, kind } = locate(targetId);
  if (!Array.isArray(drafts) || !drafts.length) throw new Error('没有可保存的接口。');
  const merged = applyDrafts(proxy.rules, drafts, { conflict: options.conflict === 'overwrite' ? 'overwrite' : 'skip', forceMock: kind === 'mock' });
  proxy.rules = merged.rules;
  if (manager.isRunning(targetId)) manager.setRules(targetId, proxy.rules);
  await saveData();
  publish();
  return { added: merged.added, overwritten: merged.overwritten, skipped: merged.skipped };
});

// ---------- AI 辅助生成（阶段 5）----------
const aiView = async () => ({ ...config.app.ai, hasKey: await secrets.hasApiKey(dataDir()) });
handle('ai:get', () => aiView());
handle('ai:save', async (settings, apiKey) => {
  config.app.ai = validateAiSettings(settings);
  if (apiKey !== undefined && apiKey !== null) await secrets.saveApiKey(dataDir(), apiKey, safeStorage); // 空字符串表示清除；undefined 表示不修改
  await saveData();
  return aiView();
});
handle('ai:test', () => ai.testConnection());
/** 把固定样例改写成动态模板：只返回候选结果，由用户确认后才写入规则。 */
handle('ai:template', (body, hint) => ai.templateFromSample(body, { hint }));
/** 按规则来源的文档接口重新生成 Body（不保存）。 */
handle('ai:regenerate', async (rule, options = {}) => {
  if (rule?.source?.type !== 'doc') throw new Error('只有来自接口文档的规则才能按文档重新生成。');
  const [docId, ...rest] = String(rule.source.ref || '').split(':');
  const endpoint = findDoc(docId).endpoints.find((e) => e.id === rest.join(':'));
  if (!endpoint) throw new Error('文档中已找不到对应的接口，请重新导入文档。');
  return ai.generateBody(endpoint, { dynamic: Boolean(options.dynamic) });
});
/** 批量用 AI 生成草稿：并发 3，单条失败不影响其他，可取消，进度通过 ai:progress 推送。 */
handle('ai:generate-drafts', async (docId, endpointIds, options = {}, jobId = randomUUID()) => {
  const doc = findDoc(docId);
  const endpoints = pickEndpoints(doc, endpointIds);
  const target = locate(options.targetId);
  const controller = new AbortController();
  jobs.set(jobId, controller);
  const send = (payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ai:progress', { jobId, ...payload }); };
  try {
    const results = await runBatch(endpoints, 3, async (endpoint) => {
      const generated = await ai.generateBody(endpoint, { dynamic: Boolean(options.dynamic), signal: controller.signal });
      return buildDraft(doc.id, endpoint, generated, target.proxy.rules, { prefix: target.kind === 'proxy' ? target.proxy.prefix : '' });
    }, {
      signal: controller.signal,
      onProgress: (index, state) => send({ endpointId: endpoints[index].id, status: state.running ? 'running' : state.ok ? 'ok' : 'error', error: state.error }),
    });
    return results.map((r, i) => (r.ok ? { endpointId: endpoints[i].id, ok: true, draft: r.value } : { endpointId: endpoints[i].id, ok: false, error: r.error }));
  } finally { jobs.delete(jobId); }
});
handle('ai:cancel', (jobId) => { jobs.get(jobId)?.abort(); });

// ---------- 日志 ----------
handle('logs:get', (id) => logs.filter((log) => !id || log.proxyId === id).slice(-1000));
handle('trace:get', (id) => {
  const trace = traces.get(id);
  if (!trace) throw new Error('此请求详情已不在最近 300 条记录中。');
  const serializeBody = (capture) => capture ? {
    total: capture.total, truncated: capture.truncated, complete: capture.complete,
    binary: capture.binary || false, body: capture.body || '',
  } : null;
  return {
    id: trace.id, proxyId: trace.proxyId, startedAt: trace.startedAt, source: trace.source, ruleId: trace.ruleId, scenario: trace.scenario, missReason: trace.missReason,
    request: { ...trace.request, body: serializeBody(trace.request.body) },
    response: trace.response ? { ...trace.response, body: serializeBody(trace.response.body) } : null,
    error: trace.error,
  };
});
handle('logs:clear', (id) => {
  logs = id ? logs.filter((log) => log.proxyId !== id) : [];
  if (id) { for (const [traceId, trace] of traces) if (trace.proxyId === id) traces.delete(traceId); }
  else traces.clear();
});
handle('system:ips', () => Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address));
handle('logs:export', async (id) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出代理日志',
    defaultPath: path.join(app.getPath('documents'), `proxy-logs-${new Date().toISOString().slice(0, 10)}.txt`),
    filters: [{ name: '文本日志', extensions: ['txt'] }],
  });
  if (result.canceled || !result.filePath) return false;
  const text = logs.filter((log) => !id || log.proxyId === id)
    .map((log) => `${log.time}\t${log.level.toUpperCase()}\t${log.message}`).join('\r\n');
  await fs.writeFile(result.filePath, text || '暂无日志', 'utf8');
  return true;
});
handle('window:minimize', () => mainWindow.minimize());
handle('window:maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
handle('window:close', () => mainWindow.close());

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#f3f5f8',
    title: 'Relay 代理台',
    frame: false,
    show: false,
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(async () => {
  try { await loadData(); }
  catch (err) {
    // 配置损坏时不能带着默认配置继续运行：之后的任何保存都会覆盖用户的原文件
    dialog.showErrorBox('Relay 无法读取配置', `${err.message}\n\n配置目录：${dataDir()}\n原文件未被修改。`);
    app.exit(1);
    return;
  }
  await createWindow();
  for (const project of config.projects) {
    for (const proxy of [...project.proxies, ...project.mockServices].filter((p) => p.autoStart)) {
      try { await manager.start(runtimeConfig({ project, proxy })); }
      catch (err) { manager.log(proxy.id, 'error', 'error', `自动启动失败：${err.message}`); }
    }
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
let isQuitting = false;
app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  manager.stopAll().finally(() => app.quit());
});
