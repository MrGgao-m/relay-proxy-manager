'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const http = require('node:http');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright-core');

(async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-smoke-'));
  const backends = [];
  for (const port of [19101, 19102]) {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Backend', 'relay-ui');
      res.end(JSON.stringify({ port, url: req.url, headers: req.headers }));
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    backends.push(server);
  }

  const childEnv = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;

  let app;
  try {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [path.join(__dirname, '..'), `--user-data-dir=${userData}`, '--no-sandbox'],
      env: childEnv,
      timeout: 30000,
    });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForSelector('#welcome:not(.hidden)');
    await window.screenshot({ path: path.join(__dirname, 'welcome.png') });

    async function addProxy(name, port, target, prefix) {
      await window.locator('#add-proxy').click();
      await window.locator('#proxy-name').fill(name);
      await window.locator('#proxy-port').fill(String(port));
      await window.locator('#proxy-target').fill(target);
      await window.locator('#proxy-prefix').fill(prefix);
      await window.locator('#save-proxy').click();
      await window.waitForSelector('#modal-backdrop.hidden', { state: 'attached' });
    }

    await addProxy('AI 管理后台', 18101, 'http://127.0.0.1:19101', '/cgw/aiadmin');
    await addProxy('订单服务', 18102, 'http://127.0.0.1:19102', '/api');
    assert.equal(await window.locator('.proxy-card').count(), 2);

    await window.locator('.proxy-card').first().click();
    await window.locator('#toggle-proxy').click();
    await window.waitForFunction(() => document.querySelector('#status-label').textContent === '运行中');
    const first = await fetch('http://127.0.0.1:18101/cgw/aiadmin/users?page=1');
    assert.equal(first.status, 200);
    assert.equal((await first.json()).url, '/users?page=1');
    await window.waitForFunction(() => document.querySelector('#log-list').textContent.includes('/users?page=1'));
    await window.waitForFunction(() => document.querySelector('#stat-requests').textContent === '1');

    await window.locator('.proxy-card').nth(1).click();
    await window.locator('#toggle-proxy').click();
    await window.waitForFunction(() => document.querySelector('#status-label').textContent === '运行中');
    const second = await fetch('http://127.0.0.1:18102/api/orders');
    assert.equal((await second.json()).url, '/orders');
    await window.waitForFunction(() => document.querySelector('#log-list').textContent.includes('/orders'));
    assert.equal(await window.locator('.status-dot.running').count() >= 2, true);

    await window.locator('.proxy-card').first().click();
    await window.screenshot({ path: path.join(__dirname, 'running.png') });
    await window.locator('#open-global-headers').click();
    await window.locator('#add-global-header').click();
    await window.locator('#global-headers-editor .header-name').fill('X-Global-Token');
    await window.locator('#global-headers-editor .header-value').fill('global-ui-token');
    await window.locator('#add-global-header').click();
    await window.locator('#global-headers-editor .header-name').nth(1).fill('Authorization');
    await window.locator('#global-headers-editor .header-value').nth(1).fill('Bearer global-token');
    await window.locator('#save-global').click();
    await window.waitForSelector('#global-backdrop.hidden', { state: 'attached' });
    const shared = await fetch('http://127.0.0.1:18102/api/shared');
    const sharedData = await shared.json();
    assert.equal(sharedData.headers['x-global-token'], 'global-ui-token');
    assert.equal(sharedData.headers.authorization, 'Bearer global-token');
    await window.locator('#edit-proxy').click();
    await window.locator('#proxy-name').fill('AI 管理后台 · 已编辑');
    await window.locator('#add-header').click();
    await window.locator('#headers-editor .header-name').last().fill('Authorization');
    await window.locator('#headers-editor .header-value').last().fill('Bearer ui-secret-token');
    await window.locator('#add-header').click();
    await window.locator('#headers-editor .header-name').last().fill('Cookie');
    await window.locator('#headers-editor .header-value').last().fill('token=ui-cookie; userId=42');
    await window.locator('#save-proxy').click();
    await window.waitForSelector('#modal-backdrop.hidden', { state: 'attached' });
    await window.waitForFunction(() => document.querySelector('#detail-name').textContent.includes('已编辑'));
    const health = await fetch('http://127.0.0.1:18101/cgw/aiadmin/health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hello: 'relay' }) });
    assert.equal(health.status, 200);
    const healthData = await health.json();
    assert.equal(healthData.headers.authorization, 'Bearer ui-secret-token');
    assert.equal(healthData.headers.cookie, 'token=ui-cookie; userId=42');
    assert.equal(healthData.headers['x-global-token'], 'global-ui-token');
    await window.locator('#log-list [data-trace-id]').last().click();
    await window.waitForSelector('#trace-content:not(.hidden)');
    await window.waitForFunction(() => document.querySelector('#trace-response-headers').textContent.includes('x-backend'));
    assert.match(await window.locator('#trace-request-headers').textContent(), /已隐藏/);
    await window.locator('#toggle-sensitive').click();
    assert.match(await window.locator('#trace-request-headers').textContent(), /ui-secret-token/);
    assert.match(await window.locator('#trace-request-headers').textContent(), /ui-cookie/);
    assert.match(await window.locator('#trace-request-body').textContent(), /hello/);
    assert.match(await window.locator('#trace-response-body').textContent(), /ui-secret-token/);
    await window.screenshot({ path: path.join(__dirname, 'trace-detail.png') });
    await window.locator('#close-trace').click();

    await window.locator('.proxy-card').nth(1).click();
    await window.locator('#toggle-proxy').click();
    await window.waitForFunction(() => document.querySelector('#status-label').textContent === '未运行');
    await assert.rejects(fetch('http://127.0.0.1:18102/api/orders'));

    console.log('Electron UI 验证通过：多代理、转发、日志详情、全局 Header 继承与覆盖、编辑重启、独立停止。');
    console.log(`截图：${path.join(__dirname, 'running.png')}`);
  } finally {
    if (app) await app.close();
    for (const server of backends) await new Promise((resolve) => server.close(resolve));
    await fs.rm(userData, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
