'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

contextBridge.exposeInMainWorld('relay', {
  getState: () => invoke('state:get'),
  getLocalIps: () => invoke('system:ips'),
  saveGlobalHeaders: (headers) => invoke('global-headers:save', headers),
  addProject: (name) => invoke('project:add', name),
  renameProject: (id, name) => invoke('project:rename', id, name),
  selectProject: (id) => invoke('project:select', id),
  deleteProject: (id) => invoke('project:delete', id),
  saveMock: (service, id) => invoke('mock:save', service, id),
  deleteMock: (id) => invoke('mock:delete', id),
  duplicateMock: (id) => invoke('mock:duplicate', id),
  exportMock: () => invoke('mock:export'),
  importMock: () => invoke('mock:import'),
  importDoc: (kind) => invoke('docs:import', kind),
  getDoc: (id) => invoke('docs:get', id),
  deleteDoc: (id) => invoke('docs:delete', id),
  previewDocDrafts: (docId, endpointIds, options) => invoke('docs:preview', docId, endpointIds, options),
  applyDocDrafts: (targetId, drafts, options) => invoke('docs:apply', targetId, drafts, options),
  getAi: () => invoke('ai:get'),
  saveAi: (settings, apiKey) => invoke('ai:save', settings, apiKey),
  testAi: () => invoke('ai:test'),
  aiTemplate: (body, hint) => invoke('ai:template', body, hint),
  aiRegenerate: (rule, options) => invoke('ai:regenerate', rule, options),
  aiGenerateDrafts: (docId, endpointIds, options, jobId) => invoke('ai:generate-drafts', docId, endpointIds, options, jobId),
  cancelAi: (jobId) => invoke('ai:cancel', jobId),
  onAiProgress: (callback) => ipcRenderer.on('ai:progress', (_, data) => callback(data)),
  getRules: (proxyId) => invoke('rules:get', proxyId),
  saveRules: (proxyId, rules) => invoke('rules:save', proxyId, rules),
  previewRule: (rule) => invoke('rules:preview', rule),
  switchScenario: (proxyId, ruleId, scenarioId) => invoke('rules:switch', proxyId, ruleId, scenarioId),
  draftFromTrace: (traceId, options) => invoke('rules:draft-from-trace', traceId, options),
  applyTraceDraft: (targetId, rule, options) => invoke('rules:apply-trace-draft', targetId, rule, options),
  ruleFromTrace: (traceId) => invoke('rules:from-trace', traceId),
  getLogs: (proxyId) => invoke('logs:get', proxyId),
  getTrace: (traceId) => invoke('trace:get', traceId),
  saveProxy: (proxy, id) => invoke('proxy:save', proxy, id),
  deleteProxy: (id) => invoke('proxy:delete', id),
  startProxy: (id) => invoke('proxy:start', id),
  stopProxy: (id) => invoke('proxy:stop', id),
  restartProxy: (id) => invoke('proxy:restart', id),
  clearLogs: (id) => invoke('logs:clear', id),
  exportLogs: (id) => invoke('logs:export', id),
  minimize: () => invoke('window:minimize'),
  maximize: () => invoke('window:maximize'),
  close: () => invoke('window:close'),
  onState: (callback) => ipcRenderer.on('state:changed', (_, data) => callback(data)),
  onLog: (callback) => ipcRenderer.on('log:added', (_, entry) => callback(entry)),
});
