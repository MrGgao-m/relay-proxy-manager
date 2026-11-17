'use strict';

// 接口调试（类似 Apifox 的「发送」）：对代理的某个环境发一次真实请求，返回后端的原始响应。
// 目标地址只来自代理自己配置的环境，渲染层只能选环境名，不能指定任意主机。

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { validateHeaders } = require('./validators');

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BODY_TYPES = { none: null, json: 'application/json', text: 'text/plain; charset=utf-8', form: 'application/x-www-form-urlencoded' };
const TIMEOUT_MS = 30_000;
const MAX_RESPONSE = 1024 * 1024;
const MAX_REQUEST_BODY = 2 * 1024 * 1024;
const MAX_QUERY = 100;

/** 校验并组装一次调试请求。baseHeaders 是代理 / 项目 Header（已按优先级合并），可被调试里写的同名 Header 覆盖。 */
function buildDebugRequest(proxy, baseHeaders, input) {
  const method = String(input?.method || 'GET').toUpperCase();
  if (!METHODS.includes(method)) throw new Error(`不支持的请求方法：${method}。`);

  const environments = proxy.environments || [];
  let target = proxy.target;
  let env = null;
  if (environments.length) {
    const name = input.env || proxy.activeEnv;
    const found = environments.find((e) => e.name === name);
    if (!found) throw new Error(`找不到环境「${name}」，请重新选择。`);
    target = found.target;
    env = found.name;
  }

  const path = String(input.path || '').trim();
  if (!path.startsWith('/')) throw new Error('接口路径需以 / 开头，例如 /patient/1。');
  if (path.includes('#')) throw new Error('接口路径不能包含 # 锚点。');
  const targetOrigin = new URL(target).origin;
  // 转发规则与真实请求一致：去掉前缀时后端看到的是接口路径本身，否则保留代理前缀
  let url;
  try { url = new URL(`${target}${proxy.stripPrefix ? '' : proxy.prefix}${path}`); }
  catch { throw new Error('接口路径格式不正确。'); }
  if (url.origin !== targetOrigin || url.username || url.password) throw new Error('接口路径格式不正确。');

  const query = Array.isArray(input.query) ? input.query : [];
  if (query.length > MAX_QUERY) throw new Error(`Query 参数最多支持 ${MAX_QUERY} 个。`);
  for (const item of query) {
    const name = String(item?.name ?? '').trim();
    if (item?.enabled === false || !name) continue;
    url.searchParams.append(name, String(item.value ?? ''));
  }

  // Header：代理 / 项目 Header 打底 → 调试里写的同名 Header 覆盖
  const merged = new Map();
  for (const h of baseHeaders || []) merged.set(h.name.toLowerCase(), { name: h.name, value: h.value });
  for (const h of validateHeaders(Array.isArray(input.headers) ? input.headers : [])) {
    if (h.enabled) merged.set(h.name.toLowerCase(), { name: h.name, value: h.value });
  }

  const bodyType = String(input.bodyType || 'none');
  if (!(bodyType in BODY_TYPES)) throw new Error('Body 类型不正确。');
  let body = null;
  if (bodyType !== 'none' && method !== 'GET' && method !== 'HEAD') {
    body = Buffer.from(String(input.body ?? ''), 'utf8');
    if (body.length > MAX_REQUEST_BODY) throw new Error('请求 Body 不能超过 2 MB。');
    if (!merged.has('content-type')) merged.set('content-type', { name: 'Content-Type', value: BODY_TYPES[bodyType] });
  }
  // 默认不压缩，响应可以直接当文本看；调试里显式写了 Accept-Encoding 则尊重
  if (!merged.has('accept-encoding')) merged.set('accept-encoding', { name: 'Accept-Encoding', value: 'identity' });
  if (!merged.has('accept')) merged.set('accept', { name: 'Accept', value: '*/*' });

  return { method, url: url.href, env, headers: [...merged.values()], body, timeoutMs: TIMEOUT_MS };
}

function describeError(err) {
  const code = err.code || 'REQUEST_ERROR';
  const hints = {
    ECONNREFUSED: '连接被拒绝，后端服务可能没有启动，或地址 / 端口不对',
    ENOTFOUND: '域名无法解析，请检查后端地址',
    ECONNRESET: '连接被后端中断',
    EHOSTUNREACH: '无法到达后端主机，请检查网络或 VPN',
    ETIMEDOUT: `请求超过 ${TIMEOUT_MS / 1000} 秒仍未完成`,
    DEPTH_ZERO_SELF_SIGNED_CERT: 'HTTPS 证书是自签名的，不受信任',
    CERT_HAS_EXPIRED: 'HTTPS 证书已过期',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'HTTPS 证书无法验证',
  };
  return { code, message: hints[code] ? `${hints[code]}（${code}）` : err.message };
}

function decode(buffer, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buffer);
    if (encoding === 'deflate') return zlib.inflateSync(buffer);
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
  } catch { return null; }
  return buffer;
}

/** 发送请求。网络错误不抛出，而是放进结果的 error 字段，界面才能同时显示「实际发出的请求」。 */
function sendDebugRequest(req) {
  const echo = {
    method: req.method, url: req.url, env: req.env, headers: req.headers.map((h) => ({ ...h })),
    body: req.body ? req.body.subarray(0, 64 * 1024).toString('utf8') : '', bodySize: req.body ? req.body.length : 0,
  };
  const started = process.hrtime.bigint();
  const elapsed = () => Math.round(Number(process.hrtime.bigint() - started) / 1e6);

  return new Promise((resolve) => {
    let settled = false;
    let clientRequest = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ request: echo, durationMs: elapsed(), ...result });
    };
    const fail = (err) => finish({ response: null, error: describeError(err) });
    const timer = setTimeout(() => {
      const err = Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' });
      clientRequest?.destroy();
      fail(err);
    }, req.timeoutMs);

    const url = new URL(req.url);
    const headers = {};
    for (const h of req.headers) headers[h.name] = h.value;
    if (req.body) headers['Content-Length'] = req.body.length;
    try {
      clientRequest = (url.protocol === 'https:' ? https : http).request(url, { method: req.method, headers }, (res) => {
        const chunks = [];
        let size = 0;
        let truncated = false;
        res.on('data', (chunk) => {
          if (truncated) return;
          size += chunk.length;
          if (size > MAX_RESPONSE) { // 超过上限就不再接收，避免大文件撑爆内存
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (size - MAX_RESPONSE)));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const done = () => {
          const raw = Buffer.concat(chunks);
          const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
          const plain = truncated && encoding ? null : decode(raw, encoding); // 截断的压缩流无法解压
          const response = {
            status: res.statusCode, statusText: res.statusMessage || http.STATUS_CODES[res.statusCode] || '', httpVersion: res.httpVersion,
            headers: res.rawHeaders.reduce((acc, value, i) => (i % 2 === 0 ? [...acc, { name: value, value: res.rawHeaders[i + 1] }] : acc), []),
            size: truncated ? MAX_RESPONSE : raw.length, truncated, binary: false, body: '',
          };
          if (!plain) response.body = `[压缩内容解压失败或预览不完整，已接收 ${raw.length} 字节]`;
          else {
            const text = plain.toString('utf8');
            response.binary = text.includes('\u0000');
            response.body = response.binary ? `[二进制内容，共 ${plain.length} 字节，不提供文本预览]` : text;
          }
          finish({ response, error: null });
        };
        res.on('end', done);
        res.on('close', () => { if (truncated) done(); else if (!res.complete) fail(Object.assign(new Error('响应未接收完整，连接被中断'), { code: 'ECONNRESET' })); });
        res.on('error', fail);
      });
    } catch (err) { return fail(err); }
    clientRequest.on('error', fail);
    clientRequest.end(req.body || undefined);
  });
}

module.exports = { buildDebugRequest, sendDebugRequest, METHODS, MAX_RESPONSE };
