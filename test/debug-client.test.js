'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { validateProxy } = require('../src/proxy-manager');
const { buildDebugRequest, sendDebugRequest, MAX_RESPONSE } = require('../src/debug-client');

const proxy = (over = {}) => validateProxy({
  name: 'D', port: 18700, target: 'http://127.0.0.1:19700', prefix: '/api', ...over,
}, 'd1');
const hdr = (name, value, enabled = true) => ({ name, value, enabled });

test('组装请求：环境、前缀、Query、Header 优先级、Body 类型', () => {
  const p = proxy({ environments: [{ name: '测试', target: 'http://127.0.0.1:19700' }, { name: '本地', target: 'http://localhost:8080' }], activeEnv: '测试' });

  const a = buildDebugRequest(p, [hdr('Authorization', 'Bearer base'), hdr('X-From', 'proxy')], {
    method: 'post', env: '本地', path: '/patient/1', query: [{ name: 'page', value: '2 3' }, { name: 'off', value: 'x', enabled: false }, { name: '', value: 'skip' }],
    headers: [hdr('authorization', 'Bearer mine'), hdr('X-Off', 'no', false)], bodyType: 'json', body: '{"a":1}',
  });
  assert.equal(a.method, 'POST');
  assert.equal(a.url, 'http://localhost:8080/patient/1?page=2+3', '去掉前缀转发；停用和空名称的 Query 不发送');
  assert.equal(a.env, '本地');
  const h = Object.fromEntries(a.headers.map((x) => [x.name.toLowerCase(), x.value]));
  assert.equal(h.authorization, 'Bearer mine', '调试里的同名 Header 覆盖代理 Header');
  assert.equal(h['x-from'], 'proxy');
  assert.equal(h['x-off'], undefined, '停用的 Header 不发送');
  assert.equal(h['content-type'], 'application/json');
  assert.equal(h['accept-encoding'], 'identity');
  assert.equal(a.body.toString(), '{"a":1}');

  assert.equal(buildDebugRequest(p, [], { path: '/x' }).env, '测试', '不选环境用当前环境');
  assert.equal(buildDebugRequest(proxy({ stripPrefix: false }), [], { path: '/x' }).url, 'http://127.0.0.1:19700/api/x', '不去前缀时保留前缀');
  assert.equal(buildDebugRequest(proxy(), [], { path: '/x' }).env, null, '没有配置环境时用 target');

  const get = buildDebugRequest(p, [], { method: 'GET', path: '/x', bodyType: 'json', body: '{}' });
  assert.equal(get.body, null, 'GET 不带 Body');
  const own = buildDebugRequest(p, [], { method: 'PUT', path: '/x', bodyType: 'text', body: 'hi', headers: [hdr('Content-Type', 'application/xml')] });
  assert.equal(own.headers.find((x) => x.name === 'Content-Type').value, 'application/xml', '显式 Content-Type 优先于 Body 类型');
  assert.equal(buildDebugRequest(p, [], { method: 'PUT', path: '/x', bodyType: 'form', body: 'a=1' }).headers.find((x) => x.name === 'Content-Type').value, 'application/x-www-form-urlencoded');
});

test('组装请求：非法输入被拒绝，不能借路径跳到别的主机', () => {
  const p = proxy({ environments: [{ name: '测试', target: 'http://127.0.0.1:19700' }] });
  assert.throws(() => buildDebugRequest(p, [], { method: 'TRACE', path: '/x' }), /不支持的请求方法/);
  assert.throws(() => buildDebugRequest(p, [], { path: 'x' }), /以 \/ 开头/);
  assert.throws(() => buildDebugRequest(p, [], { path: '/x#a' }), /锚点/);
  assert.throws(() => buildDebugRequest(p, [], { path: '/x', env: '不存在' }), /找不到环境/);
  assert.throws(() => buildDebugRequest(p, [], { path: '/x', headers: [hdr('Content-Length', '1')] }), /Content-Length/);
  assert.throws(() => buildDebugRequest(p, [], { path: '/x', bodyType: 'xml' }), /Body 类型/);
  assert.throws(() => buildDebugRequest(p, [], { path: '/x', method: 'POST', bodyType: 'text', body: 'x'.repeat(2 * 1024 * 1024 + 1) }), /2 MB/);
  for (const path of ['//evil.com/x', '/@evil.com/x', '/\\evil.com']) {
    const url = new URL(buildDebugRequest(p, [], { path }).url);
    assert.equal(url.origin, 'http://127.0.0.1:19700', `路径 ${path} 不会改变目标主机`);
  }
});

async function server(t, port, handler) {
  const s = http.createServer(handler);
  await new Promise((resolve) => s.listen(port, '127.0.0.1', resolve));
  t.after(() => s.closeAllConnections?.() || s.close());
  return s;
}

test('发送：后端收到的方法 / 路径 / Query / Header / Body 与调试输入一致，响应原样返回', async (t) => {
  let seen;
  await server(t, 19701, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(201, { 'Content-Type': 'application/json', 'X-Backend': 'yes', 'Set-Cookie': ['a=1', 'b=2'] });
      res.end('{"ok":true}');
    });
  });
  const req = buildDebugRequest(proxy({ target: 'http://127.0.0.1:19701' }), [hdr('X-Token', 'T')], {
    method: 'POST', path: '/order/9', query: [{ name: 'q', value: '中文' }], headers: [hdr('X-Extra', '1')], bodyType: 'json', body: '{"n":1}',
  });
  const result = await sendDebugRequest(req);
  assert.deepEqual([seen.method, seen.url, seen.body], ['POST', '/order/9?q=%E4%B8%AD%E6%96%87', '{"n":1}']);
  assert.deepEqual([seen.headers['x-token'], seen.headers['x-extra'], seen.headers['content-type'], seen.headers['content-length']], ['T', '1', 'application/json', '7']);
  assert.equal(result.error, null);
  assert.deepEqual([result.response.status, result.response.statusText, result.response.body], [201, 'Created', '{"ok":true}']);
  assert.deepEqual(result.response.headers.filter((h) => h.name === 'Set-Cookie').map((h) => h.value), ['a=1', 'b=2'], '重复的响应 Header 都保留');
  assert.equal(result.request.url, req.url);
  assert.ok(result.durationMs >= 0);
});

test('发送：4xx/5xx 是正常响应；连接失败、超时、压缩、大响应、二进制都有明确结果', async (t) => {
  await server(t, 19702, (req, res) => {
    if (req.url === '/gz') { res.writeHead(200, { 'Content-Encoding': 'gzip' }); return res.end(zlib.gzipSync('压缩的内容')); }
    if (req.url === '/big') { res.setHeader('Content-Type', 'text/plain'); return res.end('x'.repeat(MAX_RESPONSE + 5000)); }
    if (req.url === '/bin') return res.end(Buffer.from([0, 1, 2]));
    if (req.url === '/slow') return setTimeout(() => res.end('late'), 2000);
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/elsewhere' }); return res.end(); }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"code":500,"msg":"后端异常"}');
  });
  const p = proxy({ target: 'http://127.0.0.1:19702' });
  const send = (path, over = {}) => sendDebugRequest({ ...buildDebugRequest(p, [], { path }), ...over });

  const err500 = await send('/boom');
  assert.deepEqual([err500.error, err500.response.status, JSON.parse(err500.response.body).msg], [null, 500, '后端异常']);
  assert.equal((await send('/gz', { headers: [{ name: 'Accept-Encoding', value: 'gzip' }] })).response.body, '压缩的内容', '压缩响应自动解压');
  const big = (await send('/big')).response;
  assert.deepEqual([big.truncated, big.size, big.body.length], [true, MAX_RESPONSE, MAX_RESPONSE], '超过上限只保留前 1 MB');
  assert.equal((await send('/bin')).response.binary, true);
  const redirect = (await send('/redirect')).response;
  assert.deepEqual([redirect.status, redirect.headers.find((h) => h.name === 'Location').value], [302, '/elsewhere'], '不自动跟随重定向');

  const slow = await send('/slow', { timeoutMs: 150 });
  assert.equal(slow.response, null);
  assert.equal(slow.error.code, 'ETIMEDOUT');

  const refused = await sendDebugRequest(buildDebugRequest(proxy({ target: 'http://127.0.0.1:19799' }), [], { path: '/x' }));
  assert.equal(refused.response, null);
  assert.equal(refused.error.code, 'ECONNREFUSED');
  assert.match(refused.error.message, /连接被拒绝/);
  assert.match(refused.request.url, /19799\/x/, '失败时仍返回实际发出的请求');
});
