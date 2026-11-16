'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { validateHeaders } = require('./validators');

const SCHEMA_VERSION = 2;
const CONFIG_FILE = 'relay-config.json';
const LEGACY_FILE = 'proxies.json';
const LEGACY_BACKUP = 'proxies.json.v1.2.bak';

const DEFAULT_AI = { provider: 'openai', baseUrl: '', model: '', timeoutMs: 60_000, customPrompt: '' };

function newProject(name = '默认项目') {
  return { id: randomUUID(), name, createdAt: new Date().toISOString(), headers: [], proxies: [], mockServices: [], docs: [] };
}

function defaultConfig() {
  const project = newProject();
  return { schemaVersion: SCHEMA_VERSION, app: { ai: { ...DEFAULT_AI } }, activeProjectId: project.id, projects: [project] };
}

function validateProjectName(config, name, selfId) {
  const value = String(name || '').trim();
  if (!value || value.length > 40) throw new Error('请输入不超过 40 个字符的项目名称。');
  if (config.projects.some((p) => p.id !== selfId && p.name === value)) throw new Error(`项目「${value}」已存在，请换一个名称。`);
  return value;
}

/** v1.2 → v2。逐条容错：不合法的代理不丢弃，进入报告，原文件备份保留完整数据。 */
function migrateLegacy(legacy, { validateProxy }) {
  const project = newProject();
  const issues = [];
  const proxies = Array.isArray(legacy.proxies) ? legacy.proxies : [];
  for (const item of proxies) {
    try { project.proxies.push(validateProxy(item, item?.id)); }
    catch (err) { issues.push({ name: item?.name || '(未命名)', reason: err.message }); }
  }
  try { project.headers = validateHeaders(Array.isArray(legacy.globalHeaders) ? legacy.globalHeaders : []); }
  catch (err) { issues.push({ name: '全局 Header', reason: err.message }); }
  return { config: { schemaVersion: SCHEMA_VERSION, app: { ai: { ...DEFAULT_AI } }, activeProjectId: project.id, projects: [project] }, issues };
}

function normalizeDoc(doc) {
  return {
    id: doc.id, name: String(doc.name || '未命名文档'), type: doc.type === 'markdown' ? 'markdown' : 'openapi', importedAt: doc.importedAt || new Date().toISOString(),
    info: doc.info && typeof doc.info === 'object' ? doc.info : {}, warnings: Array.isArray(doc.warnings) ? doc.warnings : [], skipped: Array.isArray(doc.skipped) ? doc.skipped : [],
    endpoints: doc.endpoints.map((e) => ({ ...e, params: e.params || [], responses: e.responses || [], needsConfirm: Array.isArray(e.needsConfirm) ? e.needsConfirm : [] })),
  };
}

function normalizeConfig(raw, deps) {
  const { validateProxy } = deps;
  if (!raw || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.projects) || !raw.projects.length) {
    throw new Error('配置文件格式不受支持或已损坏。');
  }
  const ids = new Set();
  const projects = raw.projects.map((p) => {
    if (!p.id || ids.has(p.id)) throw new Error('配置文件中的项目 ID 缺失或重复。');
    ids.add(p.id);
    return {
      id: p.id, name: String(p.name || '未命名项目').slice(0, 40), createdAt: p.createdAt || new Date().toISOString(),
      headers: validateHeaders(Array.isArray(p.headers) ? p.headers : []),
      proxies: (Array.isArray(p.proxies) ? p.proxies : []).map((item) => validateProxy(item, item.id)),
      mockServices: (Array.isArray(p.mockServices) ? p.mockServices : []).map((item) => deps.validateMockService(item, item.id)),
      docs: (Array.isArray(p.docs) ? p.docs : []).filter((d) => d && d.id && Array.isArray(d.endpoints)).map(normalizeDoc),
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    app: { ai: { ...DEFAULT_AI, ...(raw.app?.ai || {}) } },
    activeProjectId: projects.some((p) => p.id === raw.activeProjectId) ? raw.activeProjectId : projects[0].id,
    projects,
  };
}

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

/** 返回 { config, issues, migrated }。配置损坏时抛错且不覆盖原文件。 */
async function loadConfig(dir, deps) {
  const configPath = path.join(dir, CONFIG_FILE);
  const legacyPath = path.join(dir, LEGACY_FILE);
  let text = null;
  try { text = await fs.readFile(configPath, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (text !== null) {
    let raw;
    try { raw = JSON.parse(text); } catch { throw new Error(`${CONFIG_FILE} 不是有效的 JSON，已保留原文件，请检查或删除后重试。`); }
    return { config: normalizeConfig(raw, deps), issues: [], migrated: false };
  }

  let legacyText = null;
  try { legacyText = await fs.readFile(legacyPath, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (legacyText === null) return { config: defaultConfig(), issues: [], migrated: false };

  let legacy;
  try { legacy = JSON.parse(legacyText); } catch { throw new Error(`旧配置 ${LEGACY_FILE} 不是有效的 JSON，无法迁移，原文件未改动。`); }
  const backupPath = path.join(dir, LEGACY_BACKUP);
  if (!(await exists(backupPath))) await fs.copyFile(legacyPath, backupPath); // 备份失败 → 抛错 → 中止迁移
  const { config, issues } = migrateLegacy(legacy, deps);
  await saveConfig(dir, config);
  return { config, issues, migrated: true };
}

async function saveConfig(dir, config) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, CONFIG_FILE);
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(config, null, 2), 'utf8');
  await fs.rename(temp, file);
}

// ---------- 查询与校验 ----------

function activeProject(config) { return config.projects.find((p) => p.id === config.activeProjectId); }

/** 在所有项目中查找代理或 Mock 服务，返回 { project, item, kind }。 */
function findService(config, id) {
  for (const project of config.projects) {
    const proxy = project.proxies.find((p) => p.id === id);
    if (proxy) return { project, item: proxy, kind: 'proxy' };
    const mock = project.mockServices.find((m) => m.id === id);
    if (mock) return { project, item: mock, kind: 'mock' };
  }
  return null;
}

function findProxy(config, id) {
  for (const project of config.projects) {
    const proxy = project.proxies.find((p) => p.id === id);
    if (proxy) return { project, proxy };
  }
  return null;
}

/** 所有项目的代理 + Mock 服务端口占用情况（端口全局唯一）。 */
function portOwner(config, port, excludeId) {
  for (const project of config.projects) {
    for (const item of [...project.proxies, ...project.mockServices]) {
      if (item.id !== excludeId && item.port === port) return { project, item };
    }
  }
  return null;
}

/** 从 start 起向上找第一个未被任何代理 / Mock 服务占用的端口。 */
function nextFreePort(config, start, reserved = new Set()) {
  for (let port = start; port <= 65535; port += 1) {
    if (!reserved.has(port) && !portOwner(config, port)) return port;
  }
  throw new Error('没有可用的端口了，请先释放一些端口。');
}

function assertPortFree(config, port, excludeId) {
  const owner = portOwner(config, port, excludeId);
  if (owner) throw new Error(`端口 ${port} 已被项目「${owner.project.name}」的「${owner.item.name}」使用。`);
}

// ---------- Mock 服务 ----------

function uniqueName(existing, base) {
  const taken = new Set(existing);
  let name = base.slice(0, 40);
  for (let n = 2; taken.has(name); n += 1) name = `${base.slice(0, 36)} ${n}`;
  return name;
}

/** 复制 Mock 服务：新 ID、新名称、顺延到空闲端口，规则全部复制（规则也换新 ID）。 */
function duplicateMockService(config, project, id, validateMockService) {
  const source = project.mockServices.find((m) => m.id === id);
  if (!source) throw new Error('找不到此 Mock 服务。');
  const copy = validateMockService({
    ...source,
    name: uniqueName(project.mockServices.map((m) => m.name), `${source.name} 副本`),
    port: nextFreePort(config, source.port + 1),
    autoStart: false,
    rules: source.rules.map((rule) => ({ ...rule, id: undefined })),
  });
  project.mockServices.push(copy);
  return copy;
}

// ---------- 项目操作（原地修改 config，调用方负责保存）----------

function addProject(config, name) {
  const project = newProject(validateProjectName(config, name));
  config.projects.push(project);
  config.activeProjectId = project.id;
  return project;
}

function renameProject(config, id, name) {
  const project = config.projects.find((p) => p.id === id);
  if (!project) throw new Error('找不到此项目。');
  project.name = validateProjectName(config, name, id);
  return project;
}

/** 返回被删除项目下的所有代理 / Mock 服务 ID，便于调用方停止服务、清理日志。 */
function deleteProject(config, id) {
  if (config.projects.length <= 1) throw new Error('至少需要保留一个项目。');
  const project = config.projects.find((p) => p.id === id);
  if (!project) throw new Error('找不到此项目。');
  config.projects = config.projects.filter((p) => p.id !== id);
  if (config.activeProjectId === id) config.activeProjectId = config.projects[0].id;
  return [...project.proxies, ...project.mockServices].map((item) => item.id);
}

function setActiveProject(config, id) {
  if (!config.projects.some((p) => p.id === id)) throw new Error('找不到此项目。');
  config.activeProjectId = id;
}

module.exports = {
  SCHEMA_VERSION, CONFIG_FILE, LEGACY_FILE, LEGACY_BACKUP,
  defaultConfig, loadConfig, saveConfig, migrateLegacy, normalizeConfig,
  activeProject, findProxy, findService, portOwner, nextFreePort, assertPortFree, uniqueName, duplicateMockService,
  addProject, renameProject, deleteProject, setActiveProject,
};
