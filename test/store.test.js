'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/store');
const { validateProxy, validateMockService } = require('../src/proxy-manager');

const deps = { validateProxy, validateMockService };
async function tempDir(t) {
  const base = path.join(os.tmpdir(), 'proxy', 'tmp');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const legacyProxy = (over = {}) => ({ id: 'x1', name: '旧代理', port: 8009, target: 'http://10.0.7.33:8106', prefix: '/cgw/aiadmin', stripPrefix: true, autoStart: true, headers: [{ name: 'X-Old', value: '1', enabled: true }], cors: true, ...over });

test('首次启动：没有任何配置时创建默认项目，且不落盘', async (t) => {
  const dir = await tempDir(t);
  const { config, migrated, issues } = await store.loadConfig(dir, deps);
  assert.equal(migrated, false);
  assert.deepEqual(issues, []);
  assert.equal(config.projects.length, 1);
  assert.equal(config.activeProjectId, config.projects[0].id);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('迁移 v1.2：备份、默认项目、全局 Header 变项目 Header，旧文件不动', async (t) => {
  const dir = await tempDir(t);
  const legacy = JSON.stringify({ proxies: [legacyProxy(), legacyProxy({ id: 'x2', name: '第二条', port: 8010 })], globalHeaders: [{ name: 'Authorization', value: 'Bearer t', enabled: true }] }, null, 2);
  await fs.writeFile(path.join(dir, 'proxies.json'), legacy);

  const { config, migrated, issues } = await store.loadConfig(dir, deps);
  assert.equal(migrated, true);
  assert.deepEqual(issues, []);
  const project = config.projects[0];
  assert.equal(project.name, '默认项目');
  assert.deepEqual(project.proxies.map((p) => p.id), ['x1', 'x2']);
  assert.equal(project.proxies[0].autoStart, true);
  assert.deepEqual(project.proxies[0].rules, []);
  assert.deepEqual(project.headers, [{ name: 'Authorization', value: 'Bearer t', enabled: true }]);

  assert.equal(await fs.readFile(path.join(dir, 'proxies.json'), 'utf8'), legacy, '旧配置原样保留');
  assert.equal(await fs.readFile(path.join(dir, 'proxies.json.v1.2.bak'), 'utf8'), legacy, '备份与旧配置一致');
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'relay-config.json'), 'utf8'));
  assert.equal(saved.schemaVersion, 2);

  const again = await store.loadConfig(dir, deps);
  assert.equal(again.migrated, false, '第二次启动直接读取 v2');
  assert.equal(again.config.projects[0].proxies.length, 2);
});

test('迁移容错：个别代理不合法时不丢整份配置，并给出报告', async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(path.join(dir, 'proxies.json'), JSON.stringify({ proxies: [legacyProxy(), legacyProxy({ id: 'bad', name: '坏的', port: 99999 })], globalHeaders: [] }));
  const { config, issues } = await store.loadConfig(dir, deps);
  assert.equal(config.projects[0].proxies.length, 1);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].name, '坏的');
  assert.match(issues[0].reason, /端口/);
  assert.match(await fs.readFile(path.join(dir, 'proxies.json.v1.2.bak'), 'utf8'), /99999/, '备份保留完整原数据');
});

test('备份已存在时不覆盖；v2 配置损坏时报错且不改动文件', async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(path.join(dir, 'proxies.json'), JSON.stringify({ proxies: [], globalHeaders: [] }));
  await fs.writeFile(path.join(dir, 'proxies.json.v1.2.bak'), 'ORIGINAL');
  await store.loadConfig(dir, deps);
  assert.equal(await fs.readFile(path.join(dir, 'proxies.json.v1.2.bak'), 'utf8'), 'ORIGINAL');

  const dir2 = await tempDir(t);
  await fs.writeFile(path.join(dir2, 'relay-config.json'), '{ broken');
  await assert.rejects(store.loadConfig(dir2, deps), /有效的 JSON/);
  assert.equal(await fs.readFile(path.join(dir2, 'relay-config.json'), 'utf8'), '{ broken');
});

test('保存与读取往返一致，规则随代理持久化', async (t) => {
  const dir = await tempDir(t);
  const { config } = await store.loadConfig(dir, deps);
  const project = store.activeProject(config);
  project.proxies.push(validateProxy({ name: 'A', port: 18100, target: 'http://127.0.0.1:1', prefix: '/api', rules: [{ method: 'GET', path: '/x/:id', response: { body: '{"中文":1}' } }] }));
  await store.saveConfig(dir, config);
  const back = (await store.loadConfig(dir, deps)).config;
  assert.deepEqual(back.projects[0].proxies[0], project.proxies[0]);
  assert.equal(back.projects[0].proxies[0].rules[0].response.body, '{"中文":1}');
});

test('项目管理：重名、删除最后一个、删除后切换、端口全局唯一', async (t) => {
  const dir = await tempDir(t);
  const { config } = await store.loadConfig(dir, deps);
  const first = store.activeProject(config);
  first.proxies.push(validateProxy({ name: 'A', port: 18101, target: 'http://127.0.0.1:1', prefix: '/a' }, 'p-a'));

  const second = store.addProject(config, '项目二');
  assert.equal(config.activeProjectId, second.id);
  assert.throws(() => store.addProject(config, '项目二'), /已存在/);
  assert.throws(() => store.addProject(config, '  '), /项目名称/);
  assert.throws(() => store.renameProject(config, second.id, '默认项目'), /已存在/);
  store.renameProject(config, second.id, '项目二');

  assert.throws(() => store.assertPortFree(config, 18101), /项目「默认项目」.*「A」/, '跨项目端口冲突');
  assert.doesNotThrow(() => store.assertPortFree(config, 18101, 'p-a'), '编辑自身不算冲突');
  assert.equal(store.findProxy(config, 'p-a').project.id, first.id);

  assert.deepEqual(store.deleteProject(config, first.id), ['p-a']);
  assert.equal(config.activeProjectId, second.id);
  assert.throws(() => store.deleteProject(config, second.id), /至少需要保留/);
});

test('Mock 服务：持久化往返、跨项目端口唯一、复制顺延端口并重命名', async (t) => {
  const dir = await tempDir(t);
  const { config } = await store.loadConfig(dir, deps);
  const project = store.activeProject(config);
  project.proxies.push(validateProxy({ name: 'P', port: 18401, target: 'http://127.0.0.1:1', prefix: '/p' }, 'px'));
  const mock = validateMockService({ name: '患者 Mock', port: 18402, rules: [{ method: 'GET', path: '/a', mode: 'proxy', response: { body: '{"a":1}' } }] }, 'mk');
  project.mockServices.push(mock);
  assert.equal(mock.kind, 'mock');
  assert.equal(mock.rules[0].mode, 'mock', 'Mock 服务里的规则一律为 mock 模式');
  await store.saveConfig(dir, config);
  const back = (await store.loadConfig(dir, deps)).config;
  assert.deepEqual(back.projects[0].mockServices[0], mock);

  assert.throws(() => store.assertPortFree(config, 18402), /项目「默认项目」.*「患者 Mock」/, 'Mock 服务占用的端口代理不能再用');
  assert.equal(store.findService(config, 'mk').kind, 'mock');
  assert.equal(store.findService(config, 'px').kind, 'proxy');
  assert.equal(store.findService(config, 'none'), null);

  const copy = store.duplicateMockService(config, project, 'mk', validateMockService);
  assert.equal(copy.name, '患者 Mock 副本');
  assert.equal(copy.port, 18403);
  assert.notEqual(copy.id, 'mk');
  assert.notEqual(copy.rules[0].id, mock.rules[0].id, '规则换新 ID');
  assert.equal(copy.rules[0].response.body, '{"a":1}');
  assert.equal(copy.autoStart, false);
  assert.equal(store.duplicateMockService(config, project, 'mk', validateMockService).name, '患者 Mock 副本 2');
  assert.equal(store.nextFreePort(config, 18401), 18405);
  assert.throws(() => validateMockService({ name: '', port: 1 }), /名称/);
  assert.throws(() => validateMockService({ name: 'x', port: 0 }), /端口/);
});
