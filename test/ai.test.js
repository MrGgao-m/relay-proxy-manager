'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AiClient, validateAiSettings, sameShape, runBatch, chunkMarkdown } = require('../src/ai');
const secrets = require('../src/secrets');

/** 本地假的 AI 服务：按脚本依次返回；记录每次请求。 */
async function fakeAi(t, port, script) {
  const requests = [];
  const queue = [...script];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });
      const step = queue.length > 1 ? queue.shift() : queue[0];
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      res.statusCode = step.status || 200;
      res.setHeader('Content-Type', 'application/json');
      if (step.raw !== undefined) return res.end(step.raw);
      if (step.error) return res.end(JSON.stringify({ error: { message: step.error } }));
      res.end(JSON.stringify(step.anthropic ? { content: [{ type: 'text', text: step.text }] } : { choices: [{ message: { content: step.text } }] }));
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  t.after(() => server.close());
  return requests;
}
const client = (port, extra = {}, key = 'sk-test-KEY') => new AiClient({
  getSettings: () => ({ provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm1', timeoutMs: 5000, customPrompt: '', ...extra }),
  getApiKey: async () => key,
});
const ok = (text, anthropic = false) => ({ text, anthropic });

test('AI 设置校验', () => {
  assert.deepEqual(validateAiSettings({ baseUrl: 'https://api.example.com/v1/', model: ' m ' }), { provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm', timeoutMs: 60000, customPrompt: '' });
  assert.throws(() => validateAiSettings({ provider: 'x' }), /接口类型/);
  assert.throws(() => validateAiSettings({ baseUrl: 'api.example.com' }), /格式不正确/);
  assert.throws(() => validateAiSettings({ baseUrl: 'ftp://a.com' }), /只支持 HTTP/);
  assert.throws(() => validateAiSettings({ baseUrl: 'https://u:p@a.com' }), /账号密码/);
  assert.throws(() => validateAiSettings({ baseUrl: 'https://a.com?k=1' }), /查询参数/);
  assert.throws(() => validateAiSettings({ timeoutMs: 100 }), /5–300 秒/);
  assert.throws(() => validateAiSettings({ customPrompt: 'x'.repeat(2001) }), /2000/);
});

test('请求格式：OpenAI 兼容与 Anthropic 原生，自定义提示词进入 system', async (t) => {
  const reqs = await fakeAi(t, 19401, [ok('pong'), ok('pong2', true)]);
  const text = await client(19401, { customPrompt: '使用医疗场景数据' }).chat({ system: 'SYS', user: 'hello' });
  assert.equal(text, 'pong');
  assert.equal(reqs[0].url, '/v1/chat/completions');
  assert.equal(reqs[0].headers.authorization, 'Bearer sk-test-KEY');
  assert.equal(reqs[0].body.model, 'm1');
  assert.match(reqs[0].body.messages[0].content, /SYS[\s\S]*使用医疗场景数据/);
  assert.equal(reqs[0].body.messages[1].content, 'hello');

  const second = await client(19401, { provider: 'anthropic' }).chat({ system: 'SYS', user: 'hi' });
  assert.equal(second, 'pong2');
  assert.equal(reqs[1].url, '/v1/messages', 'baseUrl 已带 /v1 时不重复');
  assert.equal(reqs[1].headers['x-api-key'], 'sk-test-KEY');
  assert.ok(reqs[1].headers['anthropic-version']);
  assert.equal(reqs[1].body.system, 'SYS');
  assert.equal(reqs[1].body.messages[0].content, 'hi');
});

test('错误归类：密钥错误、地址错误、限流、服务异常、无法连接、超时、空内容、未配置', async (t) => {
  await fakeAi(t, 19402, [{ status: 401, error: 'bad key sk-test-KEY' }, { status: 404, error: 'no model' }, { status: 429, error: 'slow down' }, { status: 503, raw: 'upstream down' }, ok('   '), { raw: 'not json' }, { delayMs: 800, ...ok('late') }]);
  const c = client(19402);
  const msg = async (p) => (await p.then(() => 'NO ERROR', (e) => e.message));
  const first = await msg(c.chat({ system: 's', user: 'u' }));
  assert.match(first, /API Key 无效或没有权限（HTTP 401）/);
  assert.ok(!first.includes('sk-test-KEY'), '服务端回显的密钥被脱敏');
  assert.match(await msg(c.chat({ system: 's', user: 'u' })), /地址或模型名称不正确（HTTP 404）.*no model/);
  assert.match(await msg(c.chat({ system: 's', user: 'u' })), /额度不足（HTTP 429）/);
  assert.match(await msg(c.chat({ system: 's', user: 'u' })), /暂时不可用（HTTP 503）.*upstream down/);
  assert.match(await msg(c.chat({ system: 's', user: 'u' })), /空内容/);
  assert.match(await msg(c.chat({ system: 's', user: 'u' })), /空内容或无法识别/);
  assert.match(await msg(client(19402, { timeoutMs: 150 }).chat({ system: 's', user: 'u' })), /请求超时/);
  assert.match(await msg(client(19499).chat({ system: 's', user: 'u' })), /无法连接到 AI 服务.*ECONNREFUSED/);
  assert.match(await msg(client(19402, { baseUrl: '' }).chat({ system: 's', user: 'u' })), /填写 API 地址和模型/);
  assert.match(await msg(client(19402, {}, '').chat({ system: 's', user: 'u' })), /填写 API Key/);
  const abort = new AbortController(); abort.abort();
  assert.match(await msg(c.chat({ system: 's', user: 'u', signal: abort.signal })), /已取消/);
});

test('测试连接', async (t) => {
  await fakeAi(t, 19403, [ok('OK')]);
  const result = await client(19403).testConnection();
  assert.equal(result.ok, true);
  assert.equal(result.model, 'm1');
});

test('样例转模板：结构被改动时自动重试，通过本地校验后返回模板与预览', async (t) => {
  const sample = { code: 0, data: { name: '张三', age: 30, list: [{ id: 1 }] } };
  const bad = { code: 0, data: { name: '{{name}}', age: '{{int 18 80}}' } }; // 缺少 list
  const good = { code: 0, data: { name: '{{name}}', age: '{{int 18 80}}', list: ['{{repeat 2 5}}', { id: '{{int 1 999}}' }] } };
  const reqs = await fakeAi(t, 19404, [ok(JSON.stringify(bad)), ok(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``)]);
  const out = await client(19404).templateFromSample(JSON.stringify(sample), { hint: '患者详情' });
  assert.equal(reqs.length, 2);
  assert.match(reqs[1].body.messages[1].content, /上一次的输出有问题：模板结构与样例不一致：\$\.data 缺少字段 list/);
  assert.match(reqs[0].body.messages[1].content, /患者详情/);
  assert.match(reqs[0].body.messages[0].content, /\{\{repeat 最少 最多\}\}/, '提示词带完整占位符语法');
  assert.equal(JSON.parse(out.template).data.age, '{{int 18 80}}');
  const preview = JSON.parse(out.preview);
  assert.equal(typeof preview.data.age, 'number');
  assert.equal(preview.code, 0);
});

test('样例转模板：两次都不合格则报错，不返回任何内容；非法占位符被拦截', async (t) => {
  await fakeAi(t, 19405, [ok('{"code":0}'), ok('{"code":0}')]);
  await assert.rejects(client(19405).templateFromSample('{"code":0}'), /未通过校验.*没有使用任何占位符/);
  await fakeAi(t, 19406, [ok('{"a":"{{nope}}"}')]);
  await assert.rejects(client(19406).templateFromSample('{"a":"x"}'), /未知占位符/);
  await assert.rejects(client(19406).templateFromSample('x'.repeat(60001)), /样例过长/);
});

test('按文档生成：Schema 校验不通过则重试；动态模板渲染后同样要符合 Schema', async (t) => {
  const endpoint = { method: 'GET', path: '/patient/:id', summary: '详情', successStatus: 200, responses: [{ status: 200, schema: { type: 'object', required: ['id', 'age'], properties: { id: { type: 'string' }, age: { type: 'integer' } } } }] };
  const reqs = await fakeAi(t, 19407, [ok('{"id":"a1","age":"三十"}'), ok('{"id":"a1","age":30}')]);
  const fixed = await client(19407).generateBody(endpoint);
  assert.equal(reqs.length, 2);
  assert.match(reqs[1].body.messages[1].content, /不符合响应 Schema/);
  assert.deepEqual(JSON.parse(fixed.body), { id: 'a1', age: 30 });
  assert.equal(fixed.dynamic, false);

  await fakeAi(t, 19408, [ok('{"id":"{{uuid}}","age":"{{int 18 80}}"}')]);
  const dynamic = await client(19408).generateBody(endpoint, { dynamic: true });
  assert.equal(dynamic.dynamic, true);
  assert.equal(JSON.parse(dynamic.body).age, '{{int 18 80}}');

  await fakeAi(t, 19409, [ok('{"id":"{{uuid}}","age":"{{text 3}}"}')]);
  await assert.rejects(client(19409).generateBody(endpoint, { dynamic: true }), /不符合响应 Schema/, '渲染后 age 变成文本，校验不通过');
  await assert.rejects(client(19409).generateBody({ ...endpoint, responses: [{ status: 200 }] }), /没有响应 Schema 或示例/);
});

test('从 Markdown 提取接口：规范化路径、保留待确认、重复与非法项处理', async (t) => {
  const items = [
    { method: 'get', path: '/patient/detail/{id}', summary: '详情', params: [{ name: 'id', in: 'path', required: true, type: 'string' }], status: 200, responseExample: { code: 0 }, needsConfirm: [] },
    { method: 'POST', path: '/patient/create', summary: '新增', status: 201, responseExample: null, needsConfirm: ['字段不全'] },
    { method: 'GET', path: '/patient/detail/:id', summary: '重复' },
  ];
  const reqs = await fakeAi(t, 19410, [ok(JSON.stringify([{ method: 'FETCH', path: '/x' }])), ok(`好的：\n${JSON.stringify(items)}`)]);
  const { endpoints, warnings } = await client(19410).extractEndpoints('# 文档\n随便写点');
  assert.equal(reqs.length, 2, '第一次 method 非法，重试一次');
  assert.deepEqual(endpoints.map((e) => e.id), ['GET /patient/detail/:id', 'POST /patient/create']);
  assert.equal(endpoints[0].responses[0].example.code, 0);
  assert.equal(endpoints[1].successStatus, 201);
  assert.match(endpoints[1].needsConfirm.join(), /字段不全[\s\S]*由 AI 从文档提取[\s\S]*没有响应示例/);
  assert.match(warnings.join(), /重复接口/);

  const long = Array.from({ length: 60 }, (_, i) => `## 接口${i}\n${'说明文字'.repeat(150)}\nGET /api/${i}\n`).join('\n');
  assert.ok(chunkMarkdown(long).length > 1, '长文档按标题分块');
  const many = Array.from({ length: 400 }, (_, i) => `## 接口${i}\n${'说明'.repeat(300)}\n`).join('\n');
  await assert.rejects(client(19410).extractEndpoints(many), /文档过长/);
});

test('批处理：并发上限、单项失败不影响其他、取消后剩余项标记已取消', async () => {
  let running = 0; let peak = 0;
  const results = await runBatch([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 20));
    running -= 1;
    if (n === 4) throw new Error('第四项失败');
    return n * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(results.map((r) => (r.ok ? r.value : r.error)), [2, 4, 6, '第四项失败', 10, 12, 14]);

  const controller = new AbortController();
  const done = [];
  const cancelled = await runBatch([1, 2, 3, 4, 5], 1, async (n) => { done.push(n); if (n === 2) controller.abort(); return n; }, { signal: controller.signal });
  assert.deepEqual(done, [1, 2]);
  assert.deepEqual(cancelled.map((r) => r.ok), [true, true, false, false, false]);
  assert.equal(cancelled[4].error, '已取消');
});

test('样例结构对比', () => {
  assert.equal(sameShape({ a: [1] }, { a: ['{{repeat 1 3}}', 2] }), null);
  assert.match(sameShape({ a: 1 }, { a: 1, b: 2 }), /多出字段 b/);
  assert.match(sameShape([1], { a: 1 }), /应为数组/);
});

test('API Key 加密存储：不落明文、可清除、系统不支持时拒绝保存', async (t) => {
  const dir = await fs.mkdtemp(path.join((await fs.mkdir(path.join(os.tmpdir(), 'proxy', 'tmp'), { recursive: true }), path.join(os.tmpdir(), 'proxy', 'tmp')), 'sec-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const safe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`ENC:${[...s].reverse().join('')}`), decryptString: (b) => [...b.toString().slice(4)].reverse().join('') };
  assert.equal(await secrets.hasApiKey(dir), false);
  assert.equal(await secrets.loadApiKey(dir, safe), '');
  await secrets.saveApiKey(dir, 'sk-abc123', safe);
  assert.equal(await secrets.hasApiKey(dir), true);
  assert.ok(!(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8')).includes('sk-abc123'));
  assert.equal(await secrets.loadApiKey(dir, safe), 'sk-abc123');
  await assert.rejects(secrets.saveApiKey(dir, 'has space', safe), /格式不正确/);
  await assert.rejects(secrets.saveApiKey(dir, 'sk-x', { isEncryptionAvailable: () => false }), /不支持安全存储/);
  await assert.rejects(secrets.loadApiKey(dir, { ...safe, decryptString: () => { throw new Error('x'); } }), /无法解密/);
  await secrets.saveApiKey(dir, '', safe);
  assert.equal(await secrets.hasApiKey(dir), false);
});
