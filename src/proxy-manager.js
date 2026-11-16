'use strict';

const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { validateHeaders } = require('./validators');
const { validateRules, compilePattern, matchRule, explainMiss } = require('./rules');
const { compileTemplate } = require('./template');

const MAX_DURATION = 30_000;
const MAX_BODY_PREVIEW = 256 * 1024;
const DEFAULT_PROJECT = '__default__';
// Mock 的 Body 存的是明文，长度和编码由服务端决定，规则里的这些 Header 一律忽略
const MOCK_SKIP_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection']);
/** 带凭证（withCredentials / Cookie）的跨域请求要求 Allow-Origin 为具体 Origin 而不能是 *，并且必须有 Allow-Credentials: true；无 Origin 的请求仍用 *。 */
function corsOriginHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return { 'Access-Control-Allow-Origin': '*' };
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' };
}
function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口需为 1–65535 之间的整数。');
  return port;
}

const DEFAULT_HOST = 'localhost';
/** 本机地址：localhost 或 IP（含 0.0.0.0 / ::）；留空视为默认的 localhost。 */
function validateHost(value) {
  const host = String(value ?? '').trim().replace(/^\[(.*)\]$/, '$1') || DEFAULT_HOST;
  if (host.toLowerCase() === 'localhost') return DEFAULT_HOST;
  if (!net.isIP(host)) throw new Error('本机 IP 格式不正确，请填写 localhost 或 IP 地址，例如 192.168.1.10。');
  return host;
}
/** 实际监听地址：localhost 固定绑定 127.0.0.1，避免 Node 解析到 ::1 而让 127.0.0.1 访问不通。 */
function listenHost(host) { return !host || host === DEFAULT_HOST ? '127.0.0.1' : host; }
/** 对外展示的访问地址主机部分：通配地址显示为 localhost，IPv6 加方括号。 */
function displayHost(host) {
  if (!host || host === '0.0.0.0' || host === '::') return DEFAULT_HOST;
  return net.isIPv6(host) ? `[${host}]` : host;
}

/** 独立 Mock 服务：独立端口，包含多个 Mock 接口；规则的模式一律为 mock。 */
function validateMockService(input, currentId) {
  const name = String(input.name || '').trim();
  if (!name || name.length > 40) throw new Error('请输入不超过 40 个字符的 Mock 服务名称。');
  return {
    id: currentId || randomUUID(), kind: 'mock', name, host: validateHost(input.host), port: validatePort(input.port),
    autoStart: Boolean(input.autoStart), cors: true,
    rules: validateRules(input.rules).map((rule) => ({ ...rule, mode: 'mock' })),
  };
}

function validateProxy(input, currentId) {
  const name = String(input.name || '').trim();
  const target = String(input.target || '').trim();
  const prefix = String(input.prefix || '/proxy').trim();
  const port = Number(input.port);

  if (!name || name.length > 40) throw new Error('请输入不超过 40 个字符的代理名称。');
  validatePort(port);
  let url;
  try { url = new URL(target); } catch { throw new Error('后端地址格式不正确，需包含 http:// 或 https://。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('后端地址只支持 HTTP / HTTPS，例如 http://10.0.7.33:8106。');
  if (url.username || url.password) throw new Error('后端地址不能包含账号或密码。');
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname.endsWith('/'))) throw new Error('后端地址末尾不能带 /、查询参数或 # 锚点。');
  if (prefix === '/' || !/^\/[a-zA-Z0-9/_-]*$/.test(prefix) || prefix.endsWith('/') || prefix.includes('//')) throw new Error('路径前缀须以 / 开头，末尾不带 /，例如 /cgw/aiadmin。');

  return {
    id: currentId || randomUUID(), name, host: validateHost(input.host), port, target: url.origin, prefix,
    stripPrefix: input.stripPrefix !== false,
    autoStart: Boolean(input.autoStart),
    headers: validateHeaders(Array.isArray(input.headers) ? input.headers : []),
    cors: true,
    rules: validateRules(input.rules),
  };
}

function captureBody(stream, encoding = '', retainAll = false) {
  const capture = { chunks: [], size: 0, total: 0, truncated: false, complete: false, raw: null };
  const limit = retainAll ? Number.POSITIVE_INFINITY : MAX_BODY_PREVIEW;
  stream.on('data', (chunk) => {
    capture.total += chunk.length;
    if (capture.size < limit) {
      const room = limit - capture.size; // 按声明的上限精确截断，而不是整块累计
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      capture.chunks.push(piece);
      capture.size += piece.length;
      if (piece.length < chunk.length) capture.truncated = true;
    } else capture.truncated = true;
  });
  stream.on('end', () => {
    capture.complete = true;
    if (capture.total > MAX_BODY_PREVIEW) capture.truncated = true;
    let buffer = Buffer.concat(capture.chunks, capture.size);
    capture.raw = retainAll ? buffer : null;
    try {
      if (encoding === 'gzip') buffer = zlib.gunzipSync(buffer);
      else if (encoding === 'deflate') buffer = zlib.inflateSync(buffer);
      else if (encoding === 'br') buffer = zlib.brotliDecompressSync(buffer);
    } catch {
      capture.failed = true;
      capture.body = `[压缩内容解压失败或预览不完整，已接收 ${capture.total} 字节]`;
      return;
    }
    capture.body = buffer.toString('utf8');
    capture.binary = capture.body.includes('\u0000');
    if (capture.binary) capture.body = `[二进制内容，共 ${capture.total} 字节，不提供文本预览]`;
  });
  return capture;
}

function inPrefix(url, prefix) {
  return url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`);
}

function previewCapture(buffer) {
  const total = buffer.length;
  const slice = total > MAX_BODY_PREVIEW ? buffer.subarray(0, MAX_BODY_PREVIEW) : buffer;
  let body = slice.toString('utf8');
  const binary = body.includes('\u0000');
  if (binary) body = `[二进制内容，共 ${total} 字节，不提供文本预览]`;
  return { total, truncated: total > MAX_BODY_PREVIEW, complete: true, binary, body };
}

const SOURCE_LABEL = { MOCK: '[MOCK] ', PROXY: '[PROXY] ' };

class ProxyManager {
  constructor(onLog, onState, onTrace) {
    this.running = new Map();
    this.projectHeaders = new Map();
    this.rules = new Map();
    this.onLog = onLog;
    this.onState = onState;
    this.onTrace = onTrace || (() => {});
  }

  log(id, level, event, message, data = {}) {
    this.onLog({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      proxyId: id, time: new Date().toISOString(), level, event, message, ...data,
    });
  }

  isRunning(id) { return this.running.has(id); }
  status() { return [...this.running.keys()]; }

  setProjectHeaders(projectId, headers) { this.projectHeaders.set(projectId || DEFAULT_PROJECT, validateHeaders(headers)); }
  setGlobalHeaders(headers) { this.setProjectHeaders(DEFAULT_PROJECT, headers); }
  effectiveHeaders(config) {
    const merged = new Map();
    for (const header of this.projectHeaders.get(config.projectId || DEFAULT_PROJECT) || []) merged.set(header.name.toLowerCase(), header);
    for (const header of config.headers) merged.set(header.name.toLowerCase(), header);
    return [...merged.values()];
  }

  /** 运行中即时生效：中间件每次请求都从这里读取规则，无需重启。 */
  setRules(id, rules) {
    this.rules.set(id, (rules || []).map((rule) => ({
      ...rule, pattern: compilePattern(rule.path),
      template: rule.response.dynamic ? compileTemplate(rule.response.body) : null, // 序号 {{seq}} 随规则实例保留，规则更新后重新计数
    })));
  }

  // ---------- 请求处理管线：日志/CORS → 请求体缓冲 → Mock → 代理 → 兜底 ----------

  _loggingMiddleware(config) {
    return (req, res, next) => {
      const requestStart = process.hrtime.bigint();
      const traceId = randomUUID();
      req.relayLog = { traceId, method: req.method, path: req.originalUrl, startedAt: Date.now() };
      const requestBody = captureBody(req);
      req.relayBufferedRequest = null;
      if (req.headers['content-length'] || req.headers['transfer-encoding']) {
        req.relayBufferedRequest = new Promise((resolve, reject) => {
          const chunks = [];
          let total = 0;
          req.on('data', (chunk) => { chunks.push(chunk); total += chunk.length; });
          req.on('end', () => resolve({ buffer: Buffer.concat(chunks, total), total }));
          req.on('error', reject);
        });
      }
      const trace = {
        id: traceId, proxyId: config.id, startedAt: new Date().toISOString(), source: null, ruleId: null, scenario: null, missReason: null,
        request: { method: req.method, url: req.originalUrl, httpVersion: req.httpVersion, headers: { ...req.headers }, body: requestBody },
        response: null, error: null,
      };
      req.relayTrace = trace;
      this.onTrace(trace);

      for (const [name, value] of Object.entries(corsOriginHeaders(req))) res.header(name, value);
      res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.header('Access-Control-Allow-Headers', req.header('Access-Control-Request-Headers') || 'Content-Type,Authorization,Cookie,X-Token');
      res.header('Access-Control-Expose-Headers', '*');
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - requestStart) / 1e6;
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'success';
        const label = SOURCE_LABEL[req.relayLog.source] || '';
        this.log(config.id, level, 'response', `${label}${req.method} ${req.originalUrl} → ${res.statusCode} · ${ms.toFixed(0)} ms`, {
          ...req.relayLog, status: res.statusCode, duration: Math.round(ms),
        });
      });
      if (req.method === 'OPTIONS') {
        req.relayLog.type = 'CORS 预检';
        // Chrome 的私有网络访问（PNA）预检：页面来自非本机来源访问本地代理时需要此头
        if (req.header('Access-Control-Request-Private-Network') === 'true') res.header('Access-Control-Allow-Private-Network', 'true');
        return res.sendStatus(204);
      }
      next();
    };
  }

  _bodyBufferMiddleware() {
    return async (req, res, next) => {
      if (!req.relayBufferedRequest) return next();
      try {
        const body = await req.relayBufferedRequest;
        req.relayBufferedBody = body;
        req.relayTrace.request.body.raw = body.buffer;
        next();
      } catch (err) { next(err); }
    };
  }

  _mockMiddleware(config) {
    const prefix = config.kind === 'mock' ? '' : config.prefix; // 独立 Mock 服务没有代理前缀
    return (req, res, next) => {
      const rules = this.rules.get(config.id);
      if (!rules || !rules.length || !inPrefix(req.originalUrl, prefix)) return next();
      // 规则按“去掉代理前缀、去掉查询串”的路径匹配，与 stripPrefix 无关
      const relative = req.originalUrl.slice(prefix.length) || '/';
      const hit = matchRule(rules, req.method, relative);
      if (!hit) { req.relayMiss = explainMiss(rules, req.method, relative, config.prefix); return next(); }
      req.relayRule = hit.rule;
      if (hit.rule.mode !== 'mock') { req.relayMiss = `命中规则「${hit.rule.method} ${hit.rule.path}」，但它的当前模式是「代理」，请切换为 Mock`; return next(); } // 显式“代理”规则：照常转发
      this._respondMock(config, hit, req, res);
    };
  }

  _respondMock(config, { rule, params }, req, res) {
    const spec = rule.response;
    let text = spec.body;
    if (rule.template) {
      try { text = rule.template.render({ params, query: req.query }); }
      catch (err) {
        this.log(config.id, 'error', 'error', `[MOCK] ${req.method} ${req.originalUrl}：模板渲染失败：${err.message}`, { ...req.relayLog, source: 'MOCK', error: err.message });
        return res.status(500).json({ error: 'Mock 模板渲染失败', message: err.message });
      }
    }
    const buffer = Buffer.from(text, spec.bodyEncoding === 'base64' ? 'base64' : 'utf8');
    const scenario = rule.alternatives?.length ? rule.scenario.name : null; // 只有配置了多个场景时才在日志里标出场景名
    const where = `本地规则 ${rule.method} ${rule.path}${scenario ? ` · 场景「${scenario}」` : ''}`;
    req.relayLog = { ...req.relayLog, type: 'Mock 响应', source: 'MOCK', ruleId: rule.id, scenario, target: where };
    req.relayTrace.source = 'MOCK';
    req.relayTrace.ruleId = rule.id;
    req.relayTrace.scenario = scenario;
    this.log(config.id, 'info', 'request', `[MOCK] ${req.method} ${req.originalUrl} → ${where}`, req.relayLog);

    const send = () => {
      for (const header of spec.headers) {
        if (header.enabled && !MOCK_SKIP_HEADERS.has(header.name.toLowerCase())) res.setHeader(header.name, header.value);
      }
      if (buffer.length && !res.getHeader('content-type')) {
        let json = false;
        if (spec.bodyEncoding !== 'base64') { try { JSON.parse(text); json = true; } catch { /* 按文本处理 */ } }
        res.setHeader('Content-Type', json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
      }
      res.statusCode = spec.status;
      res.setHeader('Content-Length', buffer.length);
      req.relayTrace.response = {
        status: spec.status, statusText: http.STATUS_CODES[spec.status] || '', httpVersion: '1.1',
        headers: Object.fromEntries(Object.entries(res.getHeaders()).map(([k, v]) => [k, v])),
        body: previewCapture(buffer),
      };
      res.end(req.method === 'HEAD' ? undefined : buffer);
    };
    if (spec.delayMs > 0) {
      const timer = setTimeout(send, spec.delayMs);
      res.on('close', () => clearTimeout(timer)); // 客户端断开或服务停止时取消挂起的响应
    } else send();
  }

  _proxyMiddleware(config) {
    return createProxyMiddleware({
      pathFilter: (pathname, req) => inPrefix(req.originalUrl, config.prefix),
      target: config.target, changeOrigin: true, xfwd: true, proxyTimeout: MAX_DURATION, timeout: MAX_DURATION,
      buffer: { pipe: (proxyReq) => { /* Body 由 proxyReq 显式写入，GET 请求由 proxyReq 默认结束 */ } },
      pathRewrite: (requestPath, req) => {
        const backendPath = config.stripPrefix ? requestPath.slice(config.prefix.length) || '/' : requestPath;
        req.relayLog = { ...req.relayLog, type: '代理请求', source: 'PROXY', ruleId: req.relayRule?.id || null, target: `${config.target}${backendPath}` };
        req.relayTrace.source = 'PROXY';
        req.relayTrace.ruleId = req.relayRule?.id || null;
        req.relayTrace.missReason = req.relayMiss || null;
        req.relayTrace.request.targetUrl = `${config.target}${backendPath}`;
        const why = req.relayMiss ? `（未走 Mock：${req.relayMiss}）` : '';
        this.log(config.id, req.relayMiss ? 'warn' : 'info', 'request', `[PROXY] ${req.method} ${req.originalUrl} → ${config.target}${backendPath}${why}`, { ...req.relayLog, missReason: req.relayMiss || null });
        return backendPath;
      },
      on: {
        proxyReq: (proxyReq, req) => {
          proxyReq.removeHeader('origin');
          for (const header of this.effectiveHeaders(config)) {
            if (header.enabled) proxyReq.setHeader(header.name, header.value);
          }
          req.relayTrace.request.outgoingHeaders = proxyReq.getHeaders();
          if (req.relayBufferedBody) {
            const body = req.relayBufferedBody;
            proxyReq.setHeader('content-length', body.total);
            if (body.total > 0) proxyReq.write(body.buffer);
            proxyReq.end();
          } else proxyReq.end();
        },
        proxyRes: (proxyRes, req) => {
          // 后端自带的 CORS 头一律以代理为准，避免重复值
          delete proxyRes.headers['access-control-allow-credentials'];
          for (const [name, value] of Object.entries(corsOriginHeaders(req))) {
            if (name === 'Vary') proxyRes.headers.vary = [...new Set([...String(proxyRes.headers.vary || '').split(',').map((v) => v.trim()).filter(Boolean), value])].join(', ');
            else proxyRes.headers[name.toLowerCase()] = value;
          }
          const encoding = String(proxyRes.headers['content-encoding'] || '').toLowerCase();
          req.relayTrace.response = {
            status: proxyRes.statusCode, statusText: proxyRes.statusMessage,
            httpVersion: proxyRes.httpVersion, headers: { ...proxyRes.headers },
            body: captureBody(proxyRes, encoding),
          };
        },
        error: (err, req, res) => {
          req.relayTrace.error = { message: err.message, code: err.code || 'PROXY_ERROR' };
          const why = req.relayMiss ? `；注意：该请求没有走 Mock（${req.relayMiss}）` : '';
          this.log(config.id, 'error', 'error', `[PROXY] ${req.method} ${req.originalUrl}：${err.message}${why}`, { ...req.relayLog, error: err.message, missReason: req.relayMiss || null });
          if (!res.headersSent) res.status(502).json({ error: '无法连接后端服务', target: config.target, message: err.message, ...(req.relayMiss ? { hint: `该请求没有走 Mock：${req.relayMiss}` } : {}) });
          else if (!res.writableEnded) res.end();
        },
      },
    });
  }

  _fallbackMiddleware(config) {
    return [
      config.kind === 'mock'
        ? (req, res) => {
          const rules = this.rules.get(config.id) || [];
          const hint = rules.length ? explainMiss(rules, req.method, req.path, '') : '这个 Mock 服务还没有配置任何接口规则';
          res.status(404).json({ error: '没有匹配的 Mock 接口', method: req.method, path: req.path, hint });
        }
        : (req, res) => res.status(404).json({ error: '没有匹配的代理路径', prefix: config.prefix }),
      (err, req, res, next) => {
        console.error('Relay proxy internal error:', err);
        this.log(config.id, 'error', 'error', `${req.method} ${req.originalUrl}：${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: '代理内部错误', message: err.message });
      },
    ];
  }

  async start(config) {
    if (this.running.has(config.id)) throw new Error('此代理已在运行。');
    const app = express();
    app.disable('x-powered-by');
    app.use(this._loggingMiddleware(config));
    app.use(this._bodyBufferMiddleware());
    app.use(this._mockMiddleware(config));
    if (config.kind !== 'mock') app.use(this._proxyMiddleware(config));
    app.use(...this._fallbackMiddleware(config));
    this.setRules(config.id, config.rules);

    const server = http.createServer(app);
    server.keepAliveTimeout = 35_000;
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.close();
        const host = config.host || DEFAULT_HOST;
        reject(new Error(err.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用，请换一个端口。`
          : err.code === 'EADDRNOTAVAIL' ? `本机没有 IP ${host}，请改成本机已有的 IP（或 0.0.0.0）。` : err.message));
      };
      server.once('error', onError);
      server.listen(config.port, listenHost(config.host), () => {
        server.off('error', onError);
        server.on('error', (err) => this.log(config.id, 'error', 'error', `服务异常：${err.message}`));
        resolve();
      });
    });
    this.running.set(config.id, { server, config });
    this.log(config.id, 'success', 'system', config.kind === 'mock'
      ? `Mock 服务已启动：http://${displayHost(config.host)}:${config.port}`
      : `代理已启动：http://${displayHost(config.host)}:${config.port}${config.prefix} → ${config.target}`);
    this.onState();
  }

  async stop(id) {
    const running = this.running.get(id);
    if (!running) return;
    this.running.delete(id);
    this.rules.delete(id);
    this.onState();
    await new Promise((resolve) => {
      running.server.close(resolve);
      if (typeof running.server.closeAllConnections === 'function') running.server.closeAllConnections();
    });
    this.log(id, 'info', 'system', `${running.config.kind === 'mock' ? 'Mock 服务' : '代理'}已停止，端口 ${running.config.port} 已释放。`);
  }

  async stopAll() { await Promise.all([...this.running.keys()].map((id) => this.stop(id))); }
}

module.exports = { ProxyManager, validateHost, validateProxy, validateMockService, validateHeaders };
