'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { boot, backend, json, settle, proxyInput } = require('./helpers/boot-main');
const { fakeAi } = require('./helpers/fake-ai');

const YAML = `
openapi: 3.0.1
info: { title: 患者系统, version: "1.0" }
paths:
  /patient/{id}:
    get:
      summary: 患者详情
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Result' }
  /patient/list:
    post:
      summary: 患者列表
      responses:
        "201":
          content:
            application/json:
              schema: { type: object, properties: { total: { type: integer }, rows: { type: array, items: { type: object, properties: { name: { type: string } } } } } }
  /ping:
    get:
      summary: 健康检查
      responses:
        "200":
          content:
            application/json:
              schema: { type: object, properties: { ok: { type: boolean } } }
components:
  schemas:
    Result:
      type: object
      properties:
        code: { type: integer, example: 0 }
        data: { type: object, properties: { name: { type: string }, phone: { type: string } } }
`;
const MD = '# 订单\n## 创建订单\nPOST /order/create\n\n返回：\n```json\n{"code":0,"orderNo":"A1"}\n```\n';

async function writeFile(dir, name, text) { const file = path.join(dir, name); await fs.writeFile(file, text); return file; }

test('IPC 接口文档：导入不改动现有规则；预览 → 编辑 → 保存；冲突跳过 / 覆盖；本地 Markdown', async (t) => {
  const { call, dialogPaths, userData } = await boot(t);
  const proxy = await call('proxy:save', proxyInput({ port: 18601, target: 'http://127.0.0.1:19601' }));
  const mock = await call('mock:save', { name: 'M', port: 18602 });
  await call('rules:save', proxy.id, [{ method: 'GET', path: '/keep', response: { body: '"keep"' } }]);

  dialogPaths.open = await writeFile(userData, 'patient.yaml', YAML);
  const summary = await call('docs:import', 'openapi');
  assert.equal(summary.endpointCount, 3);
  assert.equal(summary.type, 'openapi');
  assert.equal(summary.info.title, '患者系统');
  assert.equal((await call('state:get')).docs.length, 1);
  assert.deepEqual((await call('rules:get', proxy.id)).map((r) => r.path), ['/keep'], '导入文档不会改动任何现有规则');
  assert.deepEqual(await call('rules:get', mock.id), []);

  const ids = ['GET /patient/:id', 'POST /patient/list'];
  const drafts = await call('docs:preview', summary.id, ids, { targetId: mock.id });
  assert.equal(drafts.length, 2);
  assert.equal(JSON.parse(drafts[0].rule.response.body).code, 0, '使用 Schema 里的 example');
  assert.equal(drafts[1].rule.response.status, 201);
  assert.equal(drafts[0].rule.response.headers[0].name, 'Content-Type');
  assert.equal(drafts[0].rule.source.ref, `${summary.id}:GET /patient/:id`);
  assert.deepEqual(drafts.map((d) => d.conflict), [false, false]);
  assert.deepEqual(await call('rules:get', mock.id), [], '预览不落盘');

  const dynamic = await call('docs:preview', summary.id, ids, { targetId: mock.id, dynamic: true });
  assert.equal(dynamic[0].rule.response.dynamic, true);
  assert.match(dynamic[0].rule.response.body, /\{\{name\}\}/);

  drafts[0].rule.response.body = '{"code":0,"data":{"name":"改过的"}}';
  assert.deepEqual(await call('docs:apply', mock.id, drafts), { added: 2, overwritten: 0, skipped: 0 });
  await call('proxy:start', mock.id);
  assert.equal((await (await fetch('http://127.0.0.1:18602/patient/7')).json()).data.name, '改过的', '保存后运行中的 Mock 服务即时生效');
  const created = await fetch('http://127.0.0.1:18602/patient/list', { method: 'POST' });
  assert.equal(created.status, 201);

  const again = await call('docs:preview', summary.id, ids, { targetId: mock.id });
  assert.deepEqual(again.map((d) => d.conflict), [true, true]);
  const before = await call('rules:get', mock.id);
  assert.deepEqual(await call('docs:apply', mock.id, again), { added: 0, overwritten: 0, skipped: 2 });
  const withScenario = (await call('rules:get', mock.id)).map((r, i) => (i === 0 ? { ...r, alternatives: [{ name: '手工报错', response: { status: 500, body: '"mine"' } }] } : r));
  await call('rules:save', mock.id, withScenario);
  assert.deepEqual(await call('docs:apply', mock.id, again, { conflict: 'overwrite' }), { added: 0, overwritten: 2, skipped: 0 });
  assert.deepEqual((await call('rules:get', mock.id))[0].alternatives.map((a) => a.name), ['手工报错'], '覆盖只替换当前场景，不会丢掉手工配置的其他场景');
  const after = await call('rules:get', mock.id);
  assert.deepEqual(after.map((r) => r.id), before.map((r) => r.id), '覆盖保留原规则 ID');
  assert.notEqual(after[0].response.body, before[0].response.body);

  assert.deepEqual(await call('docs:apply', proxy.id, drafts.slice(1)), { added: 1, overwritten: 0, skipped: 0 }, '也可以保存到代理');
  assert.equal((await call('rules:get', proxy.id)).length, 2);

  await assert.rejects(call('docs:preview', summary.id, [], { targetId: mock.id }), /请先勾选/);
  await assert.rejects(call('docs:preview', summary.id, ['GET /nothing'], { targetId: mock.id }), /不存在/);
  await assert.rejects(call('docs:preview', 'none', ids, { targetId: mock.id }), /找不到此接口文档/);

  dialogPaths.open = await writeFile(userData, 'order.md', MD);
  const md = await call('docs:import', 'markdown');
  assert.equal(md.type, 'markdown');
  assert.equal(md.needsConfirmCount, 1, '状态码未声明会被标记待确认');
  const mdDrafts = await call('docs:preview', md.id, ['POST /order/create'], { targetId: mock.id });
  assert.deepEqual(JSON.parse(mdDrafts[0].rule.response.body), { code: 0, orderNo: 'A1' });
  assert.deepEqual(mdDrafts[0].needsConfirm, ['状态码未在文档中声明，按 200 处理']);
  const mdDynamic = await call('docs:preview', md.id, ['POST /order/create'], { targetId: mock.id, dynamic: true });
  assert.equal(JSON.parse(mdDynamic[0].rule.response.body).code, 0, 'code 保持不变');

  dialogPaths.open = await writeFile(userData, 'bad.yaml', 'hello: 1');
  await assert.rejects(call('docs:import', 'openapi'), /不是受支持的 Swagger/);
  dialogPaths.open = await writeFile(userData, 'empty.md', '# 只有说明');
  await assert.rejects(call('docs:import', 'markdown'), /没有识别到任何接口.*AI 提取/);
  assert.equal((await call('state:get')).docs.length, 2, '导入失败不会留下半成品');
  await assert.rejects(call('docs:import', 'pdf'), /不支持的文档类型/);

  await call('docs:delete', md.id);
  assert.equal((await call('state:get')).docs.length, 1);
  assert.equal((await call('docs:get', summary.id)).endpoints.length, 3);
});

test('IPC AI：设置与密钥（加密落盘、可清除）、测试连接、错误提示不泄露密钥', async (t) => {
  const { call, userData } = await boot(t);
  const KEY = 'sk-live-SECRET-123';
  const requests = await fakeAi(t, 19610, (prompt, body, headers) => {
    if (headers.authorization !== `Bearer ${KEY}`) return { status: 401, error: `invalid key ${headers.authorization}` };
    return { text: 'OK' };
  });
  const settings = { baseUrl: 'http://127.0.0.1:19610/v1', model: 'test-model', timeoutMs: 5000 };

  assert.deepEqual({ ...(await call('ai:get')) }, { provider: 'openai', baseUrl: '', model: '', timeoutMs: 60000, customPrompt: '', hasKey: false });
  await assert.rejects(call('ai:test'), /填写 API 地址和模型/);
  await call('ai:save', settings);
  await assert.rejects(call('ai:test'), /填写 API Key/);

  assert.equal((await call('ai:save', settings, KEY)).hasKey, true);
  assert.equal((await call('ai:test')).ok, true);
  assert.equal(requests.length, 1);

  const files = await Promise.all(['secrets.json', 'relay-config.json'].map((f) => fs.readFile(path.join(userData, f), 'utf8')));
  assert.ok(files.every((text) => !text.includes(KEY)), '密钥不以明文出现在任何配置文件里');
  assert.ok(!JSON.stringify(await call('state:get')).includes(KEY), '状态里没有密钥');

  await call('ai:save', { ...settings, model: 'other' }); // 不传密钥 = 不修改
  assert.equal((await call('ai:get')).hasKey, true);
  assert.equal((await call('ai:get')).model, 'other');

  await call('ai:save', settings, 'wrong-key');
  const failure = await call('ai:test').then(() => null, (e) => e.message);
  assert.match(failure, /API Key 无效或没有权限（HTTP 401）/);
  assert.ok(!failure.includes('wrong-key'), '服务端回显的密钥已脱敏');

  await assert.rejects(call('ai:save', { ...settings, timeoutMs: 10 }), /5–300 秒/);
  await assert.rejects(call('ai:save', { ...settings, baseUrl: 'nope' }), /格式不正确/);
  await assert.rejects(call('ai:save', settings, 'has space'), /格式不正确/);
  assert.equal((await call('ai:get')).baseUrl, settings.baseUrl, '非法设置不会覆盖已有配置');

  await call('ai:save', settings, '');
  assert.equal((await call('ai:get')).hasKey, false, '空字符串表示清除密钥');
});

test('IPC AI：样例转模板、按文档重新生成、批量生成（部分失败 / 取消）、Markdown AI 提取', async (t) => {
  const { call, sent, dialogPaths, userData } = await boot(t);
  const prompts = [];
  await fakeAi(t, 19611, async (prompt) => {
    prompts.push(prompt);
    if (prompt.includes('保持与样例完全相同的结构')) return { text: '{"code":0,"data":{"name":"{{name}}","age":"{{int 18 80}}"}}' };
    if (prompt.includes('从下面的接口文档中提取')) return { text: JSON.stringify([{ method: 'POST', path: '/order/create', summary: '创建订单', status: 200, responseExample: { code: 0 }, needsConfirm: [] }]) };
    if (prompt.includes('/ping')) return { text: '这不是 JSON' };
    if (prompt.includes('/slow')) return { delayMs: 400, text: '{}' };
    if (prompt.includes('GET /patient/:id')) return { text: '{"code":0,"data":{"name":"AI生成","phone":"13800000000"}}' };
    if (prompt.includes('POST /patient/list')) return { text: '{"total":2,"rows":[{"name":"甲"},{"name":"乙"}]}' };
    return { text: '{}' };
  });
  await call('ai:save', { baseUrl: 'http://127.0.0.1:19611/v1', model: 'm', timeoutMs: 5000 }, 'sk-x');
  const mock = await call('mock:save', { name: 'M', port: 18611 });

  const sample = '{"code":0,"data":{"name":"张三","age":30}}';
  const template = await call('ai:template', sample, '患者详情');
  assert.equal(JSON.parse(template.template).data.name, '{{name}}');
  assert.equal(typeof JSON.parse(template.preview).data.age, 'number');
  assert.ok(prompts[0].includes('患者详情') && prompts[0].includes(sample), '样例与接口说明进入提示词');

  dialogPaths.open = await writeFile(userData, 'patient.yaml', YAML);
  const doc = await call('docs:import', 'openapi');
  const ids = ['GET /patient/:id', 'POST /patient/list', 'GET /ping'];
  const results = await call('ai:generate-drafts', doc.id, ids, { targetId: mock.id }, 'job-1');
  assert.deepEqual(results.map((r) => r.ok), [true, true, false], '单条失败不影响其他');
  assert.match(results[2].error, /未通过校验/);
  assert.equal(JSON.parse(results[0].draft.rule.response.body).data.name, 'AI生成');
  const progress = sent.filter((m) => m.channel === 'ai:progress' && m.data.jobId === 'job-1').map((m) => `${m.data.endpointId}:${m.data.status}`);
  assert.ok(progress.includes('GET /ping:error') && progress.includes('GET /patient/:id:ok') && progress.includes('POST /patient/list:running'));
  assert.deepEqual(await call('rules:get', mock.id), [], '生成的是草稿，没有直接写入');

  const saved = await call('docs:apply', mock.id, results.filter((r) => r.ok).map((r) => r.draft));
  assert.equal(saved.added, 2);

  const [rule] = await call('rules:get', mock.id);
  prompts.length = 0;
  const regenerated = await call('ai:regenerate', rule);
  assert.equal(JSON.parse(regenerated.body).data.name, 'AI生成');
  assert.equal((await call('rules:get', mock.id))[0].response.body, rule.response.body, '重新生成只返回候选，确认前不改动规则');
  await assert.rejects(call('ai:regenerate', { source: { type: 'manual' } }), /只有来自接口文档的规则/);
  await assert.rejects(call('ai:regenerate', { ...rule, source: { type: 'doc', ref: `${doc.id}:GET /gone` } }), /找不到对应的接口/);

  // 取消：慢请求还在进行时取消，整批以“已取消”结束
  const slowDoc = { swagger: '2.0', paths: { '/slow': { get: { responses: { 200: { schema: { type: 'object', properties: { a: { type: 'string' } } } } } } }, '/slow2': { get: { responses: { 200: { schema: { type: 'object', properties: { a: { type: 'string' } } } } } } } } };
  dialogPaths.open = await writeFile(userData, 'slow.json', JSON.stringify(slowDoc));
  const slow = await call('docs:import', 'openapi');
  const pending = call('ai:generate-drafts', slow.id, ['GET /slow', 'GET /slow2'], { targetId: mock.id }, 'job-2');
  await settle(80);
  await call('ai:cancel', 'job-2');
  const cancelled = await pending;
  assert.ok(cancelled.every((r) => !r.ok && /已取消/.test(r.error)));

  dialogPaths.open = await writeFile(userData, 'order.md', '# 订单文档\n接口说明写得很随意，没有标准格式');
  const mdDoc = await call('docs:import', 'markdown-ai');
  assert.equal(mdDoc.type, 'markdown');
  assert.equal(mdDoc.endpointCount, 1);
  assert.equal(mdDoc.needsConfirmCount, 1, 'AI 提取的接口一律标记待确认');
  const mdDrafts = await call('docs:preview', mdDoc.id, ['POST /order/create'], { targetId: mock.id });
  assert.match(mdDrafts[0].needsConfirm.join(), /由 AI 从文档提取/);
});

test('回归：文档里是完整路径 + 代理有前缀 → 生成的规则自动去掉前缀，通过代理访问真实路径命中 Mock、不连后端', async (t) => {
  const { call, dialogPaths, userData } = await boot(t);
  const hits = await backend(t, 19640, json({ from: 'backend' }));
  const proxy = await call('proxy:save', proxyInput({ port: 18640, target: 'http://127.0.0.1:19640', prefix: '/cgw/aiadmin' }));
  await call('proxy:start', proxy.id);
  const md = [
    '统一前缀 `/cgw/aiadmin/messages/appOps`', '', '## 接口一览', '',
    '| # | 接口 |', '|---|---|', '| 1 | `POST /cgw/aiadmin/messages/appOps/install` |', '| 2 | `POST /cgw/aiadmin/messages/appOps/biz` |', '',
    '## 装机量 `POST /appOps/install`', '```json', '{ "code": 200, "result": { "total": 7 } // 注释', '}', '```', '',
    '## 业务转化 `POST /appOps/biz`', '```json', '{ "code": 200, "result": { "functions": [ { "node": "guess", "value": 6 } ], "trend": { "day": [ ... ] } } }', '```', '',
  ].join('\n');
  dialogPaths.open = await writeFile(userData, 'ops.md', md);
  const doc = await call('docs:import', 'markdown');
  assert.equal(doc.endpointCount, 2);

  const drafts = await call('docs:preview', doc.id, ['POST /cgw/aiadmin/messages/appOps/install', 'POST /cgw/aiadmin/messages/appOps/biz'], { targetId: proxy.id });
  assert.deepEqual(drafts.map((d) => d.rule.path), ['/messages/appOps/install', '/messages/appOps/biz'], '规则路径已去掉代理前缀 /cgw/aiadmin');
  assert.match(drafts[0].pathAdjusted, /已去掉代理前缀 \/cgw\/aiadmin（文档路径 \/cgw\/aiadmin\/messages\/appOps\/install）/);
  assert.ok(drafts.every((d) => JSON.parse(d.rule.response.body)), '响应 Body 是合法 JSON，不含注释和省略号');
  await call('docs:apply', proxy.id, drafts);

  const response = await fetch('http://127.0.0.1:18640/cgw/aiadmin/messages/appOps/biz', { method: 'POST', body: '{}' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), { code: 200, result: { functions: [{ node: 'guess', value: 6 }], trend: { day: [] } } });
  assert.deepEqual(hits, [], '命中 Mock，没有请求后端');
  assert.equal((await (await fetch('http://127.0.0.1:18640/cgw/aiadmin/messages/appOps/install', { method: 'POST' })).json()).result.total, 7);

  // 对照：保存到 Mock 服务时保持文档里的完整路径（Mock 服务没有代理前缀）
  const mock = await call('mock:save', { name: 'M', port: 18641 });
  const forMock = await call('docs:preview', doc.id, ['POST /cgw/aiadmin/messages/appOps/biz'], { targetId: mock.id });
  assert.equal(forMock[0].rule.path, '/cgw/aiadmin/messages/appOps/biz');
  assert.equal(forMock[0].pathAdjusted, null);
});

test('从真实响应生成 Mock：预览草稿（固定 / 动态 / AI）、选择保存位置、立即启用、已有规则时追加场景', async (t) => {
  const { call } = await boot(t);
  const hits = await backend(t, 19650, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Trace', 'abc');
    if (req.url.startsWith('/text')) { res.setHeader('Content-Type', 'text/plain'); return res.end('plain text'); }
    res.statusCode = req.url.includes('/bad') ? 500 : 200;
    res.end(JSON.stringify({ code: res.statusCode, msg: 'ok', data: { id: 42, name: '李四', phone: '13900001111', list: [{ no: 1 }, { no: 2 }] } }));
  });
  await fakeAi(t, 19651, async (prompt) => ({ text: prompt.includes('保持与样例完全相同') ? '{"code":200,"msg":"ok","data":{"id":"{{int 1 99}}","name":"{{name}}","phone":"{{phone}}","list":["{{repeat 1 4}}",{"no":"{{seq}}"}]}}' : '{}' }));
  await call('ai:save', { baseUrl: 'http://127.0.0.1:19651/v1', model: 'm', timeoutMs: 5000 }, 'sk-x');
  const proxy = await call('proxy:save', proxyInput({ port: 18650, target: 'http://127.0.0.1:19650', prefix: '/cgw/aiadmin' }));
  const mock = await call('mock:save', { name: '离线', port: 18651 });
  await call('proxy:start', proxy.id);
  const base = 'http://127.0.0.1:18650/cgw/aiadmin';
  const traceOf = async (suffix) => { await settle(); return (await call('logs:get', proxy.id)).filter((l) => l.event === 'response' && l.path.includes(suffix)).pop().traceId; };

  await fetch(`${base}/patient/detail/42?lang=zh`);
  const traceId = await traceOf('/patient/detail/42');

  // 预览：固定数据 —— 不落盘；路径去掉代理前缀；复制 Content-Type 等 Header
  const fixed = await call('rules:draft-from-trace', traceId, { mode: 'fixed' });
  assert.equal(fixed.rule.path, '/patient/detail/42');
  assert.equal(fixed.rule.method, 'GET');
  assert.equal(fixed.rule.enabled, true);
  assert.equal(fixed.rule.response.dynamic, false);
  assert.equal(JSON.parse(fixed.rule.response.body).data.name, '李四');
  assert.ok(fixed.rule.response.headers.some((h) => h.name.toLowerCase() === 'x-trace'));
  assert.deepEqual({ id: fixed.target.id, kind: fixed.target.kind, existing: fixed.existing }, { id: proxy.id, kind: 'proxy', existing: null });
  assert.deepEqual(await call('rules:get', proxy.id), [], '预览不保存任何规则');

  // 预览：本地动态模板
  const dynamic = await call('rules:draft-from-trace', traceId, { mode: 'dynamic' });
  assert.equal(dynamic.rule.response.dynamic, true);
  const tpl = JSON.parse(dynamic.rule.response.body);
  assert.equal(tpl.code, 200, 'code 保持不变');
  assert.equal(tpl.data.name, '{{name}}');
  assert.equal(tpl.data.phone, '{{phone}}');
  assert.ok(tpl.data.list[0].startsWith('{{repeat'));

  // 预览：AI 模板（把样例发给 AI，结果仍只是草稿）
  const viaAi = await call('rules:draft-from-trace', traceId, { mode: 'ai' });
  assert.equal(viaAi.rule.response.dynamic, true);
  assert.equal(JSON.parse(viaAi.preview).code, 200);
  await assert.rejects(call('rules:draft-from-trace', traceId, { mode: 'magic' }), /不支持的生成方式/);

  // 保存到独立 Mock 服务：路径保持客户端看到的完整路径
  const forMock = await call('rules:draft-from-trace', traceId, { targetId: mock.id });
  assert.equal(forMock.rule.path, '/cgw/aiadmin/patient/detail/42');
  assert.equal(forMock.target.kind, 'mock');

  // 确认：编辑路径（具体 ID → :id）、状态码和 Body，并立即启用
  const edited = { ...fixed.rule, path: '/patient/detail/:id', response: { ...fixed.rule.response, body: '{"code":200,"data":{"name":"本地数据"}}' } };
  const created = await call('rules:apply-trace-draft', proxy.id, edited, { enabled: true });
  assert.equal(created.enabled, true);
  assert.equal(created.addedAsScenario, false);
  const before = hits.length;
  assert.equal((await (await fetch(`${base}/patient/detail/7`)).json()).data.name, '本地数据', '创建后立即生效，任意 ID 都命中');
  assert.equal(hits.length, before, '命中 Mock，没有请求后端');

  // 不勾选“立即启用”：创建但停用，仍然走真实后端
  const off = await call('rules:apply-trace-draft', proxy.id, { ...fixed.rule, path: '/other/42' }, { enabled: false });
  assert.equal(off.enabled, false);
  await fetch(`${base}/other/42`);
  assert.equal(hits.at(-1), 'GET /other/42');

  // 该接口已有规则：追加为新场景；勾选“立即启用”则切换到新场景
  const second = await call('rules:draft-from-trace', traceId, { mode: 'fixed' });
  assert.equal(second.existing, null, '这是具体路径 /patient/detail/42，与 :id 规则不同键');
  const again = await call('rules:draft-from-trace', traceId);
  const added = await call('rules:apply-trace-draft', proxy.id, { ...again.rule, path: '/patient/detail/:id' }, { enabled: true });
  assert.equal(added.addedAsScenario, true);
  assert.equal(added.alternatives.length, 1);
  assert.match(added.scenario.name, /^真实响应/, '立即启用时当前场景切换为新生成的真实响应');
  assert.equal(added.alternatives[0].name, '默认', '原来的数据保留为另一个场景');
  assert.equal((await (await fetch(`${base}/patient/detail/9`)).json()).data.name, '李四');
  const withExisting = await call('rules:draft-from-trace', traceId, { mode: 'fixed' });
  assert.equal(withExisting.existing, null);

  // 保存到 Mock 服务 + 动态模板：运行后每次不同
  await call('rules:apply-trace-draft', mock.id, { ...forMock.rule, response: dynamic.rule.response }, { enabled: true });
  await call('proxy:start', mock.id);
  const a = await (await fetch('http://127.0.0.1:18651/cgw/aiadmin/patient/detail/42')).json();
  const b = await (await fetch('http://127.0.0.1:18651/cgw/aiadmin/patient/detail/42')).json();
  assert.equal(a.code, 200);
  assert.notDeepEqual(a.data, b.data, '动态模板每次返回不同的数据');

  // 拒绝：纯文本不能转动态；500 错误响应可以（这正是“后端报错时本地顶替”的场景）
  await fetch(`${base}/text/hello`);
  await assert.rejects(call('rules:draft-from-trace', await traceOf('/text/hello'), { mode: 'dynamic' }), /不是 JSON/);
  assert.equal((await call('rules:draft-from-trace', await traceOf('/text/hello'), { mode: 'fixed' })).rule.response.body, 'plain text');
  await fetch(`${base}/patient/bad/1`);
  const errorDraft = await call('rules:draft-from-trace', await traceOf('/patient/bad/1'));
  assert.equal(errorDraft.rule.response.status, 500);
  assert.equal(JSON.parse(errorDraft.rule.response.body).code, 500);
});
