'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ProxyManager, validateProxy, validateMockService } = require('../src/proxy-manager');

async function setup(t, { backendPort, proxyPort, rules = [], proxy = {} }) {
  const hits = [];
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ from: 'backend', url: req.url, body }));
    });
  });
  await new Promise((r) => backend.listen(backendPort, '127.0.0.1', r));
  t.after(() => backend.close());

  const logs = [];
  const traces = new Map();
  const manager = new ProxyManager((l) => logs.push(l), () => {}, (tr) => traces.set(tr.id, tr));
  const config = validateProxy({ name: 'M', port: proxyPort, target: `http://127.0.0.1:${backendPort}`, prefix: '/api', rules, ...proxy }, 'm1');
  await manager.start(config);
  t.after(() => manager.stopAll());
  return { hits, logs, traces, manager, base: `http://127.0.0.1:${proxyPort}/api` };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test('手动 Mock：命中接口本地返回且不请求后端，其余接口照常代理', async (t) => {
  const { hits, logs, traces, base } = await setup(t, {
    backendPort: 19201, proxyPort: 18201,
    rules: [
      { method: 'GET', path: '/patient/detail/:id', response: { status: 200, headers: [{ name: 'X-Mock', value: 'yes' }], body: '{"姓名":"张三","编号":"本地"}' } },
      { method: 'POST', path: '/patient/create', response: { status: 201, body: '{"ok":true}' } },
    ],
  });

  const mocked = await fetch(`${base}/patient/detail/42?lang=zh`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(mocked.status, 200);
  assert.equal(mocked.headers.get('x-mock'), 'yes');
  assert.equal(mocked.headers.get('access-control-allow-origin'), 'http://localhost:5173', 'Mock 响应同样带 CORS（回显 Origin）');
  assert.match(mocked.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await mocked.json(), { 姓名: '张三', 编号: '本地' });

  const created = await fetch(`${base}/patient/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ 姓名: '李四' }) });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { ok: true });
  assert.deepEqual(hits, [], 'Mock 请求不产生任何真实后端请求');

  const proxied = await (await fetch(`${base}/patient/list?page=1`)).json();
  assert.equal(proxied.from, 'backend');
  assert.equal(proxied.url, '/patient/list?page=1');
  const wrongMethod = await (await fetch(`${base}/patient/detail/42`, { method: 'DELETE' })).json();
  assert.equal(wrongMethod.from, 'backend', 'Method 不同则不命中');
  assert.deepEqual(hits, ['GET /patient/list?page=1', 'DELETE /patient/detail/42']);

  await settle();
  const responses = logs.filter((l) => l.event === 'response');
  assert.deepEqual(responses.map((l) => l.source), ['MOCK', 'MOCK', 'PROXY', 'PROXY']);
  assert.match(responses[0].message, /^\[MOCK\] GET \/api\/patient\/detail\/42\?lang=zh → 200/);
  assert.match(responses[2].message, /^\[PROXY\] /);
  const mockTrace = traces.get(responses[0].traceId);
  assert.equal(mockTrace.source, 'MOCK');
  assert.equal(mockTrace.response.status, 200);
  assert.match(mockTrace.response.body.body, /张三/);
  assert.equal(mockTrace.request.targetUrl, undefined);
  assert.equal(traces.get(responses[2].traceId).source, 'PROXY');
});

test('规则即时生效：不重启即可切换 Mock / 代理 / 修改内容 / 禁用', async (t) => {
  const { hits, manager, base } = await setup(t, { backendPort: 19202, proxyPort: 18202 });
  const rule = (over = {}) => validateProxy({ name: 'x', port: 1, target: 'http://127.0.0.1:1', prefix: '/p', rules: [{ method: 'GET', path: '/a', ...over }] }).rules;

  assert.equal((await (await fetch(`${base}/a`)).json()).from, 'backend');
  manager.setRules('m1', rule({ response: { body: '{"v":1}' } }));
  assert.deepEqual(await (await fetch(`${base}/a`)).json(), { v: 1 });
  manager.setRules('m1', rule({ response: { body: '{"v":2}' } }));
  assert.deepEqual(await (await fetch(`${base}/a`)).json(), { v: 2 }, '修改 Mock 数据立即生效');
  manager.setRules('m1', rule({ mode: 'proxy', response: { body: '{"v":3}' } }));
  assert.equal((await (await fetch(`${base}/a`)).json()).from, 'backend', '切回代理');
  manager.setRules('m1', rule({ enabled: false }));
  assert.equal((await (await fetch(`${base}/a`)).json()).from, 'backend', '禁用规则等同未配置');
  manager.setRules('m1', rule({ response: { body: '{"v":4}' } }));
  assert.deepEqual(await (await fetch(`${base}/a`)).json(), { v: 4 }, '反复切换仍然生效');
  assert.equal(hits.length, 3, '只有代理态的 3 次请求到达后端');
});

test('优先级：显式“代理”规则可在通配 Mock 中“挖洞”；stripPrefix=false 时规则同样按去前缀路径匹配', async (t) => {
  const { hits, base } = await setup(t, {
    backendPort: 19203, proxyPort: 18203, proxy: { stripPrefix: false },
    rules: [
      { method: 'ANY', path: '/svc/*', response: { body: '"mocked"' } },
      { method: 'GET', path: '/svc/health', mode: 'proxy' },
    ],
  });
  assert.equal(await (await fetch(`${base}/svc/anything/deep`, { method: 'PUT' })).json(), 'mocked');
  const health = await (await fetch(`${base}/svc/health`)).json();
  assert.equal(health.from, 'backend');
  assert.equal(health.url, '/api/svc/health', 'stripPrefix=false 时转发路径保留前缀');
  assert.deepEqual(hits, ['GET /api/svc/health']);
});

test('Mock 响应：延迟、二进制 Base64、忽略 content-encoding / content-length、纯文本类型', async (t) => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  const { traces, logs, base } = await setup(t, {
    backendPort: 19204, proxyPort: 18204,
    rules: [
      { method: 'GET', path: '/slow', response: { body: 'ok', delayMs: 150 } },
      { method: 'GET', path: '/img', response: { body: png.toString('base64'), bodyEncoding: 'base64', headers: [{ name: 'Content-Type', value: 'image/png' }, { name: 'Content-Encoding', value: 'gzip' }] } },
      { method: 'GET', path: '/text', response: { body: '你好，世界' } },
      { method: 'GET', path: '/err', response: { status: 500, body: '{"error":"boom"}' } },
    ],
  });
  const t0 = Date.now();
  const slow = await fetch(`${base}/slow`);
  assert.ok(Date.now() - t0 >= 140, '延迟生效');
  assert.equal(await slow.text(), 'ok');
  assert.match(slow.headers.get('content-type'), /text\/plain/);

  const img = await fetch(`${base}/img`);
  assert.equal(img.headers.get('content-encoding'), null);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);

  assert.equal(await (await fetch(`${base}/text`)).text(), '你好，世界');
  const err = await fetch(`${base}/err`);
  assert.equal(err.status, 500);

  await settle();
  const imgLog = logs.find((l) => l.event === 'response' && l.path.endsWith('/img'));
  assert.equal(traces.get(imgLog.traceId).response.body.binary, true);
  assert.equal(logs.find((l) => l.event === 'response' && l.path.endsWith('/err')).level, 'error');
});

test('Mock 与 CORS 预检、前缀外请求：预检由代理直接响应，前缀外仍然 404', async (t) => {
  const { hits, base } = await setup(t, { backendPort: 19205, proxyPort: 18205, rules: [{ method: 'POST', path: '/x', response: { body: '{}' } }] });
  const pre = await fetch(`${base}/x`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'X-Custom' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-headers'), 'X-Custom');
  assert.equal((await fetch('http://127.0.0.1:18205/x', { method: 'POST' })).status, 404);
  assert.deepEqual(hits, []);
});

test('延迟中的 Mock 响应在服务停止时被取消，不遗留定时器', async (t) => {
  const { manager, base } = await setup(t, { backendPort: 19206, proxyPort: 18206, rules: [{ method: 'GET', path: '/hang', response: { body: 'late', delayMs: 5000 } }] });
  const pending = fetch(`${base}/hang`).then(() => 'responded', () => 'aborted');
  await new Promise((r) => setTimeout(r, 80));
  const t0 = Date.now();
  await manager.stop('m1');
  assert.ok(Date.now() - t0 < 1000, '停止不应被 5 秒延迟拖住');
  assert.equal(await pending, 'aborted');
});

test('项目 Header 按项目隔离：不同项目的代理拿到各自的公共 Header', async (t) => {
  const seen = [];
  const backend = http.createServer((req, res) => { seen.push(req.headers['x-project']); res.end('{}'); });
  await new Promise((r) => backend.listen(19207, '127.0.0.1', r));
  t.after(() => backend.close());
  const manager = new ProxyManager(() => {}, () => {});
  manager.setProjectHeaders('proj-a', [{ name: 'X-Project', value: 'A', enabled: true }]);
  manager.setProjectHeaders('proj-b', [{ name: 'X-Project', value: 'B', enabled: true }]);
  const mk = (id, port, projectId) => ({ ...validateProxy({ name: id, port, target: 'http://127.0.0.1:19207', prefix: '/api' }, id), projectId });
  await manager.start(mk('a', 18207, 'proj-a'));
  await manager.start(mk('b', 18208, 'proj-b'));
  t.after(() => manager.stopAll());
  await fetch('http://127.0.0.1:18207/api/x');
  await fetch('http://127.0.0.1:18208/api/x');
  assert.deepEqual(seen, ['A', 'B']);
  manager.setProjectHeaders('proj-a', [{ name: 'X-Project', value: 'A2', enabled: true }]);
  await fetch('http://127.0.0.1:18207/api/x');
  assert.equal(seen[2], 'A2', '项目 Header 保存后无需重启');
});

test('动态数据：开启后每次请求渲染出不同数据，回显路径参数和查询参数；关闭时原样返回', async (t) => {
  const { hits, manager, base } = await setup(t, {
    backendPort: 19208, proxyPort: 18209,
    rules: [
      { method: 'GET', path: '/patient/detail/:id', response: { dynamic: true, body: JSON.stringify({ id: '{{params.id}}', page: '{{query.page}}', name: '{{name}}', age: '{{int 18 80}}', no: '{{seq}}' }) } },
      { method: 'GET', path: '/patient/list', response: { dynamic: true, body: JSON.stringify({ total: '{{int 1 99999}}', rows: ['{{repeat 1 8}}', { id: '{{uuid}}', name: '{{name}}' }] }) } },
      { method: 'GET', path: '/literal', response: { body: '{"tpl":"{{name}}"}' } },
    ],
  });
  const first = await (await fetch(`${base}/patient/detail/42?page=3`)).json();
  const second = await (await fetch(`${base}/patient/detail/42?page=3`)).json();
  assert.equal(first.id, '42');
  assert.equal(first.page, '3');
  assert.equal(typeof first.age, 'number');
  assert.deepEqual([first.no, second.no], [1, 2]);

  const lists = [];
  for (let i = 0; i < 12; i += 1) lists.push(await (await fetch(`${base}/patient/list`)).json());
  assert.ok(new Set(lists.map((l) => l.total)).size > 1, 'total 每次不同');
  assert.ok(new Set(lists.map((l) => l.rows.length)).size > 1, '条数每次不同');
  assert.ok(lists.every((l) => l.rows.length >= 1 && l.rows.length <= 8));
  assert.ok(new Set(lists.flatMap((l) => l.rows.map((r) => r.id))).size > lists.length, 'uuid 不重复');

  assert.deepEqual(await (await fetch(`${base}/literal`)).json(), { tpl: '{{name}}' }, '未开启动态时原样返回');
  assert.deepEqual(hits, [], '全部由本地渲染，没有请求后端');
  assert.match((await fetch(`${base}/patient/list`)).headers.get('content-type'), /application\/json/);
});

test('独立 Mock 服务：无后端也能运行，未命中返回 404，CORS / 日志 / 详情 / 动态数据齐全', async (t) => {
  const logs = [];
  const traces = new Map();
  const manager = new ProxyManager((l) => logs.push(l), () => {}, (tr) => traces.set(tr.id, tr));
  const service = validateMockService({
    name: '离线 Mock', port: 18210,
    rules: [
      { method: 'GET', path: '/patient/detail/:id', response: { dynamic: true, body: '{"id":"{{params.id}}","name":"{{name}}"}' } },
      { method: 'POST', path: '/patient/create', response: { status: 201, body: '{"姓名":"张三"}', headers: [{ name: 'X-Mock', value: 'svc' }] } },
    ],
  }, 'svc1');
  await manager.start(service);
  t.after(() => manager.stopAll());
  const base = 'http://127.0.0.1:18210';

  const detail = await (await fetch(`${base}/patient/detail/7`)).json();
  assert.equal(detail.id, '7');
  const created = await fetch(`${base}/patient/create`, { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('x-mock'), 'svc');
  assert.equal(created.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.deepEqual(await created.json(), { 姓名: '张三' });

  const missing = await fetch(`${base}/nothing?x=1`);
  assert.equal(missing.status, 404);
  const missBody = await missing.json();
  assert.deepEqual({ ...missBody, hint: undefined }, { error: '没有匹配的 Mock 接口', method: 'GET', path: '/nothing', hint: undefined });
  assert.match(missBody.hint, /没有规则匹配「GET \/nothing」/);
  const pre = await fetch(`${base}/patient/create`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'X-Custom' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-headers'), 'X-Custom');

  await settle();
  assert.ok(logs.some((l) => l.event === 'system' && l.message.startsWith('Mock 服务已启动')));
  const posted = logs.find((l) => l.event === 'response' && l.path === '/patient/create');
  assert.equal(posted.source, 'MOCK');
  const trace = traces.get(posted.traceId);
  assert.equal(trace.source, 'MOCK');
  assert.match(trace.request.body.body, /"a":1/, '请求体可在详情中查看');
  assert.equal(trace.response.status, 201);

  manager.setRules('svc1', []);
  assert.equal((await fetch(`${base}/patient/detail/7`)).status, 404, '清空规则即时生效');
  await manager.stop('svc1');
  await assert.rejects(fetch(`${base}/patient/detail/7`));
  assert.ok(logs.some((l) => l.message.startsWith('Mock 服务已停止')));
});

test('独立 Mock 与代理内 Mock 行为一致，且多个服务可以与代理同时运行', async (t) => {
  const rules = [
    { method: 'GET', path: '/patient/detail/:id', response: { status: 200, headers: [{ name: 'X-From', value: 'rule' }], body: '{"id":"{{params.id}}","中文":"本地"}', dynamic: true } },
    { method: 'ANY', path: '/files/*', response: { status: 202, body: 'files' } },
    { method: 'GET', path: '/files/special', response: { status: 200, body: 'special' } },
    { method: 'GET', path: '/err', response: { status: 500, body: '{"error":"boom"}' } },
  ];
  const { base: proxyBase, manager } = await setup(t, { backendPort: 19209, proxyPort: 18211, rules });
  await manager.start(validateMockService({ name: 'S1', port: 18212, rules }, 's1'));
  await manager.start(validateMockService({ name: 'S2', port: 18213, rules: [{ method: 'GET', path: '/only', response: { body: 'two' } }] }, 's2'));
  assert.deepEqual(manager.status().sort(), ['m1', 's1', 's2']);

  const snapshot = async (base, method, path) => {
    const res = await fetch(`${base}${path}`, { method });
    return { status: res.status, from: res.headers.get('x-from'), body: await res.text() };
  };
  const cases = [['GET', '/patient/detail/9?x=1'], ['GET', '/files/special'], ['PUT', '/files/a/b'], ['GET', '/err'], ['GET', '/patient/detail/vip']];
  for (const [method, path] of cases) {
    assert.deepEqual(await snapshot('http://127.0.0.1:18212', method, path), await snapshot(proxyBase, method, path), `${method} ${path}`);
  }
  assert.equal(await (await fetch('http://127.0.0.1:18213/only')).text(), 'two');
  assert.equal((await fetch('http://127.0.0.1:18212/only')).status, 404, '服务之间的规则互相独立');
});

test('没走 Mock 时说明原因：日志、请求详情、后端不可达的报错里都带上（用户遇到的 ECONNREFUSED 场景）', async (t) => {
  const logs = [];
  const traces = new Map();
  const manager = new ProxyManager((l) => logs.push(l), () => {}, (tr) => traces.set(tr.id, tr));
  // 后端地址不可达，规则故意写错（带了代理前缀）：请求会被转发并失败
  const config = validateProxy({
    name: 'X', port: 18215, target: 'http://127.0.0.1:19999', prefix: '/cgw/aiadmin',
    rules: [
      { method: 'GET', path: '/cgw/aiadmin/user/list', response: { body: '{"ok":1}' } },
      { method: 'GET', path: '/order/list', enabled: false, response: { body: '{}' } },
      { method: 'GET', path: '/health', mode: 'proxy', response: { body: '{}' } },
    ],
  }, 'x1');
  await manager.start(config);
  t.after(() => manager.stopAll());
  const base = 'http://127.0.0.1:18215/cgw/aiadmin';

  const failed = await fetch(`${base}/user/list?page=1`);
  assert.equal(failed.status, 502);
  const body = await failed.json();
  assert.match(body.message, /ECONNREFUSED/);
  assert.match(body.hint, /该请求没有走 Mock：规则路径「\/cgw\/aiadmin\/user\/list」带了代理前缀，应写成「\/user\/list」/);

  await fetch(`${base}/order/list`);
  await fetch(`${base}/health`);
  await fetch(`${base}/nothing`);
  await settle();

  const errors = logs.filter((l) => l.event === 'error');
  assert.match(errors[0].message, /ECONNREFUSED.*没有走 Mock（规则路径/);
  const requests = logs.filter((l) => l.event === 'request');
  assert.equal(requests[0].level, 'warn', '未走 Mock 的请求在日志里以警告级别突出显示');
  assert.match(requests[1].message, /未走 Mock：规则「GET \/order\/list」已停用/);
  assert.match(requests[2].message, /未走 Mock：命中规则「GET \/health」，但它的当前模式是「代理」/);
  assert.match(requests[3].message, /没有规则匹配「GET \/nothing」/);
  const trace = traces.get(requests[1].traceId);
  assert.match(trace.missReason, /已停用/);
  assert.equal(trace.source, 'PROXY');

  // 对照：规则正确时命中 Mock，不产生任何“未走 Mock”提示
  manager.setRules('x1', [{ ...validateProxy({ name: 'y', port: 1, target: 'http://127.0.0.1:1', prefix: '/p', rules: [{ method: 'GET', path: '/user/list', response: { body: '{"ok":1}' } }] }).rules[0] }]);
  assert.deepEqual(await (await fetch(`${base}/user/list?page=1`)).json(), { ok: 1 });
  await settle();
  assert.ok(!logs.filter((l) => l.event === 'response').at(-1).message.includes('未走 Mock'));
});
