'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ProxyManager, validateProxy } = require('../src/proxy-manager');

function config(overrides = {}) {
  return validateProxy({
    name: '测试代理', port: 18091, target: 'http://127.0.0.1:19091', prefix: '/cgw/aiadmin', ...overrides,
  }, overrides.id);
}

test('配置校验：合法地址与标准化', () => {
  const proxy = config();
  assert.equal(proxy.stripPrefix, true);
  assert.equal(proxy.target, 'http://127.0.0.1:19091');
  assert.throws(() => config({ port: 70000 }), /端口/);
  assert.throws(() => config({ target: '10.0.7.33:8106' }), /格式/);
  assert.throws(() => config({ prefix: 'cgw' }), /前缀/);
});

test('多代理：独立启停、转发、查询参数、CORS 与日志', async (t) => {
  const backends = [];
  for (const port of [19091, 19092]) {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Backend', 'relay-test');
      res.end(JSON.stringify({ url: req.url, origin: req.headers.origin || null, port, headers: req.headers, body }));
      });
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    backends.push(server);
    t.after(() => server.close());
  }

  const traces = new Map();
  const logs = [];
  const manager = new ProxyManager((log) => logs.push(log), () => {}, (trace) => traces.set(trace.id, trace));
  const first = config({ id: 'first' });
  const second = config({ id: 'second', name: '第二条代理', port: 18092, target: 'http://127.0.0.1:19092', prefix: '/api', stripPrefix: false });
  await manager.start(first);
  await manager.start(second);
  t.after(() => manager.stopAll());

  const response = await fetch('http://127.0.0.1:18091/cgw/aiadmin/user/list?page=2&name=test', { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const firstData = await response.json();
  assert.equal(firstData.url, '/user/list?page=2&name=test');
  assert.equal(firstData.origin, null);
  assert.equal(firstData.port, 19091);
  const firstTrace = traces.get(logs.find((log) => log.proxyId === 'first' && log.event === 'request').traceId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstTrace.request.outgoingHeaders.host, '127.0.0.1:19091');
  assert.equal(firstTrace.response.body.body.includes('user/list'), true);
  assert.equal(firstTrace.response.headers['x-backend'], 'relay-test');
  assert.match(firstTrace.response.body.body, /user\/list/);

  const secondResponse = await fetch('http://127.0.0.1:18092/api/health');
  const secondData = await secondResponse.json();
  assert.equal(secondData.url, '/api/health');
  assert.equal(secondData.port, 19092);

  const preflight = await fetch('http://127.0.0.1:18091/cgw/aiadmin/user', { method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'X-Custom' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'X-Custom');

  // 带凭证的跨域（withCredentials）：必须回显 Origin 并允许凭证，不能是 *
  const origin = 'http://localhost:7500';
  const credPre = await fetch('http://127.0.0.1:18091/cgw/aiadmin/user', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(credPre.headers.get('access-control-allow-origin'), origin);
  assert.equal(credPre.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(credPre.headers.get('access-control-allow-private-network'), 'true');
  assert.match(credPre.headers.get('vary'), /Origin/);
  const credRes = await fetch('http://127.0.0.1:18091/cgw/aiadmin/user/list', { headers: { Origin: origin } });
  assert.equal(credRes.headers.get('access-control-allow-origin'), origin);
  assert.equal(credRes.headers.get('access-control-allow-credentials'), 'true');

  const notFound = await fetch('http://127.0.0.1:18091/other');
  assert.equal(notFound.status, 404);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(logs.some((log) => log.proxyId === 'first' && log.event === 'request' && log.target.includes('/user/list?page=2')));
  assert.ok(logs.some((log) => log.proxyId === 'first' && log.event === 'response' && log.status === 200));
  assert.ok(logs.some((log) => log.proxyId === 'second' && log.status === 200));
  assert.deepEqual(manager.status().sort(), ['first', 'second']);

  await manager.stop('first');
  assert.deepEqual(manager.status(), ['second']);
  await assert.rejects(fetch('http://127.0.0.1:18091/cgw/aiadmin/user'));
  assert.equal((await fetch('http://127.0.0.1:18092/api/health')).status, 200);
});

test('自定义 Header 与详情：Token、Cookie、请求体、响应体', async (t) => {
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'session=backend; HttpOnly', 'X-Response-Test': 'yes' });
      res.end(JSON.stringify({ authorization: req.headers.authorization, cookie: req.headers.cookie, custom: req.headers['x-custom'], disabled: req.headers['x-disabled'], body }));
    });
  });
  await new Promise((resolve) => backend.listen(19093, '127.0.0.1', resolve));
  t.after(() => backend.close());
  const traces = new Map();
  const logs = [];
  const manager = new ProxyManager((log) => logs.push(log), () => {}, (trace) => traces.set(trace.id, trace));
  manager.setGlobalHeaders([
    { name: 'Authorization', value: 'Bearer global-token', enabled: true },
    { name: 'X-Global', value: 'shared', enabled: true },
  ]);
  assert.equal(manager.effectiveHeaders({ headers: [{ name: 'authorization', value: 'Bearer local', enabled: true }] }).find((header) => header.name.toLowerCase() === 'authorization').value, 'Bearer local');
  await manager.start(config({ id: 'headers', port: 18093, target: 'http://127.0.0.1:19093', headers: [
    { name: 'Authorization', value: 'Bearer test-token', enabled: true },
    { name: 'Cookie', value: 'token=abc; userId=42', enabled: true },
    { name: 'X-Custom', value: 'relay', enabled: true },
    { name: 'X-Disabled', value: 'should-not-send', enabled: false },
  ] }));
  t.after(() => manager.stopAll());
  const response = await fetch('http://127.0.0.1:18093/cgw/aiadmin/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer browser-token' }, body: JSON.stringify({ name: '测试', id: 7 }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authorization: 'Bearer test-token', cookie: 'token=abc; userId=42', custom: 'relay', body: '{"name":"测试","id":7}' });
  await new Promise((resolve) => setImmediate(resolve));
  const trace = traces.get(logs.find((log) => log.event === 'request').traceId);
  assert.equal(trace.request.outgoingHeaders.authorization, 'Bearer test-token');
  assert.equal(trace.request.outgoingHeaders.cookie, 'token=abc; userId=42');
  assert.equal(trace.request.body.body, '{"name":"测试","id":7}');
  assert.equal(trace.request.body.complete, true);
  assert.equal(trace.response.status, 200);
  assert.equal(trace.response.headers['x-response-test'], 'yes');
  assert.deepEqual(trace.response.headers['set-cookie'], ['session=backend; HttpOnly']);
  assert.match(trace.response.body.body, /test-token/);
  manager.setGlobalHeaders([{ name: 'X-Global', value: 'changed-without-restart', enabled: true }]);
  const updated = await fetch('http://127.0.0.1:18093/cgw/aiadmin/global-updated');
  const updatedTrace = traces.get(logs.filter((log) => log.event === 'request').at(-1).traceId);
  assert.equal(updated.status, 200);
  assert.equal(updatedTrace.request.outgoingHeaders['x-global'], 'changed-without-restart');
  assert.equal(updatedTrace.request.outgoingHeaders.authorization, 'Bearer test-token');
  assert.throws(() => config({ headers: [{ name: 'Bad Header', value: 'bad' }] }), /格式/);
  assert.throws(() => config({ headers: [{ name: 'Content-Length', value: '100' }] }), /不建议/);
});

test('异常处理：后端不可达返回 502，端口占用有明确错误', async (t) => {
  const logs = [];
  const manager = new ProxyManager((log) => logs.push(log), () => {});
  const first = config({ id: 'offline', target: 'http://127.0.0.1:19999' });
  await manager.start(first);
  t.after(() => manager.stopAll());
  const response = await fetch('http://127.0.0.1:18091/cgw/aiadmin/test');
  assert.equal(response.status, 502);
  assert.match((await response.json()).message, /ECONNREFUSED/);
  await assert.rejects(manager.start(config({ id: 'duplicate', name: '端口冲突' })), /18091.*占用/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(logs.some((log) => log.level === 'error' && log.event === 'error'));
});

test('本机 IP：默认 localhost，可填 IP，非法值被拒绝', () => {
  const { validateHost, validateMockService } = require('../src/proxy-manager');
  assert.equal(validateProxy({ name: 'a', port: 18095, target: 'http://127.0.0.1:1', prefix: '/a' }).host, 'localhost');
  assert.equal(validateHost('  '), 'localhost');
  assert.equal(validateHost('LocalHost'), 'localhost');
  assert.equal(validateHost('192.168.1.10'), '192.168.1.10');
  assert.equal(validateHost('0.0.0.0'), '0.0.0.0');
  assert.equal(validateHost('[::1]'), '::1');
  assert.throws(() => validateHost('my-host'), /本机 IP/);
  assert.throws(() => validateHost('300.1.1.1'), /本机 IP/);
  assert.equal(validateMockService({ name: 'm', port: 9001, host: '10.0.0.5' }).host, '10.0.0.5');
});

test('本机 IP：localhost 与 127.0.0.1 均可访问，日志显示配置的地址', async () => {
  const logs = [];
  const manager = new ProxyManager((log) => logs.push(log.message), () => {});
  await manager.start({ ...config({ id: 'hosted', port: 18096 }), host: 'localhost' });
  try {
    assert.equal((await fetch('http://127.0.0.1:18096/other')).status, 404);
    assert.ok(logs.some((m) => m.includes('http://localhost:18096/cgw/aiadmin')));
  } finally { await manager.stopAll(); }
});

test('本机 IP：绑定到本机非回环 IPv4 后可通过该地址访问；本机没有的 IP 给出明确错误', async (t) => {
  const ip = Object.values(require('node:os').networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  const manager = new ProxyManager(() => {}, () => {});
  await assert.rejects(manager.start({ ...config({ id: 'bad-ip', port: 18097 }), host: '203.0.113.9' }), /本机没有 IP/);
  if (!ip) return t.skip('本机没有非回环 IPv4');
  await manager.start({ ...config({ id: 'lan', port: 18098 }), host: ip });
  try { assert.equal((await fetch(`http://${ip}:18098/other`)).status, 404); }
  finally { await manager.stopAll(); }
});
