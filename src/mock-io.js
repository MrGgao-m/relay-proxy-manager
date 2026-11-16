'use strict';

// 项目 Mock 配置的导出 / 导入。只包含 Mock 数据（Mock 服务与代理的接口规则），
// 不含代理地址、项目 Header 等可能带有令牌的信息。

const { validateRules } = require('./rules');
const store = require('./store');

const FORMAT = 'relay-mock-config';
const VERSION = 1;

function exportMockConfig(project) {
  return {
    format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), project: project.name,
    proxyRules: project.proxies.filter((p) => p.rules.length).map((p) => ({ name: p.name, prefix: p.prefix, rules: p.rules })),
    mockServices: project.mockServices.map((m) => ({ name: m.name, port: m.port, autoStart: m.autoStart, rules: m.rules })),
  };
}

const withoutIds = (rules) => (Array.isArray(rules) ? rules : []).map((rule) => ({ ...rule, id: undefined }));
const ruleKey = (rule) => `${rule.method} ${rule.path.replace(/:[A-Za-z0-9_]+/g, ':')}`;

/**
 * 导入到指定项目。先在副本上完成全部校验，任何一项失败都不会改动现有配置。
 * Mock 服务：名称重复自动加后缀，端口冲突自动顺延；代理规则：按“名称 + 前缀”匹配代理，已存在的接口跳过。
 */
function importMockConfig(config, project, data, { validateMockService }) {
  if (!data || data.format !== FORMAT) throw new Error('这不是 Relay 导出的 Mock 配置文件。');
  if (data.version !== VERSION) throw new Error(`不支持的配置版本：${data.version}。`);

  const report = { services: 0, renamedServices: 0, portChanged: 0, rulesAdded: 0, rulesSkipped: 0, unmatchedProxies: [] };
  const names = project.mockServices.map((m) => m.name);
  const reserved = new Set();
  const services = [];
  for (const item of Array.isArray(data.mockServices) ? data.mockServices : []) {
    const name = store.uniqueName(names, String(item.name || 'Mock 服务'));
    if (name !== String(item.name || '').trim()) report.renamedServices += 1;
    names.push(name);
    let port = Number(item.port);
    if (!Number.isInteger(port) || store.portOwner(config, port) || reserved.has(port)) {
      port = store.nextFreePort(config, Number.isInteger(port) && port > 0 && port < 65535 ? port + 1 : 9000, reserved);
      report.portChanged += 1;
    }
    reserved.add(port);
    services.push(validateMockService({ ...item, name, port, autoStart: false, rules: withoutIds(item.rules) }));
  }

  const updates = [];
  for (const entry of Array.isArray(data.proxyRules) ? data.proxyRules : []) {
    const proxy = project.proxies.find((p) => p.name === entry.name && p.prefix === entry.prefix);
    if (!proxy) { report.unmatchedProxies.push(String(entry.name || '(未命名)')); continue; }
    const incoming = validateRules(withoutIds(entry.rules));
    const existing = new Set(proxy.rules.map(ruleKey));
    const fresh = incoming.filter((rule) => !existing.has(ruleKey(rule)));
    report.rulesSkipped += incoming.length - fresh.length;
    report.rulesAdded += fresh.length;
    updates.push({ proxy, rules: validateRules([...proxy.rules, ...fresh]) });
  }

  project.mockServices.push(...services);
  for (const { proxy, rules } of updates) proxy.rules = rules;
  report.services = services.length;
  return report;
}

module.exports = { FORMAT, VERSION, exportMockConfig, importMockConfig };
