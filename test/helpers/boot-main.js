'use strict';

// 用假的 electron 模块驱动 src/main.js 真实的 IPC 处理器（不需要 Electron 和显示器）。
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const TMP_ROOT = path.join(os.tmpdir(), 'proxy', 'tmp');

/**
 * 启动一份全新的 main.js。传入 userData 可以“重启应用”：沿用同一个数据目录。
 * 返回 call（调用 IPC）、sent（发给窗口的消息）、dialogPaths（模拟文件对话框选择）、userData。
 */
async function boot(t, { userData: existing } = {}) {
  let userData = existing;
  if (!userData) {
    await fs.mkdir(TMP_ROOT, { recursive: true });
    userData = await fs.mkdtemp(path.join(TMP_ROOT, 'ipc-'));
    t.after(() => fs.rm(userData, { recursive: true, force: true }));
  }

  const handlers = new Map();
  const sent = [];
  const dialogPaths = {}; // 测试里设置 save / open 路径，模拟用户在文件对话框中的选择
  let startup;
  class BrowserWindow {
    constructor() { this.webContents = { send: (channel, data) => sent.push({ channel, data }), setWindowOpenHandler() {} }; }
    loadFile() {} once() {} show() {} isDestroyed() { return false; }
    static getAllWindows() { return []; }
  }
  const fake = {
    app: {
      getPath: () => userData, on() {}, quit() {}, exit() {},
      whenReady: () => ({ then: (fn) => { startup = Promise.resolve().then(fn); return startup; } }),
    },
    BrowserWindow,
    dialog: {
      showErrorBox() {},
      showSaveDialog: async () => ({ canceled: !dialogPaths.save, filePath: dialogPaths.save }),
      showOpenDialog: async () => ({ canceled: !dialogPaths.open, filePaths: dialogPaths.open ? [dialogPaths.open] : [] }),
    },
    // 可逆的假加密：只为了验证“密钥不会以明文落盘”
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`ENC:${[...s].reverse().join('')}`),
      decryptString: (b) => [...b.toString().slice(4)].reverse().join(''),
    },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  };
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === 'electron' ? fake : load.call(this, request, ...rest); };
  const mainPath = require.resolve('../../src/main');
  delete require.cache[mainPath];
  try { require(mainPath); } finally { Module._load = load; }
  await startup;

  const call = async (channel, ...args) => {
    const result = await handlers.get(channel)({}, ...args);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };
  const stopAll = async () => { for (const id of (await call('state:get')).running) await call('proxy:stop', id); };
  t.after(stopAll);
  return { call, sent, userData, dialogPaths, stopAll };
}

async function backend(t, port, handler) {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); handler(req, res); });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  t.after(() => server.close());
  return hits;
}

const json = (body) => (req, res) => { res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Backend', 'real'); res.end(JSON.stringify(body)); };
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const proxyInput = (over = {}) => ({ name: 'A', port: 18301, target: 'http://127.0.0.1:19301', prefix: '/api', ...over });

module.exports = { boot, backend, json, settle, proxyInput };
