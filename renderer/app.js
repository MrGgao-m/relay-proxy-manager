'use strict';

const $ = (id) => document.getElementById(id);

const state = { ruleDraft: null, docs: [], currentDoc: null, docChecked: new Set(), drafts: null, aiJob: null, aiCandidate: null, kind: 'proxy', mockServices: [], projects: [], activeProjectId: null, projectMode: 'add', editingRuleId: null, proxies: [], globalHeaders: [], running: [], logs: [], selectedId: null, editingId: null, search: '', logSearch: '', logLevel: 'all', selectedTraceId: null, trace: null, showSensitive: false };
const labels = { success: '成功', info: '信息', warn: '警告', error: '错误' };
const sensitiveHeaders = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-token', 'token', 'x-api-key', 'api-key']);
let toastTimer;
const MODE_LABEL = { mock: 'Mock', proxy: '代理' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function isMock(item) { return item?.kind === 'mock'; }
function listItems() { return state.kind === 'mock' ? state.mockServices : state.proxies; }
function selected() { return state.proxies.find((proxy) => proxy.id === state.selectedId) || state.mockServices.find((svc) => svc.id === state.selectedId); }
function running(id) { return state.running.includes(id); }

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').className = `toast${error ? ' error' : ''}`;
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 3500);
}

function handleError(err) { toast(err.message, true); }

function renderList() {
  const query = state.search.toLowerCase();
  const items = listItems();
  const filtered = items.filter((p) => `${p.name} ${p.port} ${p.target || ''}`.toLowerCase().includes(query));
  $('service-count').textContent = items.length;
  $('list-caption-count').textContent = filtered.length;
  $('proxy-list').innerHTML = filtered.length ? filtered.map((proxy) => {
    const isRunning = running(proxy.id);
    return `<div class="proxy-card${proxy.id === state.selectedId ? ' selected' : ''}" data-id="${proxy.id}" role="button" tabindex="0">
      <div class="proxy-card-title"><span class="status-dot${isRunning ? ' running' : ''}"></span><span>${escapeHtml(proxy.name)}</span></div>
      <div class="proxy-card-route">:${proxy.port} <span>→</span> ${isMock(proxy) ? 'Mock' : escapeHtml(proxy.prefix)}</div>
      <div class="proxy-card-target">${isMock(proxy) ? `独立 Mock 服务 · ${proxy.rules.length} 个接口` : escapeHtml(proxy.target)}</div>
      <div class="proxy-card-bottom"><span class="proxy-status${isRunning ? ' running' : ''}">${isRunning ? '● 运行中' : '○ 已停止'}</span><button class="mini-start" data-action="${isRunning ? 'stop' : 'start'}" data-id="${proxy.id}">${isRunning ? '停止' : '启动'} ${isRunning ? '■' : '▶'}</button></div>
    </div>`;
  }).join('') : `<div class="list-empty">${items.length ? `没有符合条件的${state.kind === 'mock' ? ' Mock 服务' : '代理'}` : (state.kind === 'mock' ? '还没有 Mock 服务<br>点击上方「新建 Mock 服务」开始' : '还没有代理<br>点击上方「新建代理」开始')}</div>`;
}

function accessHost(host) {
  if (!host || host === '0.0.0.0' || host === '::') return 'localhost';
  return host.includes(':') ? `[${host}]` : host;
}

function renderDetail() {
  const proxy = selected();
  $('welcome').classList.toggle('hidden', Boolean(proxy));
  $('proxy-detail').classList.toggle('hidden', !proxy);
  if (!proxy) return;
  const isRunning = running(proxy.id);
  const mock = isMock(proxy);
  const base = `http://${accessHost(proxy.host)}:${proxy.port}`;
  const local = mock ? base : `${base}${proxy.prefix}`;
  const target = mock ? '' : `${proxy.target}${proxy.stripPrefix ? '' : proxy.prefix}`;
  $('detail-name').textContent = proxy.name;
  $('detail-target').textContent = mock ? '独立 Mock 服务 · 无需后端' : proxy.target;
  $('route-title').textContent = mock ? 'Mock 服务地址' : '转发规则';
  $('route-arrow').classList.toggle('hidden', mock);
  $('route-target').classList.toggle('hidden', mock);
  $('duplicate-mock').classList.toggle('hidden', !mock);
  $('detail-status').className = `status-dot${isRunning ? ' running' : ''}`;
  $('status-label').textContent = isRunning ? '运行中' : '未运行';
  $('status-label').className = `status-label${isRunning ? ' running' : ''}`;
  $('toggle-proxy').textContent = isRunning ? `■ 停止${mock ? '服务' : '代理'}` : `▶ 启动${mock ? '服务' : '代理'}`;
  $('toggle-proxy').className = isRunning ? 'danger-button' : 'primary-button';
  $('stat-port').textContent = proxy.port;
  $('local-url').textContent = `${local}/*`;
  $('target-url').textContent = `${target}/*`;
  $('route-hint').textContent = mock ? '未配置的接口返回 404' : (proxy.stripPrefix ? '自动去掉路径前缀 · 保留查询参数' : '保留路径前缀 · 保留查询参数');
  renderRules();
  renderStats();
  renderLogs();
}

function currentLogs() {
  return state.logs.filter((log) => {
    if (log.proxyId !== state.selectedId) return false;
    if (state.logLevel !== 'all' && log.level !== state.logLevel) return false;
    return `${log.message} ${log.target || ''}`.toLowerCase().includes(state.logSearch.toLowerCase());
  });
}

function renderStats() {
  const logs = state.logs.filter((log) => log.proxyId === state.selectedId);
  const responses = logs.filter((log) => log.event === 'response');
  const durations = responses.filter((log) => Number.isFinite(log.duration));
  const totalMs = durations.reduce((sum, log) => sum + log.duration, 0);
  $('stat-requests').textContent = responses.length;
  $('stat-errors').textContent = responses.filter((log) => log.status >= 400).length;
  $('stat-duration').textContent = durations.length ? `${Math.round(totalMs / durations.length)} ms` : '—';
}

function renderLogs() {
  const logs = currentLogs();
  const list = $('log-list');
  const shouldStick = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.innerHTML = logs.map((log) => {
    const time = new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false });
    return `<div class="log-entry ${log.level}${log.source === 'MOCK' ? ' src-mock' : ''}${log.traceId ? ' has-trace' : ''}${log.traceId === state.selectedTraceId ? ' selected' : ''}"${log.traceId ? ` data-trace-id="${log.traceId}" role="button" tabindex="0" title="点击查看请求与响应详情"` : ` title="${escapeHtml(log.message)}"`}><span class="log-time">${time}</span><span class="log-level">${labels[log.level] || log.level}</span><span class="log-message">${escapeHtml(log.message)}</span><span class="log-duration">${log.event === 'response' ? `${log.duration} ms` : '—'}</span></div>`;
  }).join('');
  $('log-empty').classList.toggle('hidden', logs.length > 0);
  list.classList.toggle('hidden', logs.length === 0);
  if (!logs.length && state.logs.some((log) => log.proxyId === state.selectedId)) {
    $('log-empty').querySelector('strong').textContent = '没有匹配的日志';
    $('log-empty').querySelector('p').textContent = '请调整日志级别或筛选关键词。';
  } else {
    $('log-empty').querySelector('strong').textContent = '等待第一条请求';
    $('log-empty').querySelector('p').textContent = '启动代理后，这里会实时显示请求与转发日志。';
  }
  $('log-count').textContent = `${logs.length} 条日志`;
  if (shouldStick) list.scrollTop = list.scrollHeight;
}

function renderKind() {
  const mock = state.kind === 'mock';
  document.querySelectorAll('#kind-switch .mode-btn').forEach((button) => button.classList.toggle('active', button.dataset.kind === state.kind));
  $('sidebar-title').textContent = mock ? 'Mock 服务' : '代理服务';
  $('list-caption-label').textContent = mock ? '全部 Mock 服务' : '全部代理';
  $('add-proxy').innerHTML = `<span>＋</span> ${mock ? '新建 Mock 服务' : '新建代理'}`;
  $('mock-io').classList.toggle('hidden', !mock);
}

function renderProjects() {
  const select = $('project-select');
  select.innerHTML = state.projects.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === state.activeProjectId ? ' selected' : ''}>${escapeHtml(p.name)}（${p.proxyCount + (p.mockCount || 0)}）</option>`).join('');
  $('project-delete').disabled = state.projects.length <= 1;
}

function currentProjectName() { return state.projects.find((p) => p.id === state.activeProjectId)?.name || ''; }

function openProjectModal(mode) {
  state.projectMode = mode;
  $('project-title').textContent = mode === 'add' ? '新建项目' : '重命名项目';
  $('project-name').value = mode === 'add' ? '' : currentProjectName();
  $('project-error').classList.add('hidden');
  $('project-backdrop').classList.remove('hidden');
  $('project-name').focus();
}
function closeProjectModal() { $('project-backdrop').classList.add('hidden'); }

function ruleSummary(rule) {
  if (rule.mode !== 'mock') return '转发到后端';
  return `${rule.response.status}${rule.response.dynamic ? ' · 动态数据' : ''}${rule.response.delayMs ? ` · 延迟 ${rule.response.delayMs} ms` : ''}${rule.note ? ` · ${rule.note}` : ''}`;
}

/** 同一接口有多个 Mock 场景时，在规则行里提供一键切换。 */
function scenarioSelect(rule) {
  if (!rule.alternatives?.length) return '';
  const all = [rule.scenario, ...rule.alternatives].sort((x, y) => x.name.localeCompare(y.name, 'zh-CN'));
  return `<select class="scenario-select" data-rule-action="scenario" title="切换 Mock 场景" aria-label="Mock 场景">${all.map((s) => `<option value="${escapeHtml(s.id)}"${s.id === rule.scenario.id ? ' selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select>`;
}

function renderRules() {
  const proxy = selected();
  const rules = proxy?.rules || [];
  $('rules-count').textContent = rules.length;
  $('rules-empty').classList.toggle('hidden', rules.length > 0);
  $('rules-list').innerHTML = rules.map((rule) => `<div class="rule-row${rule.enabled ? '' : ' off'}" data-id="${escapeHtml(rule.id)}">
    <input type="checkbox" class="rule-enabled" data-rule-action="enable" ${rule.enabled ? 'checked' : ''} title="启用 / 停用此规则" aria-label="启用规则">
    <span class="rule-method">${escapeHtml(rule.method)}</span>
    <code class="rule-path" title="${escapeHtml(rule.path)}">${escapeHtml(rule.path)}</code>
    <span class="rule-summary-cell">${scenarioSelect(rule)}<span class="rule-summary" title="${escapeHtml(ruleSummary(rule))}">${escapeHtml(ruleSummary(rule))}</span></span>
    ${isMock(proxy) ? '<span></span>' : `<span class="mode-switch"><button type="button" class="mode-btn${rule.mode === 'proxy' ? ' active' : ''}" data-rule-action="mode" data-mode="proxy">代理</button><button type="button" class="mode-btn mock${rule.mode === 'mock' ? ' active' : ''}" data-rule-action="mode" data-mode="mock">Mock</button></span>`}
    <button type="button" class="icon-button" data-rule-action="edit">编辑</button>
  </div>`).join('');
}

async function persistRules(rules, message) {
  const proxy = selected();
  if (!proxy) return;
  try {
    await window.relay.saveRules(proxy.id, rules);
    if (message) toast(message);
    return true;
  } catch (err) { handleError(err); return false; }
}

function toggleRuleField() {
  $('rule-response-fields').classList.toggle('hidden', $('rule-mode').value !== 'mock');
  $('rule-dynamic-tools').classList.toggle('hidden', !$('rule-dynamic').checked);
}

function openRuleModal(id = null) {
  const rule = id ? (selected()?.rules || []).find((r) => r.id === id) : null;
  state.editingRuleId = rule ? rule.id : null;
  $('rule-title').textContent = rule ? '编辑接口规则' : '添加接口规则';
  $('rule-method').value = rule?.method || 'GET';
  $('rule-path').value = rule?.path || '';
  $('rule-mode').value = rule?.mode || 'mock';
  $('rule-enabled').checked = rule ? rule.enabled : true;
  $('rule-preview-result').classList.add('hidden');
  $('rule-note').value = rule?.note || '';
  if (rule) {
    state.ruleDraft = {
      scenarios: [{ id: rule.scenario.id, name: rule.scenario.name, response: structuredClone(rule.response) }, ...rule.alternatives.map((alt) => ({ id: alt.id, name: alt.name, response: structuredClone(alt.response) }))],
      activeId: rule.scenario.id, viewId: rule.scenario.id,
    };
  } else {
    const id = tempScenarioId();
    state.ruleDraft = { scenarios: [{ id, name: '默认', response: { status: 200, delayMs: 0, body: '', dynamic: false, headers: [], bodyEncoding: 'text' } }], activeId: id, viewId: id };
  }
  fillResponse(state.ruleDraft.scenarios[0].response);
  renderScenarioBar();
  $('delete-rule').classList.toggle('hidden', !rule);
  $('rule-error').classList.add('hidden');
  $('rule-ai-candidate').classList.add('hidden');
  state.aiCandidate = null;
  $('rule-ai-regenerate').classList.toggle('hidden', rule?.source?.type !== 'doc');
  const forMock = isMock(selected());
  $('rule-mode-field').classList.toggle('hidden', forMock);
  if (forMock) $('rule-mode').value = 'mock';
  toggleRuleField();
  $('rule-backdrop').classList.remove('hidden');
  $('rule-path').focus();
}
function closeRuleModal() { $('rule-backdrop').classList.add('hidden'); }

const tempScenarioId = () => `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const realScenarioId = (id) => (String(id).startsWith('new-') ? undefined : id); // 新建的场景由主进程分配正式 ID

function fillResponse(response) {
  $('rule-status').value = response.status ?? 200;
  $('rule-delay').value = response.delayMs ?? 0;
  $('rule-body').value = response.body ?? '';
  $('rule-dynamic').checked = Boolean(response.dynamic);
  $('rule-headers-editor').innerHTML = '';
  (response.headers || []).forEach((header) => addHeaderRow(header, 'rule-headers-editor', 'rule-headers-empty'));
  $('rule-headers-empty').classList.toggle('hidden', Boolean(response.headers?.length));
  toggleRuleField();
}

function responseFromForm(bodyEncoding = 'text') {
  return {
    status: Number($('rule-status').value),
    delayMs: Number($('rule-delay').value || 0),
    body: $('rule-body').value,
    bodyEncoding,
    dynamic: $('rule-dynamic').checked,
    headers: [...$('rule-headers-editor').querySelectorAll('.header-row')].map((row) => ({
      name: row.querySelector('.header-name').value,
      value: row.querySelector('.header-value').value,
      enabled: row.querySelector('.header-enabled').checked,
    })),
  };
}

const viewedScenario = () => state.ruleDraft.scenarios.find((s) => s.id === state.ruleDraft.viewId);

/** 把表单里正在编辑的内容写回当前查看的场景。 */
function captureScenario() {
  const scenario = viewedScenario();
  scenario.name = $('rule-scenario-name').value;
  scenario.response = responseFromForm(scenario.response.bodyEncoding);
}

function renderScenarioBar() {
  const draft = state.ruleDraft;
  $('rule-scenario').innerHTML = draft.scenarios.map((s) => `<option value="${escapeHtml(s.id)}"${s.id === draft.viewId ? ' selected' : ''}>${escapeHtml(s.name || '（未命名）')}${s.id === draft.activeId ? '（启用中）' : ''}</option>`).join('');
  $('rule-scenario-name').value = viewedScenario().name;
  $('rule-scenario-active').checked = draft.viewId === draft.activeId;
  $('rule-scenario-delete').disabled = draft.scenarios.length <= 1;
}

function showScenario(id) {
  state.ruleDraft.viewId = id;
  fillResponse(viewedScenario().response);
  renderScenarioBar();
}

/** 保存用：包含当前启用的场景（response）和其余场景（alternatives）。 */
function buildRuleForSave() {
  captureScenario();
  const draft = state.ruleDraft;
  const active = draft.scenarios.find((s) => s.id === draft.activeId);
  const { response, ...base } = readRuleForm();
  return {
    ...base,
    response: active.response,
    scenario: { id: realScenarioId(active.id), name: active.name },
    alternatives: draft.scenarios.filter((s) => s.id !== draft.activeId).map((s) => ({ id: realScenarioId(s.id), name: s.name, response: s.response })),
  };
}

function readRuleForm() {
  const existing = (selected()?.rules || []).find((r) => r.id === state.editingRuleId);
  return {
    id: existing?.id,
    method: $('rule-method').value,
    path: $('rule-path').value,
    mode: $('rule-mode').value,
    enabled: $('rule-enabled').checked,
    note: $('rule-note').value,
    source: existing?.source || { type: 'manual' },
    response: responseFromForm(viewedScenario()?.response.bodyEncoding || 'text'),
  };
}

// ---------- AI 设置 ----------
function closeAiModal() { $('ai-backdrop').classList.add('hidden'); }

async function openAiModal() {
  $('ai-error').classList.add('hidden');
  $('ai-status').classList.add('hidden');
  $('ai-key').value = '';
  state.aiClearKey = false;
  try {
    const ai = await window.relay.getAi();
    $('ai-provider').value = ai.provider;
    $('ai-base-url').value = ai.baseUrl;
    $('ai-model').value = ai.model;
    $('ai-timeout').value = Math.round(ai.timeoutMs / 1000);
    $('ai-prompt').value = ai.customPrompt;
    $('ai-key-state').textContent = ai.hasKey ? '已配置' : '未配置';
    $('ai-key').placeholder = ai.hasKey ? '已配置，留空表示不修改' : '请输入 API Key';
    $('ai-backdrop').classList.remove('hidden');
  } catch (err) { handleError(err); }
}

function readAiForm() {
  return { provider: $('ai-provider').value, baseUrl: $('ai-base-url').value, model: $('ai-model').value, timeoutMs: Number($('ai-timeout').value) * 1000, customPrompt: $('ai-prompt').value };
}

async function saveAiSettings() {
  const key = $('ai-key').value;
  const apiKey = state.aiClearKey ? '' : (key ? key : undefined); // undefined 表示不修改，空字符串表示清除
  const saved = await window.relay.saveAi(readAiForm(), apiKey);
  $('ai-key').value = '';
  state.aiClearKey = false;
  $('ai-key-state').textContent = saved.hasKey ? '已配置' : '未配置';
  $('ai-key').placeholder = saved.hasKey ? '已配置，留空表示不修改' : '请输入 API Key';
  return saved;
}

// ---------- 接口文档 ----------
function closeDocs() { $('docs-backdrop').classList.add('hidden'); }
const aiBaseUrl = async () => (await window.relay.getAi()).baseUrl || '（尚未配置）';

function renderTargets() {
  const options = [
    ...state.proxies.map((p) => `<option value="${escapeHtml(p.id)}">代理 · ${escapeHtml(p.name)}</option>`),
    ...state.mockServices.map((m) => `<option value="${escapeHtml(m.id)}">Mock · ${escapeHtml(m.name)}</option>`),
  ];
  $('docs-target').innerHTML = options.join('') || '<option value="">（请先创建代理或 Mock 服务）</option>';
  const current = selected();
  if (current) $('docs-target').value = current.id;
}

function renderDocsSelect(keepId) {
  $('docs-select').innerHTML = state.docs.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}（${d.endpointCount}）</option>`).join('');
  $('docs-delete').disabled = !state.docs.length;
  if (!state.docs.length) { state.currentDoc = null; renderDoc(); return; }
  const id = state.docs.some((d) => d.id === keepId) ? keepId : state.docs[0].id;
  $('docs-select').value = id;
  loadDoc(id);
}

async function loadDoc(id) {
  try { state.currentDoc = await window.relay.getDoc(id); } catch (err) { handleError(err); state.currentDoc = null; }
  state.docChecked = new Set();
  state.drafts = null;
  renderDoc();
}

function renderDoc() {
  const doc = state.currentDoc;
  $('docs-body').classList.toggle('hidden', !doc);
  $('docs-preview').classList.add('hidden');
  $('docs-progress').classList.add('hidden');
  if (!doc) { $('docs-summary').textContent = '还没有导入接口文档。选择文档类型后点「导入文档」；导入只会解析出接口清单，不会改动任何现有接口。'; return; }
  const bits = [`${doc.type === 'openapi' ? 'Swagger / OpenAPI' : 'Markdown'}`, doc.info?.title ? `《${doc.info.title}》` : '', doc.info?.version ? `v${doc.info.version}` : '', `${doc.endpoints.length} 个接口`, `导入于 ${new Date(doc.importedAt).toLocaleString('zh-CN')}`].filter(Boolean);
  const notes = [...(doc.warnings || []), ...(doc.skipped || []).map((s) => `第 ${s.line} 行「${s.title}」未导入：${s.reason}`)];
  $('docs-summary').innerHTML = `${escapeHtml(bits.join(' · '))}${notes.length ? `<br>⚠ ${notes.map(escapeHtml).join('<br>⚠ ')}` : ''}`;
  renderEndpoints();
}

function visibleEndpoints() {
  const query = $('docs-filter').value.trim().toLowerCase();
  return (state.currentDoc?.endpoints || []).filter((e) => !query || `${e.method} ${e.path} ${e.summary}`.toLowerCase().includes(query));
}

function renderEndpoints() {
  const list = visibleEndpoints();
  $('docs-endpoints').innerHTML = list.map((e) => `<div class="doc-row"><input type="checkbox" data-id="${escapeHtml(e.id)}" ${state.docChecked.has(e.id) ? 'checked' : ''} aria-label="选择接口"><span class="doc-method">${escapeHtml(e.method)}</span><code class="doc-path" title="${escapeHtml(e.path)}">${escapeHtml(e.path)}</code><span class="doc-summary" title="${escapeHtml(e.summary)}">${escapeHtml(e.summary)}</span>${e.needsConfirm.length ? `<span class="tag warn" title="${escapeHtml(e.needsConfirm.join('；'))}">待确认 ${e.needsConfirm.length}</span>` : '<span></span>'}</div>`).join('') || '<div class="rules-empty">没有符合条件的接口</div>';
  $('docs-count').textContent = `已选 ${state.docChecked.size} / ${state.currentDoc.endpoints.length}`;
  $('docs-check-all').checked = list.length > 0 && list.every((e) => state.docChecked.has(e.id));
}

function renderDrafts() {
  const drafts = state.drafts || [];
  $('docs-preview').classList.toggle('hidden', !drafts.length);
  $('docs-error').classList.add('hidden');
  $('docs-drafts').innerHTML = drafts.map((d, index) => {
    const failed = Boolean(d.error);
    const rule = d.rule;
    return `<div class="draft-card${failed ? ' failed' : ''}" data-index="${index}">
      <div class="draft-head">${failed ? '' : `<input type="checkbox" class="draft-include" ${d.include ? 'checked' : ''} aria-label="保存此接口">`}<span class="doc-method">${escapeHtml(d.method || rule?.method)}</span><code>${escapeHtml(d.path || rule?.path)}</code>${failed ? '' : `<span class="tag">${rule.response.status}</span>`}${!failed && rule.response.dynamic ? '<span class="tag">动态数据</span>' : ''}${d.conflict ? '<span class="tag warn">已存在</span>' : ''}${d.pathAdjusted ? `<span class="tag" title="${escapeHtml(d.pathAdjusted)}">已去代理前缀</span>` : ''}${(d.needsConfirm || []).length ? `<span class="tag warn" title="${escapeHtml(d.needsConfirm.join('；'))}">待确认 ${d.needsConfirm.length}</span>` : ''}</div>
      ${failed ? `<div class="form-error">生成失败：${escapeHtml(d.error)}（不会保存，已有配置不受影响）</div>` : `<textarea class="draft-body" spellcheck="false" aria-label="响应 Body">${escapeHtml(rule.response.body)}</textarea>`}
    </div>`;
  }).join('');
}

function setGenerating(active) {
  $('docs-generate').disabled = active;
  $('docs-stop').classList.toggle('hidden', !active);
}

async function generateDrafts() {
  const ids = [...state.docChecked];
  const targetId = $('docs-target').value;
  if (!ids.length) return toast('请先勾选要生成 Mock 的接口', true);
  if (!targetId) return toast('请先创建一个代理或 Mock 服务作为保存目标', true);
  const [source, style] = $('docs-gen-mode').value.split('-');
  const options = { targetId, dynamic: style === 'dynamic' };
  state.drafts = null;
  $('docs-preview').classList.add('hidden');
  try {
    if (source === 'local') {
      const drafts = await window.relay.previewDocDrafts(state.currentDoc.id, ids, options);
      state.drafts = drafts.map((d) => ({ ...d, include: true }));
    } else {
      if (!window.confirm(`将把所选 ${ids.length} 个接口的 Schema / 示例发送到 AI 服务：\n${await aiBaseUrl()}\n\n是否继续？`)) return;
      const jobId = `job-${Date.now()}`;
      state.aiJob = { jobId, total: ids.length, done: 0 };
      setGenerating(true);
      $('docs-progress').textContent = `AI 生成中… 0 / ${ids.length}`;
      $('docs-progress').classList.remove('hidden');
      const results = await window.relay.aiGenerateDrafts(state.currentDoc.id, ids, options, jobId);
      state.drafts = results.map((r) => (r.ok ? { ...r.draft, include: true } : { error: r.error, method: r.endpointId.split(' ')[0], path: r.endpointId.slice(r.endpointId.indexOf(' ') + 1) }));
      const failed = results.filter((r) => !r.ok).length;
      $('docs-progress').textContent = `AI 生成完成：成功 ${results.length - failed}，失败 ${failed}。`;
    }
    renderDrafts();
  } catch (err) { handleError(err); }
  finally { state.aiJob = null; setGenerating(false); }
}

async function applyDrafts() {
  const chosen = (state.drafts || []).filter((d) => d.include && !d.error);
  if (!chosen.length) return toast('没有勾选要保存的接口', true);
  try {
    const result = await window.relay.applyDocDrafts($('docs-target').value, chosen.map((d) => ({ endpointId: d.endpointId, rule: d.rule })), { conflict: $('docs-conflict').value });
    state.drafts = null;
    renderDrafts();
    $('docs-progress').classList.add('hidden');
    toast(`已保存：新增 ${result.added}，覆盖 ${result.overwritten}，跳过 ${result.skipped}`);
  } catch (err) {
    $('docs-error').textContent = err.message;
    $('docs-error').classList.remove('hidden');
  }
}

function selectProxy(id) {
  state.selectedId = id;
  state.selectedTraceId = null;
  closeTrace();
  renderList();
  renderDetail();
}

function addHeaderRow(header = {}, editorId = 'headers-editor', emptyId = 'headers-empty') {
  const row = document.createElement('div');
  row.className = 'header-row';
  row.innerHTML = `<input class="header-enabled" type="checkbox" ${header.enabled === false ? '' : 'checked'} title="是否启用" aria-label="启用 Header"><input class="header-name" value="${escapeHtml(header.name || '')}" placeholder="Authorization" aria-label="Header 名称"><input class="header-value" value="${escapeHtml(header.value || '')}" placeholder="Bearer your-token" aria-label="Header 值"><button class="remove-header" type="button" title="删除" aria-label="删除 Header">×</button>`;
  row.querySelector('.remove-header').onclick = () => {
    row.remove();
    $(emptyId).classList.toggle('hidden', $(editorId).children.length > 0);
  };
  $(editorId).appendChild(row);
  $(emptyId).classList.add('hidden');
}

function openGlobalHeaders() {
  $('global-headers-editor').innerHTML = '';
  state.globalHeaders.forEach((header) => addHeaderRow(header, 'global-headers-editor', 'global-headers-empty'));
  $('global-headers-empty').classList.toggle('hidden', state.globalHeaders.length > 0);
  $('global-error').classList.add('hidden');
  $('global-backdrop').classList.remove('hidden');
}

function closeGlobalHeaders() { $('global-backdrop').classList.add('hidden'); }

async function saveGlobalHeaders() {
  const headers = [...$('global-headers-editor').querySelectorAll('.header-row')].map((row) => ({
    name: row.querySelector('.header-name').value,
    value: row.querySelector('.header-value').value,
    enabled: row.querySelector('.header-enabled').checked,
  }));
  $('save-global').disabled = true;
  try {
    state.globalHeaders = await window.relay.saveGlobalHeaders(headers);
    closeGlobalHeaders();
    toast('项目 Header 已应用到当前项目的所有代理');
  } catch (err) {
    $('global-error').textContent = err.message;
    $('global-error').classList.remove('hidden');
  } finally { $('save-global').disabled = false; }
}

function closeTrace() {
  $('trace-backdrop').classList.add('hidden');
  state.trace = null;
  state.selectedTraceId = null;
  state.showSensitive = false;
}

function formatBody(capture) {
  if (!capture || !capture.body) return '(空)';
  const type = String(capture.body).trim();
  if (type.startsWith('{') || type.startsWith('[')) {
    try { return JSON.stringify(JSON.parse(type), null, 2); } catch { return type; }
  }
  return type;
}

function renderHeaders(container, headers) {
  const entries = Object.entries(headers || {});
  container.innerHTML = entries.length ? entries.map(([name, value]) => {
    const sensitive = sensitiveHeaders.has(name.toLowerCase());
    const display = sensitive && !state.showSensitive ? '•••••••••••• 已隐藏' : Array.isArray(value) ? value.join(', ') : value;
    return `<div class="header-line${sensitive ? ' sensitive' : ''}"><span>${escapeHtml(name)}</span><span>${escapeHtml(display)}</span></div>`;
  }).join('') : '<div class="headers-empty">无请求头</div>';
}

function renderTrace() {
  const trace = state.trace;
  if (!trace) return;
  const request = trace.request;
  const response = trace.response;
  $('trace-title').textContent = `${request.method} 请求详情`;
  $('trace-summary').innerHTML = `<strong>${escapeHtml(request.method)}</strong>${escapeHtml(request.url)}<br><span>发起于 ${new Date(trace.startedAt).toLocaleString('zh-CN')}</span>`;
  const isMock = trace.source === 'MOCK';
  $('trace-request-meta').innerHTML = `<strong>${isMock ? '处理方式' : '目标地址'}</strong><br>${escapeHtml(isMock ? '本地 Mock 响应，未请求后端' : (request.targetUrl || 'CORS 预检，未转发'))}<br><span>HTTP/${escapeHtml(request.httpVersion)}</span>`;
  $('trace-source').classList.toggle('hidden', !trace.source);
  $('trace-source-label').innerHTML = trace.source ? `<span class="source-tag ${trace.source === 'MOCK' ? 'mock' : 'proxy'}">${trace.source}</span> ${isMock ? `本地规则返回${trace.scenario ? ` · 场景「${escapeHtml(trace.scenario)}」` : ''}` : `真实后端返回${trace.missReason ? `<br><span class="miss-reason">未走 Mock：${escapeHtml(trace.missReason)}</span>` : ''}`}` : '';
  $('trace-to-mock').classList.toggle('hidden', !(trace.source === 'PROXY' && response));
  renderHeaders($('trace-request-headers'), request.outgoingHeaders || request.headers);
  $('trace-request-size').textContent = request.body ? `${request.body.total} B${request.body.truncated ? ' · 仅预览前 256 KB' : ''}` : '';
  $('trace-request-body').textContent = formatBody(request.body);
  if (response) {
    $('trace-response-meta').innerHTML = `<span class="trace-status">${response.status}</span>${escapeHtml(response.statusText || '')}<br>HTTP/${escapeHtml(response.httpVersion)}`;
    renderHeaders($('trace-response-headers'), response.headers);
    $('trace-response-size').textContent = response.body ? `${response.body.total} B${response.body.truncated ? ' · 仅预览前 256 KB' : ''}` : '';
    $('trace-response-body').textContent = formatBody(response.body);
  } else {
    $('trace-response-meta').innerHTML = trace.error ? `<div class="trace-error">转发失败：${escapeHtml(trace.error.message)} (${escapeHtml(trace.error.code)})</div>` : '正在等待后端响应…';
    $('trace-response-headers').innerHTML = '<div class="headers-empty">暂无响应头</div>';
    $('trace-response-body').textContent = '(暂无响应体)';
    $('trace-response-size').textContent = '';
  }
  $('toggle-sensitive').textContent = state.showSensitive ? '隐藏敏感信息' : '显示敏感信息';
}

async function openTrace(id) {
  state.selectedTraceId = id;
  state.showSensitive = false;
  $('trace-backdrop').classList.remove('hidden');
  $('trace-loading').classList.remove('hidden');
  $('trace-content').classList.add('hidden');
  renderLogs();
  try {
    state.trace = await window.relay.getTrace(id);
    renderTrace();
    $('trace-loading').classList.add('hidden');
    $('trace-content').classList.remove('hidden');
  } catch (err) {
    $('trace-loading').textContent = err.message;
  }
}

async function copyTrace(part) {
  if (!state.trace) return;
  const request = state.trace.request;
  const response = state.trace.response;
  const headers = (items) => Object.entries(items || {}).map(([key, value]) => `${key}: ${value}`).join('\n');
  const text = part === 'request'
    ? `${request.method} ${request.targetUrl || request.url}\n\n${headers(request.outgoingHeaders || request.headers)}\n\n${formatBody(request.body)}`
    : response ? `HTTP/${response.httpVersion} ${response.status} ${response.statusText}\n\n${headers(response.headers)}\n\n${formatBody(response.body)}` : '暂无响应';
  try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); }
  catch { toast('复制失败，请手动选择内容', true); }
}

function openModal(id = null) {
  const proxy = id ? listItems().find((p) => p.id === id) : null;
  const mock = state.kind === 'mock';
  state.editingId = id;
  document.querySelectorAll('[data-proxy-only]').forEach((el) => el.classList.toggle('hidden', mock));
  $('proxy-prefix').required = !mock; // 隐藏的必填项会让浏览器拒绝提交
  $('proxy-target').required = !mock;
  $('modal-title').textContent = `${proxy ? '编辑' : '新建'}${mock ? ' Mock 服务' : '代理'}`;
  $('proxy-name').value = proxy?.name || '';
  $('proxy-host').value = proxy?.host || 'localhost';
  window.relay.getLocalIps().then((ips) => {
    $('local-ips').innerHTML = ['localhost', '0.0.0.0', ...ips].map((ip) => `<option value="${ip}"></option>`).join('');
  }).catch(() => {});
  $('proxy-port').value = proxy?.port || (mock ? 9001 : 8009) + listItems().length;
  $('proxy-prefix').value = proxy?.prefix || '/cgw/aiadmin';
  $('proxy-target').value = proxy?.target || 'http://10.0.7.33:8106';
  $('strip-prefix').checked = proxy ? proxy.stripPrefix : true;
  $('auto-start').checked = proxy?.autoStart || false;
  $('headers-editor').innerHTML = '';
  (proxy?.headers || []).forEach((header) => addHeaderRow(header));
  $('headers-empty').classList.toggle('hidden', mock || Boolean(proxy?.headers?.length));
  $('delete-proxy').classList.toggle('hidden', !proxy);
  $('save-proxy').textContent = proxy && running(proxy.id) ? '保存并重启' : '保存配置';
  $('form-error').classList.add('hidden');
  $('modal-backdrop').classList.remove('hidden');
  $('proxy-name').focus();
}

function closeModal() { $('modal-backdrop').classList.add('hidden'); }

async function toggleProxy(id) {
  const button = $('toggle-proxy');
  button.disabled = true;
  try {
    const label = isMock(selected()) ? 'Mock 服务' : '代理';
    if (running(id)) { await window.relay.stopProxy(id); toast(`${label}已停止`); }
    else { await window.relay.startProxy(id); toast(`${label}已启动，可以发送请求了`); }
  } catch (err) { handleError(err); }
  finally {
    if (selected()) $('toggle-proxy').disabled = false;
  }
}

$('add-proxy').onclick = () => openModal();
$('welcome-add').onclick = () => openModal();
$('close-modal').onclick = closeModal;
$('cancel-modal').onclick = closeModal;
$('modal-backdrop').onclick = (event) => { if (event.target === $('modal-backdrop')) closeModal(); };
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closeTrace(); closeModal(); closeGlobalHeaders(); closeProjectModal(); closeRuleModal(); closeAiModal(); closeDocs(); closeTraceMock(); }
  if (event.key === 'Enter' && event.target.classList.contains('proxy-card')) selectProxy(event.target.dataset.id);
  if (event.key === 'Enter' && event.target.dataset.traceId) openTrace(event.target.dataset.traceId);
});
$('proxy-search').oninput = (event) => { state.search = event.target.value; renderList(); };
$('log-search').oninput = (event) => { state.logSearch = event.target.value; renderLogs(); };
$('log-filter').onchange = (event) => { state.logLevel = event.target.value; renderLogs(); };
$('proxy-list').onclick = (event) => {
  const action = event.target.closest('[data-action]');
  if (action) { event.stopPropagation(); toggleProxy(action.dataset.id); return; }
  const card = event.target.closest('.proxy-card');
  if (card) selectProxy(card.dataset.id);
};
$('toggle-proxy').onclick = () => { if (selected()) toggleProxy(state.selectedId); };
$('add-header').onclick = () => addHeaderRow();
$('open-global-headers').onclick = openGlobalHeaders;
$('add-global-header').onclick = () => addHeaderRow({}, 'global-headers-editor', 'global-headers-empty');
$('close-global').onclick = closeGlobalHeaders;
$('cancel-global').onclick = closeGlobalHeaders;
$('save-global').onclick = saveGlobalHeaders;
$('global-backdrop').onclick = (event) => { if (event.target === $('global-backdrop')) closeGlobalHeaders(); };
$('log-list').onclick = (event) => {
  const row = event.target.closest('[data-trace-id]');
  if (row) openTrace(row.dataset.traceId);
};
$('close-trace').onclick = () => { closeTrace(); renderLogs(); };
$('trace-backdrop').onclick = (event) => { if (event.target === $('trace-backdrop')) { closeTrace(); renderLogs(); } };
$('toggle-sensitive').onclick = () => { state.showSensitive = !state.showSensitive; renderTrace(); };
document.querySelectorAll('.trace-copy').forEach((button) => { button.onclick = () => copyTrace(button.dataset.copy); });
$('edit-proxy').onclick = () => {
  try {
    const cur = selected() || state.proxies[0] || state.mockServices[0];
    if (cur) { state.selectedId = cur.id; openModal(cur.id); }
    else toast('请先选择一条代理', true);
  } catch (err) {
    toast('打开编辑失败：' + err.message, true);
  }
};
$('copy-url').onclick = async () => {
  try { await navigator.clipboard.writeText($('local-url').textContent.replace('/*', '')); toast('本地代理地址已复制'); }
  catch { toast('复制失败，请手动选择地址', true); }
};
$('clear-logs').onclick = async () => {
  try { await window.relay.clearLogs(state.selectedId); state.logs = state.logs.filter((log) => log.proxyId !== state.selectedId); closeTrace(); renderDetail(); toast('当前代理日志已清空'); }
  catch (err) { handleError(err); }
};
$('export-logs').onclick = async () => {
  try { if (await window.relay.exportLogs(state.selectedId)) toast('日志已导出'); }
  catch (err) { handleError(err); }
};
$('delete-proxy').onclick = async () => {
  const proxy = listItems().find((p) => p.id === state.editingId);
  const label = isMock(proxy) ? 'Mock 服务' : '代理';
  if (!proxy || !window.confirm(`确定删除「${proxy.name}」吗？\n${label}将停止，配置${isMock(proxy) ? '、接口规则' : ''}和日志会被删除。`)) return;
  try {
    if (isMock(proxy)) await window.relay.deleteMock(proxy.id); else await window.relay.deleteProxy(proxy.id);
    state.logs = state.logs.filter((log) => log.proxyId !== proxy.id);
    state.selectedId = null;
    closeModal();
    toast(`${label}已删除`);
  } catch (err) { handleError(err); }
};
$('proxy-form').onsubmit = async (event) => {
  event.preventDefault();
  const mock = state.kind === 'mock';
  const input = mock ? {
    name: $('proxy-name').value,
    host: $('proxy-host').value,
    port: Number($('proxy-port').value),
    autoStart: $('auto-start').checked,
  } : {
    name: $('proxy-name').value,
    host: $('proxy-host').value,
    port: Number($('proxy-port').value),
    prefix: $('proxy-prefix').value,
    target: $('proxy-target').value,
    stripPrefix: $('strip-prefix').checked,
    autoStart: $('auto-start').checked,
    headers: [...$('headers-editor').querySelectorAll('.header-row')].map((row) => ({
      name: row.querySelector('.header-name').value,
      value: row.querySelector('.header-value').value,
      enabled: row.querySelector('.header-enabled').checked,
    })),
  };
  $('save-proxy').disabled = true;
  try {
    const saved = mock ? await window.relay.saveMock(input, state.editingId) : await window.relay.saveProxy(input, state.editingId);
    if (state.editingId && running(state.editingId)) await window.relay.restartProxy(state.editingId);
    state.selectedId = saved.id;
    closeModal();
    toast(state.editingId ? '配置已保存' : `${mock ? 'Mock 服务' : '代理'}已创建，点击启动即可使用`);
  } catch (err) {
    $('form-error').textContent = err.message;
    $('form-error').classList.remove('hidden');
  } finally { $('save-proxy').disabled = false; }
};
$('project-select').onchange = async (event) => {
  try { await window.relay.selectProject(event.target.value); state.selectedId = selectedFirstOfActive(); closeTrace(); renderList(); renderDetail(); }
  catch (err) { handleError(err); renderProjects(); }
};
function selectedFirstOfActive() { return listItems()[0]?.id || null; }
$('project-add').onclick = () => openProjectModal('add');
$('project-rename').onclick = () => openProjectModal('rename');
$('project-delete').onclick = async () => {
  const name = currentProjectName();
  if (!window.confirm(`确定删除项目「${name}」吗？\n其下所有代理将停止，配置、接口规则和日志会被删除。`)) return;
  try {
    const ids = [...state.proxies, ...state.mockServices].map((p) => p.id);
    await window.relay.deleteProject(state.activeProjectId);
    state.logs = state.logs.filter((log) => !ids.includes(log.proxyId));
    state.selectedId = selectedFirstOfActive();
    renderList(); renderDetail();
    toast('项目已删除');
  } catch (err) { handleError(err); }
};
$('close-project').onclick = closeProjectModal;
$('cancel-project').onclick = closeProjectModal;
$('project-backdrop').onclick = (event) => { if (event.target === $('project-backdrop')) closeProjectModal(); };
$('project-form').onsubmit = async (event) => {
  event.preventDefault();
  $('save-project').disabled = true;
  try {
    if (state.projectMode === 'add') {
      await window.relay.addProject($('project-name').value);
      state.selectedId = null;
      renderList(); renderDetail();
    } else await window.relay.renameProject(state.activeProjectId, $('project-name').value);
    closeProjectModal();
    toast(state.projectMode === 'add' ? '项目已创建' : '项目已重命名');
  } catch (err) {
    $('project-error').textContent = err.message;
    $('project-error').classList.remove('hidden');
  } finally { $('save-project').disabled = false; }
};

document.querySelectorAll('#kind-switch .mode-btn').forEach((button) => {
  button.onclick = () => {
    if (state.kind === button.dataset.kind) return;
    state.kind = button.dataset.kind;
    state.selectedId = selectedFirstOfActive();
    closeTrace();
    renderKind(); renderList(); renderDetail();
  };
});
$('duplicate-mock').onclick = async () => {
  if (!isMock(selected())) return;
  try {
    const copy = await window.relay.duplicateMock(state.selectedId);
    state.selectedId = copy.id;
    renderList(); renderDetail();
    toast(`已复制为「${copy.name}」，端口 ${copy.port}，未启动`);
  } catch (err) { handleError(err); }
};
$('mock-export').onclick = async () => {
  try {
    const result = await window.relay.exportMock();
    if (result) toast(`已导出 ${result.mockServices} 个 Mock 服务、${result.proxyRules} 条代理接口规则（不含 Header 和后端地址）`);
  } catch (err) { handleError(err); }
};
$('mock-import').onclick = async () => {
  try {
    const report = await window.relay.importMock();
    if (!report) return;
    const notes = [];
    if (report.renamedServices) notes.push(`${report.renamedServices} 个重名已加后缀`);
    if (report.portChanged) notes.push(`${report.portChanged} 个端口冲突已顺延`);
    if (report.rulesSkipped) notes.push(`${report.rulesSkipped} 条已存在的规则被跳过`);
    if (report.unmatchedProxies.length) notes.push(`未找到同名代理：${report.unmatchedProxies.join('、')}`);
    toast(`已导入 ${report.services} 个 Mock 服务、${report.rulesAdded} 条代理接口规则${notes.length ? `（${notes.join('；')}）` : ''}`, notes.length > 0);
  } catch (err) { handleError(err); }
};
$('rule-scenario').onchange = (event) => { captureScenario(); showScenario(event.target.value); };
$('rule-scenario-active').onchange = (event) => {
  if (event.target.checked) { state.ruleDraft.activeId = state.ruleDraft.viewId; renderScenarioBar(); return; }
  event.target.checked = true; // 启用中的场景不能直接取消：请在想启用的场景上勾选
  toast('同一接口必须有一个启用的场景，请切换到要启用的场景后勾选', true);
};
$('rule-scenario-add').onclick = () => {
  const draft = state.ruleDraft;
  if (draft.scenarios.length >= 20) return toast('同一个接口最多支持 20 个 Mock 场景', true);
  captureScenario();
  let n = draft.scenarios.length + 1;
  while (draft.scenarios.some((s) => s.name === `场景 ${n}`)) n += 1;
  const id = tempScenarioId();
  draft.scenarios.push({ id, name: `场景 ${n}`, response: structuredClone(viewedScenario().response) });
  showScenario(id);
  $('rule-scenario-name').focus();
  $('rule-scenario-name').select();
};
$('rule-scenario-delete').onclick = () => {
  const draft = state.ruleDraft;
  if (draft.scenarios.length <= 1) return;
  const scenario = viewedScenario();
  if (!window.confirm(`确定删除场景「${scenario.name}」吗？（点「保存规则」后生效）`)) return;
  draft.scenarios = draft.scenarios.filter((s) => s.id !== scenario.id);
  if (draft.activeId === scenario.id) draft.activeId = draft.scenarios[0].id;
  showScenario(draft.activeId);
};
$('rules-list').onchange = async (event) => {
  const select = event.target.closest('select[data-rule-action="scenario"]');
  const row = event.target.closest('.rule-row');
  const proxy = selected();
  if (!select || !row || !proxy) return;
  try {
    const rule = await window.relay.switchScenario(proxy.id, row.dataset.id, select.value);
    toast(`已切换到场景「${rule.scenario.name}」：${rule.method} ${rule.path}${running(proxy.id) ? '，已即时生效' : ''}`);
  } catch (err) { handleError(err); renderRules(); }
};
$('add-rule').onclick = () => openRuleModal();
$('close-rule').onclick = closeRuleModal;
$('cancel-rule').onclick = closeRuleModal;
$('rule-backdrop').onclick = (event) => { if (event.target === $('rule-backdrop')) closeRuleModal(); };
$('rule-mode').onchange = toggleRuleField;
$('rule-dynamic').onchange = toggleRuleField;
$('rule-preview').onclick = async () => {
  $('rule-error').classList.add('hidden');
  try {
    const text = await window.relay.previewRule(readRuleForm());
    $('rule-preview-result').textContent = formatBody({ body: text });
    $('rule-preview-result').classList.remove('hidden');
  } catch (err) {
    $('rule-error').textContent = err.message;
    $('rule-error').classList.remove('hidden');
  }
};
$('add-rule-header').onclick = () => addHeaderRow({}, 'rule-headers-editor', 'rule-headers-empty');
$('rule-format').onclick = () => {
  try { $('rule-body').value = JSON.stringify(JSON.parse($('rule-body').value), null, 2); }
  catch { toast('Body 不是有效的 JSON，无法格式化', true); }
};
$('rules-list').onclick = async (event) => {
  const target = event.target.closest('[data-rule-action]');
  const row = event.target.closest('.rule-row');
  const proxy = selected();
  if (!target || !row || !proxy) return;
  const rules = proxy.rules.map((r) => ({ ...r }));
  const rule = rules.find((r) => r.id === row.dataset.id);
  if (!rule) return;
  const action = target.dataset.ruleAction;
  if (action === 'edit') return openRuleModal(rule.id);
  if (action === 'mode') {
    if (rule.mode === target.dataset.mode) return;
    rule.mode = target.dataset.mode;
    await persistRules(rules, rule.mode === 'mock' ? `已切换为 Mock：${rule.method} ${rule.path}` : `已切换为代理：${rule.method} ${rule.path}`);
  }
  if (action === 'enable') {
    rule.enabled = target.checked;
    if (!(await persistRules(rules)) ) target.checked = !target.checked;
  }
};
$('rule-form').onsubmit = async (event) => {
  event.preventDefault();
  const proxy = selected();
  if (!proxy) return;
  const draft = buildRuleForSave();
  const rules = proxy.rules.map((r) => ({ ...r }));
  const index = rules.findIndex((r) => r.id === state.editingRuleId);
  if (index >= 0) rules[index] = draft; else rules.push(draft);
  $('save-rule').disabled = true;
  try {
    await window.relay.saveRules(proxy.id, rules);
    closeRuleModal();
    toast('接口规则已保存' + (running(proxy.id) ? '，已即时生效' : '，启动代理后生效'));
  } catch (err) {
    $('rule-error').textContent = err.message;
    $('rule-error').classList.remove('hidden');
  } finally { $('save-rule').disabled = false; }
};
$('delete-rule').onclick = async () => {
  const proxy = selected();
  const rule = proxy?.rules.find((r) => r.id === state.editingRuleId);
  if (!rule || !window.confirm(`确定删除规则「${rule.method} ${rule.path}」吗？`)) return;
  if (await persistRules(proxy.rules.filter((r) => r.id !== rule.id), '规则已删除')) closeRuleModal();
};
// ---------- 从真实响应生成 Mock ----------
function closeTraceMock() { $('tm-backdrop').classList.add('hidden'); }

function renderTraceMockTargets(defaultId) {
  $('tm-target').innerHTML = [
    ...state.proxies.map((p) => `<option value="${escapeHtml(p.id)}">代理 · ${escapeHtml(p.name)}</option>`),
    ...state.mockServices.map((m) => `<option value="${escapeHtml(m.id)}">Mock 服务 · ${escapeHtml(m.name)}</option>`),
  ].join('');
  $('tm-target').value = defaultId;
}

/** 按当前选择的保存位置 / 生成方式向主进程要一份草稿，填进弹窗（可再手动修改）。 */
async function loadTraceMockDraft() {
  const tm = state.tm;
  let mode = $('tm-mode').value;
  $('tm-error').classList.add('hidden');
  if (mode === 'ai' && !window.confirm(`将把这次响应的内容发送到 AI 服务：\n${await aiBaseUrl()}\n\n是否继续？`)) { $('tm-mode').value = 'fixed'; mode = 'fixed'; }
  $('tm-regen').disabled = true;
  $('tm-save').disabled = true;
  try {
    const draft = await window.relay.draftFromTrace(tm.traceId, { targetId: $('tm-target').value, mode });
    tm.draft = draft;
    $('tm-path').value = draft.rule.path;
    $('tm-status').value = draft.rule.response.status;
    $('tm-body').value = draft.rule.response.body;
    const method = draft.rule.method;
    $('tm-summary').textContent = `${method} ${state.trace?.request?.url || ''} → ${draft.rule.response.status} · 样例 ${draft.sampleBytes} 字节${draft.rule.response.dynamic ? ' · 已生成动态模板' : ''}`;
    $('tm-existing').classList.toggle('hidden', !draft.existing);
    if (draft.existing) $('tm-existing').textContent = `该接口已经有规则（现有场景：${draft.existing.scenarios.join('、')}）。创建时会追加为一个新场景，不会覆盖已有数据；勾选「立即启用」会直接切换到新场景。`;
    $('tm-save').disabled = false;
  } catch (err) {
    $('tm-error').textContent = err.message;
    $('tm-error').classList.remove('hidden');
    if (mode !== 'fixed' && !tm.draft) { $('tm-mode').value = 'fixed'; }
  } finally { $('tm-regen').disabled = false; }
}

$('trace-to-mock').onclick = async () => {
  if (!state.trace) return;
  state.tm = { traceId: state.trace.id, draft: null };
  renderTraceMockTargets(state.trace.proxyId);
  $('tm-mode').value = 'fixed';
  $('tm-enable').checked = true;
  $('tm-backdrop').classList.remove('hidden');
  await loadTraceMockDraft();
  if (!state.tm.draft) { // 样例不可用（二进制、被截断等）：关闭弹窗并直接说明原因
    const reason = $('tm-error').textContent || '无法生成 Mock';
    closeTraceMock();
    handleError(new Error(reason));
  }
};
$('close-tm').onclick = closeTraceMock;
$('tm-cancel').onclick = closeTraceMock;
$('tm-backdrop').onclick = (event) => { if (event.target === $('tm-backdrop')) closeTraceMock(); };
$('tm-mode').onchange = loadTraceMockDraft;
$('tm-target').onchange = loadTraceMockDraft;
$('tm-regen').onclick = loadTraceMockDraft;
$('tm-save').onclick = async () => {
  const tm = state.tm;
  if (!tm?.draft) return;
  const rule = structuredClone(tm.draft.rule);
  rule.path = $('tm-path').value;
  rule.response.status = Number($('tm-status').value);
  rule.response.body = $('tm-body').value;
  $('tm-save').disabled = true;
  try {
    const targetId = $('tm-target').value;
    const saved = await window.relay.applyTraceDraft(targetId, rule, { enabled: $('tm-enable').checked });
    closeTraceMock();
    closeTrace(); renderLogs();
    const where = state.mockServices.some((m) => m.id === targetId) ? 'Mock 服务' : '代理';
    const enabled = $('tm-enable').checked;
    const scenarioName = enabled ? saved.scenario.name : saved.alternatives.at(-1)?.name; // 启用时新场景就是当前场景
    toast(saved.addedAsScenario
      ? `该接口已有规则，已把这次响应追加为场景「${scenarioName}」${enabled ? '并已启用' : '（未启用，可在规则行里切换）'}`
      : `已在${where}里创建 Mock：${saved.method} ${saved.path}${saved.enabled ? '，已启用' : '（未启用，请在「接口规则」里勾选启用）'}`);
  } catch (err) {
    $('tm-error').textContent = err.message;
    $('tm-error').classList.remove('hidden');
  } finally { $('tm-save').disabled = false; }
};
// ---------- AI / 文档 事件 ----------
$('open-ai').onclick = openAiModal;
$('close-ai').onclick = closeAiModal;
$('ai-cancel').onclick = closeAiModal;
$('ai-backdrop').onclick = (event) => { if (event.target === $('ai-backdrop')) closeAiModal(); };
$('ai-clear-key').onclick = () => {
  if (!window.confirm('确定清除已保存的 API Key 吗？')) return;
  state.aiClearKey = true;
  $('ai-key').value = '';
  $('ai-key-state').textContent = '保存后清除';
};
$('ai-form').onsubmit = async (event) => {
  event.preventDefault();
  $('ai-save').disabled = true;
  try { await saveAiSettings(); closeAiModal(); toast('AI 设置已保存'); }
  catch (err) { $('ai-error').textContent = err.message; $('ai-error').classList.remove('hidden'); }
  finally { $('ai-save').disabled = false; }
};
$('ai-test').onclick = async () => {
  $('ai-error').classList.add('hidden');
  $('ai-status').classList.add('hidden');
  $('ai-test').disabled = true;
  try {
    await saveAiSettings();
    const result = await window.relay.testAi();
    $('ai-status').textContent = `✓ 连接成功 · 模型 ${result.model} · ${result.ms} ms`;
    $('ai-status').classList.remove('hidden');
  } catch (err) { $('ai-error').textContent = err.message; $('ai-error').classList.remove('hidden'); }
  finally { $('ai-test').disabled = false; }
};

$('open-docs').onclick = () => {
  renderTargets();
  renderDocsSelect(state.currentDoc?.id);
  $('docs-backdrop').classList.remove('hidden');
};
$('close-docs').onclick = closeDocs;
$('docs-backdrop').onclick = (event) => { if (event.target === $('docs-backdrop')) closeDocs(); };
$('docs-select').onchange = (event) => loadDoc(event.target.value);
$('docs-filter').oninput = renderEndpoints;
$('docs-check-all').onchange = (event) => {
  for (const e of visibleEndpoints()) { if (event.target.checked) state.docChecked.add(e.id); else state.docChecked.delete(e.id); }
  renderEndpoints();
};
$('docs-endpoints').onchange = (event) => {
  const id = event.target.dataset.id;
  if (!id) return;
  if (event.target.checked) state.docChecked.add(id); else state.docChecked.delete(id);
  renderEndpoints();
};
$('docs-import').onclick = async () => {
  const kind = $('docs-import-kind').value;
  if (kind === 'markdown-ai' && !window.confirm(`将把所选文档的内容发送到 AI 服务：\n${await aiBaseUrl()}\n\n是否继续？`)) return;
  $('docs-import').disabled = true;
  try {
    const summary = await window.relay.importDoc(kind);
    if (!summary) return;
    renderDocsSelect(summary.id);
    toast(`已导入「${summary.name}」：${summary.endpointCount} 个接口${summary.needsConfirmCount ? `，其中 ${summary.needsConfirmCount} 个待确认` : ''}`);
  } catch (err) { handleError(err); }
  finally { $('docs-import').disabled = false; }
};
$('docs-delete').onclick = async () => {
  const doc = state.currentDoc;
  if (!doc || !window.confirm(`确定删除文档「${doc.name}」吗？已经生成的接口规则不会被删除。`)) return;
  try { await window.relay.deleteDoc(doc.id); renderDocsSelect(); toast('文档已删除'); }
  catch (err) { handleError(err); }
};
$('docs-generate').onclick = generateDrafts;
$('docs-stop').onclick = () => { if (state.aiJob) window.relay.cancelAi(state.aiJob.jobId).catch(handleError); };
$('docs-discard').onclick = () => { state.drafts = null; renderDrafts(); };
$('docs-apply').onclick = applyDrafts;
$('docs-drafts').oninput = (event) => {
  const card = event.target.closest('.draft-card');
  if (card && event.target.classList.contains('draft-body')) state.drafts[Number(card.dataset.index)].rule.response.body = event.target.value;
};
$('docs-drafts').onchange = (event) => {
  const card = event.target.closest('.draft-card');
  if (card && event.target.classList.contains('draft-include')) state.drafts[Number(card.dataset.index)].include = event.target.checked;
};
window.relay.onAiProgress((data) => {
  if (!state.aiJob || data.jobId !== state.aiJob.jobId || data.status === 'running') return;
  state.aiJob.done += 1;
  $('docs-progress').textContent = `AI 生成中… ${state.aiJob.done} / ${state.aiJob.total}${data.status === 'error' ? `（「${data.endpointId}」失败：${data.error}）` : ''}`;
});

// 规则编辑框里的 AI 功能：只产生候选结果，点“采用”才会填入编辑框（仍需点“保存规则”才会生效）
function showAiCandidate(title, body, dynamic, extra) {
  state.aiCandidate = { body, dynamic };
  $('rule-ai-title').textContent = title;
  $('rule-ai-result').textContent = extra ? `${body}\n\n—— 渲染示例 ——\n${extra}` : body;
  $('rule-ai-candidate').classList.remove('hidden');
}
$('rule-ai-template').onclick = async () => {
  const body = $('rule-body').value;
  if (!body.trim()) return toast('请先填写固定的返回数据，再让 AI 改写成模板', true);
  if (!window.confirm(`将把当前响应内容发送到 AI 服务：\n${await aiBaseUrl()}\n\n是否继续？`)) return;
  $('rule-ai-template').disabled = true;
  try { const result = await window.relay.aiTemplate(body, $('rule-note').value); showAiCandidate('AI 生成的模板', result.template, true, result.preview); }
  catch (err) { $('rule-error').textContent = err.message; $('rule-error').classList.remove('hidden'); }
  finally { $('rule-ai-template').disabled = false; }
};
$('rule-ai-regenerate').onclick = async () => {
  if (!window.confirm(`将把该接口的文档 Schema / 示例发送到 AI 服务：\n${await aiBaseUrl()}\n\n是否继续？`)) return;
  $('rule-ai-regenerate').disabled = true;
  try { const result = await window.relay.aiRegenerate(readRuleForm(), { dynamic: $('rule-dynamic').checked }); showAiCandidate('AI 按文档重新生成', result.body, result.dynamic); }
  catch (err) { $('rule-error').textContent = err.message; $('rule-error').classList.remove('hidden'); }
  finally { $('rule-ai-regenerate').disabled = false; }
};
$('rule-ai-accept').onclick = () => {
  if (!state.aiCandidate) return;
  $('rule-body').value = state.aiCandidate.body;
  $('rule-dynamic').checked = state.aiCandidate.dynamic;
  toggleRuleField();
  $('rule-ai-candidate').classList.add('hidden');
  state.aiCandidate = null;
  toast('已填入编辑框，点「保存规则」后生效');
};
$('rule-ai-discard').onclick = () => { $('rule-ai-candidate').classList.add('hidden'); state.aiCandidate = null; };
$('minimize').onclick = () => window.relay.minimize();
$('maximize').onclick = () => window.relay.maximize();
$('close').onclick = () => window.relay.close();

window.relay.onState(async (data) => {
  state.projects = data.projects || [];
  state.activeProjectId = data.activeProjectId;
  renderProjects();
  state.proxies = data.proxies;
  state.mockServices = data.mockServices || [];
  state.docs = data.docs || [];
  state.globalHeaders = data.globalHeaders || [];
  state.running = data.running;
  if (state.selectedId && !selected()) state.selectedId = listItems()[0]?.id || null;
  renderList();
  renderDetail();
});
window.relay.onLog((entry) => {
  state.logs.push(entry);
  if (state.logs.length > 5000) state.logs.shift();
  if (entry.proxyId === state.selectedId) { renderStats(); renderLogs(); }
});

(async () => {
  try {
    const data = await window.relay.getState();
    state.projects = data.projects || [];
    state.activeProjectId = data.activeProjectId;
    renderProjects();
    if (data.migrationIssues?.length) toast(`有 ${data.migrationIssues.length} 个旧代理未能迁移（${data.migrationIssues[0].name}：${data.migrationIssues[0].reason}），原配置已备份为 proxies.json.v1.2.bak`, true);
    state.proxies = data.proxies;
    state.mockServices = data.mockServices || [];
    state.docs = data.docs || [];
    state.globalHeaders = data.globalHeaders || [];
    state.running = data.running;
    state.selectedId = data.proxies[0]?.id || null;
    state.logs = await window.relay.getLogs();
    renderList();
    renderDetail();
  } catch (err) { handleError(err); }
})();
