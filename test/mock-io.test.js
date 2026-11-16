'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/store');
const { validateProxy, validateMockService } = require('../src/proxy-manager');
const { exportMockConfig, importMockConfig, FORMAT } = require('../src/mock-io');

const deps = { validateMockService };
const rule = (path, body = '{"ok":true}', extra = {}) => ({ method: 'GET', path, response: { body, headers: [{ name: 'X-A', value: '1' }], delayMs: 5, dynamic: body.includes('{{') }, note: '备注', ...extra });

function sourceProject() {
  const config = store.defaultConfig();
  const project = store.activeProject(config);
  project.headers = [{ name: 'Authorization', value: 'Bearer SECRET', enabled: true }];
  project.proxies.push(validateProxy({ name: '后台', port: 18501, target: 'http://secret-host:8106', prefix: '/api', headers: [{ name: 'Cookie', value: 'sid=SECRET', enabled: true }], rules: [rule('/p/list'), rule('/p/:id', '{"id":"{{params.id}}"}')] }, 'px'));
  project.mockServices.push(validateMockService({ name: '患者 Mock', port: 18502, rules: [rule('/a'), rule('/b/:id', '{"n":"{{int 1 9}}"}')] }, 'mk'));
  return { config, project };
}

test('导出：只含 Mock 数据，不含代理地址、Header、令牌', () => {
  const { project } = sourceProject();
  const data = exportMockConfig(project);
  assert.equal(data.format, FORMAT);
  assert.equal(data.mockServices.length, 1);
  assert.equal(data.proxyRules[0].rules.length, 2);
  const text = JSON.stringify(data);
  assert.ok(!text.includes('SECRET') && !text.includes('secret-host'), '不含令牌与后端地址');
});

test('导出 → 导入到新项目：接口、响应内容、动态开关完整恢复', () => {
  const { project } = sourceProject();
  const data = JSON.parse(JSON.stringify(exportMockConfig(project)));

  const target = store.defaultConfig();
  const dest = store.activeProject(target);
  dest.proxies.push(validateProxy({ name: '后台', port: 18601, target: 'http://other:1', prefix: '/api' }, 'px2'));
  const report = importMockConfig(target, dest, data, deps);

  assert.deepEqual({ ...report, unmatchedProxies: report.unmatchedProxies }, { services: 1, renamedServices: 0, portChanged: 0, rulesAdded: 2, rulesSkipped: 0, unmatchedProxies: [] });
  const strip = (rules) => rules.map(({ id, ...rest }) => rest);
  assert.deepEqual(strip(dest.mockServices[0].rules), strip(project.mockServices[0].rules));
  assert.deepEqual(strip(dest.proxies[0].rules), strip(project.proxies[0].rules));
  assert.equal(dest.mockServices[0].rules[1].response.dynamic, true);
  assert.equal(dest.mockServices[0].port, 18502);
  assert.equal(dest.mockServices[0].autoStart, false);
});

test('导入冲突：重名加后缀、端口顺延、同接口规则跳过、找不到的代理被报告', () => {
  const { config, project } = sourceProject();
  const data = JSON.parse(JSON.stringify(exportMockConfig(project)));
  data.proxyRules.push({ name: '不存在', prefix: '/x', rules: [rule('/z')] });
  data.mockServices.push({ ...data.mockServices[0] }); // 同一文件里端口、名称重复

  const report = importMockConfig(config, project, data, deps);
  assert.equal(report.services, 2);
  assert.equal(report.renamedServices, 2);
  assert.equal(report.portChanged, 2);
  assert.deepEqual(project.mockServices.map((m) => m.name), ['患者 Mock', '患者 Mock 2', '患者 Mock 3']);
  const ports = project.mockServices.map((m) => m.port);
  assert.equal(new Set(ports).size, 3, '端口各不相同');
  assert.equal(report.rulesAdded, 0);
  assert.equal(report.rulesSkipped, 2, '同 Method + 路径已存在则跳过');
  assert.deepEqual(report.unmatchedProxies, ['不存在']);
  assert.equal(project.proxies[0].rules.length, 2);
});

test('导入失败不改动现有配置：格式错误、版本不符、规则非法', () => {
  const { config, project } = sourceProject();
  const before = JSON.stringify(config);
  assert.throws(() => importMockConfig(config, project, { hello: 1 }, deps), /不是 Relay 导出的/);
  assert.throws(() => importMockConfig(config, project, { format: FORMAT, version: 9 }, deps), /不支持的配置版本/);
  const data = exportMockConfig(project);
  data.mockServices.push({ name: '坏', port: 18999, rules: [{ method: 'GET', path: '/x', response: { status: 7 } }] });
  assert.throws(() => importMockConfig(config, project, data, deps), /状态码/);
  assert.equal(JSON.stringify(config), before, '一项失败，全部不生效');
});

test('导出 / 导入保留所有 Mock 场景及当前启用的场景', () => {
  const { project } = sourceProject();
  project.mockServices[0].rules[0] = validateMockService({ name: 'x', port: 1, rules: [{ method: 'GET', path: '/multi', scenario: { name: '成功' }, response: { body: '"ok"' }, alternatives: [{ name: '报错', response: { status: 500, body: '"bad"' } }] }] }).rules[0];
  const data = JSON.parse(JSON.stringify(exportMockConfig(project)));
  const target = store.defaultConfig();
  const dest = store.activeProject(target);
  importMockConfig(target, dest, data, deps);
  const imported = dest.mockServices[0].rules[0];
  assert.equal(imported.scenario.name, '成功');
  assert.deepEqual(imported.alternatives.map((a) => [a.name, a.response.status]), [['报错', 500]]);
});
