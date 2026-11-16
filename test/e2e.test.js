'use strict';

// 方案“最终端到端验收场景”的 6 个步骤，经由真实的 main.js IPC 处理器、真实的 HTTP 服务逐条验证。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { boot, backend } = require('./helpers/boot-main');
const { fakeAi } = require('./helpers/fake-ai');

const SWAGGER = JSON.stringify({
  swagger: '2.0', info: { title: '患者系统', version: '1' },
  paths: {
    '/patient/list': { get: { summary: '患者列表', responses: { 200: { schema: { type: 'object', properties: { total: { type: 'integer' }, rows: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' } } } } } } } } } },
    '/patient/{id}': { get: { summary: '患者详情', responses: { 200: { schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } } } } },
    '/patient': { post: { summary: '新增患者', responses: { 201: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } },
  },
});

test('最终端到端验收：多代理 → 报错接口切 Mock → 改数据 → 切回 → 导入 Swagger 批量生成 → AI 重新生成 → 重启恢复', async (t) => {
  const { call, userData, dialogPaths, stopAll } = await boot(t);
  const hits1 = await backend(t, 19621, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/patient/detail/1')) { res.statusCode = 500; return res.end('{"error":"后端异常"}'); }
    res.end(JSON.stringify({ from: 'backend-1', url: req.url, token: req.headers['x-token'] || null }));
  });
  const hits2 = await backend(t, 19622, (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ from: 'backend-2', url: req.url })); });
  const get = async (url) => { const r = await fetch(url); return { status: r.status, body: await r.json().catch(() => null) }; };

  // 1. 创建项目并添加两个代理，分别正常转发
  const project = await call('project:add', '联调项目');
  await call('global-headers:save', [{ name: 'X-Token', value: 'T-1', enabled: true }]);
  const p1 = await call('proxy:save', { name: '患者后台', port: 18621, target: 'http://127.0.0.1:19621', prefix: '/cgw' });
  const p2 = await call('proxy:save', { name: '订单服务', port: 18622, target: 'http://127.0.0.1:19622', prefix: '/api' });
  await call('proxy:start', p1.id);
  await call('proxy:start', p2.id);
  assert.deepEqual(await get('http://127.0.0.1:18621/cgw/patient/list'), { status: 200, body: { from: 'backend-1', url: '/patient/list', token: 'T-1' } });
  assert.equal((await get('http://127.0.0.1:18622/api/orders')).body.from, 'backend-2');
  assert.equal((await get('http://127.0.0.1:18621/cgw/patient/detail/1')).status, 500, '后端的报错接口');

  // 2. 将其中一个报错接口切到 Mock，其余接口仍正常代理
  await call('rules:save', p1.id, [{ method: 'GET', path: '/patient/detail/:id', response: { status: 200, body: '{"id":"1","name":"本地张三"}' } }]);
  const before = hits1.length;
  assert.deepEqual(await get('http://127.0.0.1:18621/cgw/patient/detail/1'), { status: 200, body: { id: '1', name: '本地张三' } });
  assert.equal(hits1.length, before, 'Mock 请求没有产生真实后端请求');
  assert.equal((await get('http://127.0.0.1:18621/cgw/patient/list')).body.from, 'backend-1');
  assert.equal((await get('http://127.0.0.1:18622/api/orders')).body.from, 'backend-2', '另一个代理不受影响');

  // 3. 修改 Mock 数据并立即获得新响应，随后切回真实代理
  const [rule] = await call('rules:get', p1.id);
  await call('rules:save', p1.id, [{ ...rule, response: { ...rule.response, body: '{"id":"1","name":"改后的数据"}' } }]);
  assert.equal((await get('http://127.0.0.1:18621/cgw/patient/detail/1')).body.name, '改后的数据');
  await call('rules:save', p1.id, [{ ...rule, mode: 'proxy' }]);
  assert.equal((await get('http://127.0.0.1:18621/cgw/patient/detail/1')).status, 500, '切回真实代理');
  await call('rules:save', p1.id, [{ ...rule, response: { ...rule.response, body: '{"id":"1","name":"改后的数据"}' } }]);

  // 4. 导入 Swagger，批量生成多个接口并保存到 Mock 服务
  await call('ai:save', { baseUrl: 'http://127.0.0.1:19623/v1', model: 'm', timeoutMs: 5000 }, 'sk-e2e');
  let regenerated = false;
  await fakeAi(t, 19623, (prompt) => {
    if (prompt.includes('GET /patient/list')) return { text: '{"total":2,"rows":[{"name":"甲","phone":"13800000001"},{"name":"乙","phone":"13800000002"}]}' };
    if (prompt.includes('GET /patient/:id')) return { text: regenerated ? '{"id":"9","name":"AI重新生成"}' : '{"id":"7","name":"AI首次"}' };
    return { text: '{"ok":true}' };
  });
  dialogPaths.open = path.join(userData, 'swagger.json');
  await fs.writeFile(dialogPaths.open, SWAGGER);
  const doc = await call('docs:import', 'openapi');
  assert.equal(doc.endpointCount, 3);
  const mock = await call('mock:save', { name: '患者 Mock', port: 18623 });
  const generated = await call('ai:generate-drafts', doc.id, ['GET /patient/list', 'GET /patient/:id', 'POST /patient'], { targetId: mock.id });
  assert.ok(generated.every((r) => r.ok), JSON.stringify(generated.filter((r) => !r.ok)));
  assert.deepEqual(await call('docs:apply', mock.id, generated.map((r) => r.draft)), { added: 3, overwritten: 0, skipped: 0 });
  await call('proxy:start', mock.id);
  assert.equal((await get('http://127.0.0.1:18623/patient/list')).body.total, 2);
  assert.equal((await get('http://127.0.0.1:18623/patient/7')).body.name, 'AI首次');
  const posted = await fetch('http://127.0.0.1:18623/patient', { method: 'POST' });
  assert.equal(posted.status, 201);

  // 5. 对单个接口使用 AI 重新生成，预览确认后生效
  regenerated = true;
  const detailRule = (await call('rules:get', mock.id)).find((r) => r.path === '/patient/:id');
  const candidate = await call('ai:regenerate', detailRule);
  assert.equal(JSON.parse(candidate.body).name, 'AI重新生成');
  assert.equal((await get('http://127.0.0.1:18623/patient/7')).body.name, 'AI首次', '预览阶段不生效');
  const rules = await call('rules:get', mock.id);
  await call('rules:save', mock.id, rules.map((r) => (r.id === detailRule.id ? { ...r, response: { ...r.response, body: candidate.body } } : r)));
  assert.equal((await get('http://127.0.0.1:18623/patient/7')).body.name, 'AI重新生成', '确认后立即生效');

  // 6. 重启应用，项目、规则、Header 和 Mock 数据完整恢复
  const snapshot = await call('state:get');
  await stopAll();
  const restarted = await boot(t, { userData });
  const state = await restarted.call('state:get');
  assert.deepEqual(state.running, [], '重启后服务处于停止状态');
  assert.equal(state.activeProjectId, project.id);
  assert.deepEqual(state.projects.map((p) => p.name), ['默认项目', '联调项目']);
  assert.deepEqual(state.globalHeaders, [{ name: 'X-Token', value: 'T-1', enabled: true }]);
  assert.deepEqual(state.proxies.map((p) => p.name), ['患者后台', '订单服务']);
  assert.deepEqual(state.proxies[0].rules, snapshot.proxies[0].rules);
  assert.deepEqual(state.mockServices, snapshot.mockServices);
  assert.equal(state.docs.length, 1);
  assert.equal((await restarted.call('ai:get')).hasKey, true);
  assert.equal((await restarted.call('ai:get')).model, 'm');

  await restarted.call('proxy:start', p1.id);
  await restarted.call('proxy:start', mock.id);
  assert.equal((await get('http://127.0.0.1:18621/cgw/patient/detail/1')).body.name, '改后的数据', '重启后 Mock 规则仍然生效');
  assert.equal((await get('http://127.0.0.1:18621/cgw/patient/list')).body.token, 'T-1', '项目 Header 仍然注入');
  assert.equal((await get('http://127.0.0.1:18623/patient/7')).body.name, 'AI重新生成');
  assert.equal(hits2.length >= 1, true);
});

test('回归：大 Body、二进制响应、敏感信息（Header 遮挡所需的原始值保留，密钥不入日志）', async (t) => {
  const { call } = await boot(t);
  const big = 'x'.repeat(1024 * 1024);
  await backend(t, 19631, (req, res) => {
    if (req.url === '/big') { res.setHeader('Content-Type', 'text/plain'); return res.end(big); }
    if (req.url === '/bin') { res.setHeader('Content-Type', 'application/octet-stream'); return res.end(Buffer.from([0, 255, 1, 2])); }
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { res.end(String(body.length)); });
  });
  const proxy = await call('proxy:save', { name: 'R', port: 18631, target: 'http://127.0.0.1:19631', prefix: '/api', headers: [{ name: 'Authorization', value: 'Bearer SECRET-TOKEN', enabled: true }] });
  await call('proxy:start', proxy.id);

  const large = await (await fetch('http://127.0.0.1:18631/api/big')).text();
  assert.equal(large.length, big.length, '1 MB 响应完整透传');
  assert.deepEqual(Buffer.from(await (await fetch('http://127.0.0.1:18631/api/bin')).arrayBuffer()), Buffer.from([0, 255, 1, 2]), '二进制响应无损');
  assert.equal(await (await fetch('http://127.0.0.1:18631/api/echo', { method: 'POST', body: 'y'.repeat(2 * 1024 * 1024) })).text(), String(2 * 1024 * 1024), '2 MB 请求体完整转发');

  await new Promise((r) => setTimeout(r, 80));
  const logs = await call('logs:get', proxy.id);
  const bigLog = logs.find((l) => l.event === 'response' && l.path === '/api/big');
  const detail = await call('trace:get', bigLog.traceId);
  assert.equal(detail.response.body.truncated, true, '超过 256 KB 的响应只保留预览');
  assert.ok(detail.response.body.body.length <= 256 * 1024);
  const binLog = logs.find((l) => l.event === 'response' && l.path === '/api/bin');
  assert.equal((await call('trace:get', binLog.traceId)).response.body.binary, true);
  assert.ok(!JSON.stringify(logs).includes('SECRET-TOKEN'), '日志文本中不含 Header 里的令牌');
  assert.throws(() => { throw new Error(JSON.stringify(logs)); }, (e) => !e.message.includes('SECRET-TOKEN'));
});
