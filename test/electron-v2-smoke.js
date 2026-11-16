'use strict';

// Relay v2.0 界面冒烟测试（需要 Electron 和显示器，在 Windows 上运行：npm run test:ui:v2）。
// 覆盖：接口规则与 Mock/代理切换、动态数据预览、转为 Mock、项目、独立 Mock 服务、接口文档导入与生成、AI 设置与 AI 改写。
// 截图输出到 test/v2-*.png，便于人工检查界面。
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const http = require('node:http');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright-core');

const started = Date.now();
const step = (message) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);

(async () => {
  const root = path.join(os.tmpdir(), 'proxy', 'tmp');
  await fs.mkdir(root, { recursive: true });
  const userData = await fs.mkdtemp(path.join(root, 'relay-v2-smoke-'));

  const backendHits = [];
  const backend = http.createServer((req, res) => {
    backendHits.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ from: 'backend', url: req.url }));
  });
  await new Promise((resolve) => backend.listen(19201, '127.0.0.1', resolve));

  const fakeAi = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const prompt = JSON.parse(raw || '{}').messages?.[1]?.content || '';
      const text = prompt.includes('保持与样例完全相同') ? '{"svc":"{{bool}}","name":"{{name}}"}' : 'OK';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    });
  });
  await new Promise((resolve) => fakeAi.listen(19203, '127.0.0.1', resolve));

  const swaggerFile = path.join(userData, 'pets.json');
  await fs.writeFile(swaggerFile, JSON.stringify({
    swagger: '2.0', info: { title: '宠物店', version: '1.0' },
    paths: {
      '/pets': { get: { summary: '宠物列表', responses: { 200: { schema: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } } } } } } } },
      '/pets/{id}': { get: { summary: '宠物详情', responses: { 200: { schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } } } } },
    },
  }));

  const childEnv = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;

  let app;
  try {
    app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, '..'), `--user-data-dir=${userData}`, '--no-sandbox'], env: childEnv, timeout: 30000 });
    const window = await app.firstWindow();
    window.on('dialog', (dialog) => dialog.accept()); // 隐私确认 / 删除确认一律点“确定”
    await window.waitForLoadState('domcontentloaded');
    await window.waitForSelector('#welcome:not(.hidden)');
    const shot = (name) => window.screenshot({ path: path.join(__dirname, `v2-${name}.png`) });
    const hidden = (selector) => window.waitForSelector(`${selector}.hidden`, { state: 'attached' });
    const eventually = async (fn, label) => {
      const deadline = Date.now() + 8000;
      let last;
      while (Date.now() < deadline) { try { last = await fn(); if (last) return last; } catch (err) { last = err; } await new Promise((r) => setTimeout(r, 100)); }
      throw new Error(`等待超时：${label}${last instanceof Error ? `（${last.message}）` : ''}`);
    };
    const json = async (url, init) => (await fetch(url, init)).json();
    const startSelected = async () => {
      await window.locator('#toggle-proxy').click();
      await window.waitForFunction(() => document.querySelector('#status-label').textContent === '运行中');
    };
    const addItem = async (name, port, extra = async () => {}) => {
      await window.locator('#add-proxy').click();
      await window.locator('#proxy-name').fill(name);
      await window.locator('#proxy-port').fill(String(port));
      await extra();
      await window.locator('#save-proxy').click();
      await hidden('#modal-backdrop');
    };
    const addRule = async (rulePath, body) => {
      await window.locator('#add-rule').click();
      await window.locator('#rule-path').fill(rulePath);
      await window.locator('#rule-body').fill(body);
      await window.locator('#save-rule').click();
      await hidden('#rule-backdrop');
    };

    // 1. 代理 + 规则 + Mock/代理切换
    await addItem('v2 代理', 18201, async () => {
      await window.locator('#proxy-target').fill('http://127.0.0.1:19201');
      await window.locator('#proxy-prefix').fill('/api');
    });
    await window.locator('.proxy-card').first().click();
    await startSelected();
    await addRule('/hello', '{"v":1}');
    await window.waitForFunction(() => document.querySelector('#rules-count').textContent === '1');
    assert.deepEqual(await json('http://127.0.0.1:18201/api/hello'), { v: 1 });
    assert.equal(backendHits.length, 0, 'Mock 请求不应到达后端');
    await window.waitForFunction(() => document.querySelector('#log-list').textContent.includes('[MOCK]'));
    step('规则创建、Mock 即时生效、日志带 [MOCK]');

    await window.locator('.rule-row .mode-btn[data-mode="proxy"]').click();
    assert.equal((await eventually(async () => { const r = await json('http://127.0.0.1:18201/api/hello'); return r.from === 'backend' && r; }, '切回代理')).from, 'backend');
    await window.locator('.rule-row .mode-btn[data-mode="mock"]').click();
    await eventually(async () => (await json('http://127.0.0.1:18201/api/hello')).v === 1, '再切回 Mock');
    step('Mock / 代理 反复切换即时生效');

    // 2. 动态数据与预览
    await window.locator('.rule-row [data-rule-action="edit"]').click();
    await window.locator('#rule-dynamic').check();
    await window.locator('#rule-body').fill('{"n":"{{int 5 5}}","name":"{{name}}"}');
    await window.locator('#rule-preview').click();
    await window.waitForSelector('#rule-preview-result:not(.hidden)');
    assert.match(await window.locator('#rule-preview-result').textContent(), /"n": 5/);
    await shot('rule-editor');
    await window.locator('#save-rule').click();
    await hidden('#rule-backdrop');
    const dynamic = await eventually(async () => { const r = await json('http://127.0.0.1:18201/api/hello'); return r.n === 5 && r; }, '动态数据生效');
    assert.match(dynamic.name, /^[一-龥]{2,3}$/);
    step('动态数据预览与渲染');

    // 2b. 同一接口多个 Mock 场景，一键切换
    await window.locator('.rule-row [data-rule-action="edit"]').click();
    await window.locator('#rule-scenario-add').click();
    await window.locator('#rule-scenario-name').fill('服务器报错');
    await window.locator('#rule-status').fill('500');
    await window.locator('#rule-dynamic').uncheck();
    await window.locator('#rule-body').fill('{"err":"boom"}');
    await shot('rule-scenarios');
    await window.locator('#save-rule').click();
    await hidden('#rule-backdrop');
    await window.waitForSelector('.rule-row .scenario-select');
    assert.equal((await fetch('http://127.0.0.1:18201/api/hello')).status, 200, '新增场景不会自动启用');
    await window.locator('.rule-row .scenario-select').selectOption({ label: '服务器报错' });
    const failed = await eventually(async () => { const r = await fetch('http://127.0.0.1:18201/api/hello'); return r.status === 500 && r; }, '切换到报错场景');
    assert.deepEqual(await failed.json(), { err: 'boom' });
    await window.waitForFunction(() => document.querySelector('#log-list').textContent.includes('场景「服务器报错」'));
    await window.locator('.rule-row .scenario-select').selectOption({ label: '默认' });
    await eventually(async () => (await json('http://127.0.0.1:18201/api/hello')).n === 5, '切回默认场景');
    step('同一接口多个 Mock 场景：新增、切换、日志标出场景名');

    // 3. 请求详情 → 转为 Mock
    await json('http://127.0.0.1:18201/api/other');
    await window.waitForFunction(() => document.querySelector('#log-list').textContent.includes('/api/other'));
    await window.locator('#log-list [data-trace-id]').last().click();
    await window.waitForSelector('#trace-content:not(.hidden)');
    await window.waitForSelector('#trace-to-mock:not(.hidden)');
    await shot('trace-source');
    await window.locator('#trace-to-mock').click();
    await window.waitForSelector('#tm-backdrop:not(.hidden)');
    await window.waitForFunction(() => document.querySelector('#tm-body').value.includes('backend'));
    await window.locator('#tm-mode').selectOption('dynamic');
    await window.waitForFunction(() => !document.querySelector('#tm-save').disabled);
    await shot('trace-to-mock');
    await window.locator('#tm-mode').selectOption('fixed');
    await window.waitForFunction(() => !document.querySelector('#tm-save').disabled);
    await window.locator('#tm-save').click();
    await window.waitForFunction(() => document.querySelector('#rules-count').textContent === '2');
    step('请求详情：生成 Mock（预览、固定 / 动态模板、创建并启用）');

    // 4. 项目
    await window.locator('#project-add').click();
    await window.locator('#project-name').fill('第二个项目');
    await window.locator('#save-project').click();
    await hidden('#project-backdrop');
    assert.equal(await window.locator('.proxy-card').count(), 0);
    assert.equal(await window.locator('#project-select option').count(), 2);
    await shot('projects');
    await window.selectOption('#project-select', { index: 0 });
    await window.waitForFunction(() => document.querySelectorAll('.proxy-card').length === 1);
    step('项目新建与切换');

    // 5. 独立 Mock 服务（在第二个项目里创建，验证项目隔离）
    await window.selectOption('#project-select', { index: 1 });
    await window.locator('#kind-switch [data-kind="mock"]').click();
    await addItem('UI Mock 服务', 18202);
    await window.locator('.proxy-card').first().click();
    await startSelected();
    await addRule('/svc', '{"svc":true}');
    assert.deepEqual(await json('http://127.0.0.1:18202/svc'), { svc: true });
    assert.equal((await fetch('http://127.0.0.1:18202/none')).status, 404);
    await window.locator('#duplicate-mock').click();
    await window.waitForFunction(() => document.querySelectorAll('.proxy-card').length === 2);
    await shot('mock-service');
    step('独立 Mock 服务：创建、启动、规则、404、复制');

    // 6. 规则编辑框里的 AI 改写（只产生候选，采用后才填入）
    await window.locator('#open-ai').click();
    await window.locator('#ai-base-url').fill('http://127.0.0.1:19203/v1');
    await window.locator('#ai-model').fill('fake-model');
    await window.locator('#ai-key').fill('sk-ui-smoke');
    await window.locator('#ai-test').click();
    await window.waitForSelector('#ai-status:not(.hidden)');
    assert.match(await window.locator('#ai-status').textContent(), /连接成功/);
    await shot('ai-settings');
    await window.locator('#ai-save').click();
    await hidden('#ai-backdrop');
    await window.locator('.proxy-card').first().click();
    await window.locator('.rule-row [data-rule-action="edit"]').click();
    await window.locator('#rule-ai-template').click();
    await window.waitForSelector('#rule-ai-candidate:not(.hidden)');
    assert.match(await window.locator('#rule-ai-result').textContent(), /\{\{name\}\}/);
    await window.locator('#rule-ai-accept').click();
    assert.equal(await window.locator('#rule-dynamic').isChecked(), true);
    await window.locator('#save-rule').click();
    await hidden('#rule-backdrop');
    step('AI 设置、测试连接、样例改写成模板');

    // 7. 接口文档：导入 → 勾选 → 本地生成预览 → 保存到 Mock 服务
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, swaggerFile);
    await window.locator('#open-docs').click();
    await window.locator('#docs-import-kind').selectOption('openapi');
    await window.locator('#docs-import').click();
    await window.waitForFunction(() => document.querySelectorAll('#docs-endpoints .doc-row').length === 2);
    await window.locator('#docs-check-all').check();
    await window.locator('#docs-target').selectOption({ label: 'Mock · UI Mock 服务' });
    await window.locator('#docs-gen-mode').selectOption('local-dynamic');
    await window.locator('#docs-generate').click();
    await window.waitForSelector('#docs-preview:not(.hidden)');
    assert.equal(await window.locator('.draft-card').count(), 2);
    await shot('docs-preview');
    await window.locator('#docs-apply').click();
    await window.waitForFunction(() => document.querySelector('#toast').textContent.includes('已保存'));
    const pets = await json('http://127.0.0.1:18202/pets');
    assert.ok(Array.isArray(pets) && pets.length >= 3, '动态模板的列表至少 3 条');
    await window.locator('#close-docs').click();
    step('接口文档导入、勾选、生成预览、保存、动态数据生效');

    await shot('final');
    console.log('Electron v2 界面验证通过。截图：test/v2-*.png');
  } finally {
    if (app) await app.close();
    await new Promise((resolve) => backend.close(resolve));
    await new Promise((resolve) => fakeAi.close(resolve));
    await fs.rm(userData, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
