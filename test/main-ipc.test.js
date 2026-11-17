'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { boot, backend, json, settle, proxyInput } = require('./helpers/boot-main');

test('IPC：首次启动状态、创建代理、规则保存即时生效、编辑代理不丢规则', async (t) => {
  const { call } = await boot(t);
  const hits = await backend(t, 19301, json({ from: 'backend' }));

  const state = await call('state:get');
  assert.equal(state.projects.length, 1);
  assert.deepEqual(state.proxies, []);

  const proxy = await call('proxy:save', proxyInput());
  await call('proxy:start', proxy.id);
  assert.equal((await (await fetch('http://127.0.0.1:18301/api/list')).json()).from, 'backend');

  await call('rules:save', proxy.id, [{ method: 'GET', path: '/list', response: { body: '{"from":"mock"}' } }]);
  assert.equal((await (await fetch('http://127.0.0.1:18301/api/list')).json()).from, 'mock', '运行中保存规则即时生效');
  assert.equal(hits.length, 1);

  await call('proxy:save', proxyInput({ name: 'A（改名）' }), proxy.id);
  assert.equal((await call('rules:get', proxy.id)).length, 1, '编辑代理表单后规则仍在');
  assert.equal((await call('state:get')).proxies[0].name, 'A（改名）');

  await assert.rejects(call('rules:save', proxy.id, [{ method: 'GET', path: 'x', response: { status: 1 } }]), /状态码/);
  assert.equal((await call('rules:get', proxy.id)).length, 1, '非法规则不会覆盖已有配置');
});

test('IPC：从真实响应创建 Mock（默认停用，启用后生效；重复、截断、二进制被拒绝）', async (t) => {
  const { call } = await boot(t);
  await backend(t, 19302, (req, res) => {
    if (req.url.startsWith('/big')) { res.setHeader('Content-Type', 'text/plain'); return res.end('x'.repeat(300 * 1024)); }
    if (req.url.startsWith('/bin')) { res.setHeader('Content-Type', 'application/octet-stream'); return res.end(Buffer.from([0, 1, 2, 3])); }
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Set-Cookie', 'sid=1');
    res.setHeader('X-Trace', 'abc');
    res.end(JSON.stringify({ code: 500, msg: '后端异常' }));
  });
  const proxy = await call('proxy:save', proxyInput({ port: 18302, target: 'http://127.0.0.1:19302' }));
  await call('proxy:start', proxy.id);
  const base = 'http://127.0.0.1:18302/api';
  // 发请求、读完响应体，再等到“这一次”请求的响应日志出现，返回它的 traceId。
  // 不能只等固定时间：代理在响应体传完后才写日志，慢机器（如 CI 的 Windows）上 300 KB 的响应 40ms 内写不完。
  let seq = 0;
  const requestTrace = async (path) => {
    const marker = `__trace=${seq += 1}`;
    await (await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}${marker}`)).arrayBuffer();
    for (let i = 0; i < 100; i += 1) {
      const hit = (await call('logs:get', proxy.id)).find((l) => l.event === 'response' && l.path.endsWith(marker));
      if (hit) return hit.traceId;
      await settle(20);
    }
    throw new Error(`等待 ${path} 的响应日志超时`);
  };

  const rule = await call('rules:from-trace', await requestTrace('/patient/detail/7?x=1'));
  assert.equal(rule.enabled, false);
  assert.equal(rule.path, '/patient/detail/7', '路径已去掉代理前缀和查询串');
  assert.equal(rule.method, 'GET');
  assert.equal(rule.response.status, 500);
  assert.equal(rule.response.body, '{"code":500,"msg":"后端异常"}');
  assert.equal(rule.source.type, 'trace');
  const names = rule.response.headers.map((h) => h.name.toLowerCase());
  assert.ok(names.includes('x-trace'));
  assert.ok(!names.includes('set-cookie') && !names.some((n) => n.startsWith('access-control-')));

  assert.equal((await (await fetch(`${base}/patient/detail/7`)).json()).code, 500, '停用的规则不拦截，仍走真实后端');

  const [saved] = await call('rules:get', proxy.id);
  await call('rules:save', proxy.id, [{ ...saved, enabled: true, response: { ...saved.response, status: 200, body: '{"code":0}' } }]);
  const local = await fetch(`${base}/patient/detail/7`);
  assert.equal(local.status, 200);
  assert.deepEqual(await local.json(), { code: 0 });

  await assert.rejects(call('rules:from-trace', await requestTrace('/patient/detail/7')), /只有已收到后端响应的代理请求/, 'MOCK 请求不能再转 Mock');

  await assert.rejects(call('rules:from-trace', await requestTrace('/big')), /256 KB/);
  await assert.rejects(call('rules:from-trace', await requestTrace('/bin')), /二进制/);
  await call('rules:save', proxy.id, []);
  const first = await requestTrace('/patient/detail/8');
  assert.equal((await call('rules:from-trace', first)).addedAsScenario, false);
  const again = await call('rules:from-trace', first);
  assert.equal(again.addedAsScenario, true, '同一接口已有规则时，真实响应追加为新场景而不是报错');
  await call('rules:from-trace', first);
  const [only] = await call('rules:get', proxy.id);
  assert.equal((await call('rules:get', proxy.id)).length, 1, '仍然只有一条规则');
  assert.equal(only.scenario.name, '默认', '追加的场景不会自动启用');
  assert.equal(only.alternatives.length, 2);
  assert.ok(only.alternatives.every((a) => a.name.startsWith('真实响应')));
  assert.equal(new Set(only.alternatives.map((a) => a.name)).size, 2, '场景名称自动去重');

  const detail = await call('trace:get', first);
  assert.equal(detail.source, 'PROXY');
});

test('IPC：多项目隔离——端口全局唯一、公共 Header 各自独立、删除项目清理服务与日志', async (t) => {
  const { call, userData } = await boot(t);
  const seen = await backend(t, 19303, (req, res) => res.end(JSON.stringify(req.headers['x-project'] || null)));

  const proxyA = await call('proxy:save', proxyInput({ port: 18303, target: 'http://127.0.0.1:19303' }));
  await call('global-headers:save', [{ name: 'X-Project', value: 'A', enabled: true }]);
  await call('proxy:start', proxyA.id);
  assert.equal(await (await fetch('http://127.0.0.1:18303/api/x')).json(), 'A');

  const second = await call('project:add', '项目二');
  const stateB = await call('state:get');
  assert.equal(stateB.activeProjectId, second.id);
  assert.deepEqual(stateB.proxies, [], '切到新项目后看不到 A 的代理');
  assert.deepEqual(stateB.globalHeaders, []);
  assert.equal(stateB.running.length, 1, '切换项目不会停掉其他项目正在运行的代理');
  await assert.rejects(call('proxy:save', proxyInput({ name: 'B', port: 18303 })), /项目「默认项目」.*「A」/);
  const proxyB = await call('proxy:save', proxyInput({ name: 'B', port: 18304, target: 'http://127.0.0.1:19303', prefix: '/b' }));
  await call('global-headers:save', [{ name: 'X-Project', value: 'B', enabled: true }]);
  await call('proxy:start', proxyB.id);
  assert.equal(await (await fetch('http://127.0.0.1:18304/b/x')).json(), 'B');
  assert.equal(await (await fetch('http://127.0.0.1:18303/api/x')).json(), 'A', 'A 项目 Header 不受 B 影响');

  const disk = JSON.parse(await fs.readFile(path.join(userData, 'relay-config.json'), 'utf8'));
  assert.equal(disk.schemaVersion, 2);
  assert.deepEqual(disk.projects.map((p) => p.name), ['默认项目', '项目二']);

  await settle();
  const first = (await call('state:get')).projects[0];
  await call('project:select', first.id);
  await call('project:delete', second.id);
  await assert.rejects(fetch('http://127.0.0.1:18304/b/x'), '删除项目会停止其下的服务');
  assert.deepEqual(await call('logs:get', proxyB.id), [], '并清理其日志');
  assert.equal((await call('state:get')).projects.length, 1);
  await assert.rejects(call('project:delete', first.id), /至少需要保留/);
  assert.equal(seen.length, 3, 'A、B、A 三次请求到达后端，删除项目后不再有请求');
});

test('IPC：动态数据——预览不落盘、非法模板保存时被拒绝、保存后运行中即时生效', async (t) => {
  const { call } = await boot(t);
  await backend(t, 19304, json({ from: 'backend' }));
  const proxy = await call('proxy:save', proxyInput({ port: 18305, target: 'http://127.0.0.1:19304' }));
  await call('proxy:start', proxy.id);

  const draft = { method: 'GET', path: '/patient/detail/:id', response: { dynamic: true, body: '{"id":"{{params.id}}","age":"{{int 18 80}}"}' } };
  const preview = JSON.parse(await call('rules:preview', draft));
  assert.equal(preview.id, 'id-示例');
  assert.equal(typeof preview.age, 'number');
  assert.deepEqual(await call('rules:get', proxy.id), [], '预览不会保存规则');
  assert.equal(await call('rules:preview', { ...draft, response: { body: '{{x}}' } }), '{{x}}', '未开启动态时原样返回');
  await assert.rejects(call('rules:preview', { ...draft, response: { dynamic: true, body: '{"a":"{{nope}}"}' } }), /未知占位符/);
  await assert.rejects(call('rules:save', proxy.id, [{ ...draft, response: { dynamic: true, body: '{"a":"{{int 9 1}}"}' } }]), /最小值不大于最大值/);
  assert.deepEqual(await call('rules:get', proxy.id), [], '非法模板不会被保存');

  await call('rules:save', proxy.id, [draft]);
  const a = await (await fetch('http://127.0.0.1:18305/api/patient/detail/7')).json();
  const b = await (await fetch('http://127.0.0.1:18305/api/patient/detail/8')).json();
  assert.deepEqual([a.id, b.id], ['7', '8']);
});

test('IPC：独立 Mock 服务——创建、启停、规则、复制、端口冲突、编辑不丢规则、删除', async (t) => {
  const { call } = await boot(t);
  const proxy = await call('proxy:save', proxyInput({ port: 18306, target: 'http://127.0.0.1:19305' }));
  const svc = await call('mock:save', { name: '离线 Mock', port: 18307, autoStart: false });
  assert.equal(svc.kind, 'mock');
  assert.deepEqual((await call('state:get')).mockServices.map((m) => m.name), ['离线 Mock']);
  await assert.rejects(call('mock:save', { name: 'X', port: 18306 }), /已被项目「默认项目」的「A」使用/, 'Mock 服务不能占用代理的端口');
  await assert.rejects(call('proxy:save', proxyInput({ name: 'B', port: 18307 })), /「离线 Mock」/, '代理不能占用 Mock 服务的端口');

  await call('rules:save', svc.id, [{ method: 'GET', path: '/hello/:name', mode: 'proxy', response: { dynamic: true, body: '{"hi":"{{params.name}}"}' } }]);
  assert.equal((await call('rules:get', svc.id))[0].mode, 'mock', 'Mock 服务里的规则强制为 mock 模式');
  await call('proxy:start', svc.id); // 启停接口与代理共用
  assert.ok((await call('state:get')).running.includes(svc.id));
  assert.deepEqual(await (await fetch('http://127.0.0.1:18307/hello/world')).json(), { hi: 'world' });

  await call('rules:save', svc.id, [{ method: 'GET', path: '/hello/:name', response: { body: '"v2"' } }]);
  assert.equal(await (await fetch('http://127.0.0.1:18307/hello/x')).json(), 'v2', '运行中保存规则即时生效');

  await call('mock:save', { name: '离线 Mock（改名）', port: 18307 }, svc.id);
  assert.equal((await call('rules:get', svc.id)).length, 1, '编辑 Mock 服务后规则仍在');
  assert.equal((await call('state:get')).mockServices[0].name, '离线 Mock（改名）');

  const copy = await call('mock:duplicate', svc.id);
  assert.equal(copy.port, 18308);
  assert.equal((await call('rules:get', copy.id)).length, 1);
  await assert.rejects(call('proxy:delete', svc.id), /这不是代理/);
  await assert.rejects(call('mock:delete', proxy.id), /这不是 Mock 服务/);

  await call('mock:delete', svc.id);
  await assert.rejects(fetch('http://127.0.0.1:18307/hello/x'), '删除会先停止服务');
  assert.deepEqual((await call('state:get')).mockServices.map((m) => m.id), [copy.id]);
  assert.deepEqual(await call('logs:get', svc.id), [], '并清理其日志');
});

test('IPC：Mock 配置导出 / 导入（取消对话框、导出文件无敏感信息、导入后即可运行）', async (t) => {
  const { call, dialogPaths, userData } = await boot(t);
  assert.equal(await call('mock:export'), null, '用户取消导出');
  assert.equal(await call('mock:import'), null, '用户取消导入');

  const proxy = await call('proxy:save', proxyInput({ port: 18309, target: 'http://secret-host:8106', headers: [{ name: 'Authorization', value: 'Bearer SECRET', enabled: true }] }));
  await call('rules:save', proxy.id, [{ method: 'GET', path: '/p/:id', response: { body: '{"id":"{{params.id}}"}', dynamic: true } }]);
  const svc = await call('mock:save', { name: '导出用', port: 18310 });
  await call('rules:save', svc.id, [{ method: 'POST', path: '/create', response: { status: 201, body: '{"姓名":"张三"}' } }]);

  dialogPaths.save = path.join(userData, 'export.json');
  const summary = await call('mock:export');
  assert.deepEqual({ mockServices: summary.mockServices, proxyRules: summary.proxyRules }, { mockServices: 1, proxyRules: 1 });
  const text = await fs.readFile(dialogPaths.save, 'utf8');
  assert.ok(!text.includes('SECRET') && !text.includes('secret-host'));

  const second = await call('project:add', '项目二');
  const target = await call('proxy:save', proxyInput({ port: 18311, target: 'http://127.0.0.1:19305' }));
  dialogPaths.open = dialogPaths.save;
  const report = await call('mock:import');
  assert.equal(report.services, 1);
  assert.equal(report.rulesAdded, 1, '代理规则按“名称 + 前缀”匹配到同名代理');
  const state = await call('state:get');
  assert.equal(state.activeProjectId, second.id);
  assert.notEqual(state.mockServices[0].port, 18310, '端口已被项目一占用，自动顺延');
  assert.equal(state.proxies[0].rules.length, 1);

  await call('proxy:start', state.mockServices[0].id);
  const created = await fetch(`http://127.0.0.1:${state.mockServices[0].port}/create`, { method: 'POST' });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { 姓名: '张三' });

  dialogPaths.open = path.join(userData, 'bad.json');
  await fs.writeFile(dialogPaths.open, '{ not json');
  await assert.rejects(call('mock:import'), /不是有效的 JSON/);
  await fs.writeFile(dialogPaths.open, JSON.stringify({ hello: 1 }));
  await assert.rejects(call('mock:import'), /不是 Relay 导出的/);
  const after = await call('state:get');
  assert.equal(after.mockServices.length, 1, '导入失败不会新增或改动任何内容');
  assert.equal(after.proxies[0].rules.length, 1);
  assert.equal(target.id, after.proxies[0].id);
});

test('IPC：Mock 场景——保存多个场景、一键切换即时生效、重启后保留、非法场景不覆盖', async (t) => {
  const { call, userData, stopAll } = await boot(t);
  const proxy = await call('proxy:save', proxyInput({ port: 18320, target: 'http://127.0.0.1:19320' }));
  await call('proxy:start', proxy.id);
  const fetchJson = async () => { const r = await fetch('http://127.0.0.1:18320/api/patient/list'); return { status: r.status, body: await r.json() }; };

  await call('rules:save', proxy.id, [{
    method: 'GET', path: '/patient/list', scenario: { name: '成功' }, response: { status: 200, body: '{"code":0,"rows":[1,2]}' },
    alternatives: [
      { name: '服务器报错', response: { status: 500, body: '{"code":500,"msg":"boom"}' } },
      { name: '空列表', response: { status: 200, body: '{"code":0,"rows":[]}' } },
      { name: '慢响应', response: { status: 200, body: '{"code":0,"rows":[1]}', delayMs: 200 } },
    ],
  }]);
  const [rule] = await call('rules:get', proxy.id);
  const byName = (name) => rule.alternatives.find((a) => a.name === name).id;
  assert.deepEqual(await fetchJson(), { status: 200, body: { code: 0, rows: [1, 2] } });

  const switched = await call('rules:switch', proxy.id, rule.id, byName('服务器报错'));
  assert.equal(switched.scenario.name, '服务器报错');
  assert.deepEqual(await fetchJson(), { status: 500, body: { code: 500, msg: 'boom' } }, '切换后立即生效，无需重启');
  await call('rules:switch', proxy.id, rule.id, byName('空列表'));
  assert.deepEqual((await fetchJson()).body.rows, []);
  const t0 = Date.now();
  await call('rules:switch', proxy.id, rule.id, byName('慢响应'));
  await fetchJson();
  assert.ok(Date.now() - t0 >= 190, '场景自带的延迟生效');

  await settleLogs();
  const logs = await call('logs:get', proxy.id);
  assert.match(logs.filter((l) => l.event === 'request').at(-1).message, /场景「慢响应」/, '日志标出命中的场景');
  const detail = await call('trace:get', logs.filter((l) => l.event === 'response').at(-1).traceId);
  assert.equal(detail.scenario, '慢响应');

  const [now] = await call('rules:get', proxy.id);
  assert.equal(now.alternatives.length, 3, '切换只是互换，场景一个都没少');
  assert.deepEqual([now.scenario.name, ...now.alternatives.map((a) => a.name)].sort(), ['成功', '慢响应', '服务器报错', '空列表'].sort());
  await assert.rejects(call('rules:switch', proxy.id, rule.id, 'nope'), /找不到此 Mock 场景/);
  await assert.rejects(call('rules:switch', proxy.id, 'nope', 'x'), /找不到此接口规则/);
  await assert.rejects(call('rules:save', proxy.id, [{ ...now, alternatives: [...now.alternatives, { name: '成功', response: {} }] }]), /场景名称「成功」重复/ , '名称与当前场景重复');
  assert.equal((await call('rules:get', proxy.id))[0].alternatives.length, 3, '非法保存不会覆盖已有配置');

  await stopAll();
  const restarted = await boot(t, { userData });
  const [persisted] = await restarted.call('rules:get', proxy.id);
  assert.equal(persisted.scenario.name, '慢响应', '重启后启用的场景保持不变');
  assert.equal(persisted.alternatives.length, 3);
});

async function settleLogs() { await new Promise((r) => setTimeout(r, 60)); }

test('IPC：多环境保存、切换（运行中即时生效并持久化）、编辑保留环境、非法输入被拒绝', async (t) => {
  const { call } = await boot(t);
  const hitsA = await backend(t, 19330, json({ env: 'A' }));
  const hitsB = await backend(t, 19331, json({ env: 'B' }));
  const environments = [{ name: '测试', target: 'http://127.0.0.1:19330' }, { name: '预发', target: 'http://127.0.0.1:19331' }];
  const proxy = await call('proxy:save', proxyInput({ port: 18330, target: '', environments, activeEnv: '测试' }));
  assert.equal(proxy.target, 'http://127.0.0.1:19330');
  await call('proxy:start', proxy.id);
  const ask = async () => (await (await fetch('http://127.0.0.1:18330/api/list')).json()).env;
  assert.equal(await ask(), 'A');

  const switched = await call('proxy:switch-env', proxy.id, '预发');
  assert.equal(switched.target, 'http://127.0.0.1:19331');
  assert.equal(await ask(), 'B', '运行中切换即时生效');
  assert.deepEqual([hitsA.length, hitsB.length], [1, 1]);
  const state = await call('state:get');
  assert.deepEqual([state.proxies[0].activeEnv, state.proxies[0].target], ['预发', 'http://127.0.0.1:19331']);

  await call('rules:save', proxy.id, [{ method: 'GET', path: '/m', response: { body: '{"ok":1}' } }]);
  const edited = await call('proxy:save', proxyInput({ port: 18330, name: '改名', target: '', environments, activeEnv: '预发' }), proxy.id);
  assert.equal(edited.activeEnv, '预发');
  assert.equal((await call('rules:get', proxy.id)).length, 1, '编辑代理不丢规则');

  await assert.rejects(call('proxy:switch-env', proxy.id, '不存在'), /找不到环境/);
  await assert.rejects(call('proxy:switch-env', 'nope', '测试'), /找不到此代理/);
  await assert.rejects(call('proxy:save', proxyInput({ port: 18331, environments: [{ name: 'X', target: 'bad' }] })), /环境「X」/);

  // 清空环境后回到单地址模式
  const single = await call('proxy:save', proxyInput({ port: 18330, target: 'http://127.0.0.1:19330', environments: [] }), proxy.id);
  assert.deepEqual([single.environments, single.activeEnv], [[], null]);
});

test('IPC：接口调试对所选环境发真实请求，自动带代理 Header，代理不必运行', async (t) => {
  const { call } = await boot(t);
  const seen = { a: [], b: [] };
  for (const [key, port] of [['a', 19350], ['b', 19351]]) {
    await backend(t, port, (req, res) => { seen[key].push({ url: req.url, auth: req.headers.authorization, mine: req.headers['x-mine'] }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ env: key })); });
  }
  const environments = [{ name: '测试', target: 'http://127.0.0.1:19350' }, { name: '本地', target: 'http://127.0.0.1:19351' }];
  const proxy = await call('proxy:save', proxyInput({ port: 18350, target: '', environments, activeEnv: '测试', headers: [{ name: 'Authorization', value: 'Bearer P', enabled: true }] }));
  await call('rules:save', proxy.id, [{ method: 'GET', path: '/item/:id', response: { body: '{"from":"mock"}' } }]); // 即使接口被 Mock，调试也拿到后端的真实数据

  const input = { method: 'GET', path: '/item/5', query: [{ name: 'v', value: '1' }], headers: [{ name: 'X-Mine', value: 'm', enabled: true }], useProxyHeaders: true };
  const a = await call('debug:send', proxy.id, { ...input, env: '测试' });
  assert.deepEqual([a.error, JSON.parse(a.response.body)], [null, { env: 'a' }]);
  assert.deepEqual(seen.a, [{ url: '/item/5?v=1', auth: 'Bearer P', mine: 'm' }], '代理 Header 与调试 Header 都带上了');
  const b = await call('debug:send', proxy.id, { ...input, env: '本地', useProxyHeaders: false });
  assert.deepEqual(JSON.parse(b.response.body), { env: 'b' });
  assert.equal(seen.b[0].auth, undefined, '关闭「附带代理 Header」后不带 Token');

  const logs = await call('logs:get', proxy.id);
  assert.ok(logs.some((l) => l.message.includes('[调试]') && l.message.includes('→ 200') && l.message.includes('环境：本地')));
  const down = await call('debug:send', proxy.id, { method: 'GET', path: '/x', env: '测试', useProxyHeaders: true });
  assert.equal(down.error, null);

  await assert.rejects(call('debug:send', proxy.id, { method: 'GET', path: 'x' }), /以 \/ 开头/);
  const mock = await call('mock:save', { name: 'M', port: 18351 });
  await assert.rejects(call('debug:send', mock.id, { path: '/x' }), /不需要调试/);
  await assert.rejects(call('debug:send', 'nope', { path: '/x' }), /找不到/);
});
