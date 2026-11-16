'use strict';

const http = require('node:http');

const BLOCKED_HEADERS = new Set(['content-length', 'connection', 'transfer-encoding', 'upgrade', 'keep-alive', 'proxy-authenticate', 'trailer']);

function validateHeaders(input) {
  if (!Array.isArray(input) || input.length > 50) throw new Error('自定义 Header 最多支持 50 条。');
  const names = new Set();
  return input.map((header) => {
    const name = String(header.name || '').trim();
    const value = String(header.value ?? '').trim();
    if (!name && !value) return null;
    try {
      http.validateHeaderName(name);
      http.validateHeaderValue(name, value);
    } catch { throw new Error(`Header「${name || '未命名'}」的名称或值格式不正确。`); }
    if (BLOCKED_HEADERS.has(name.toLowerCase())) throw new Error(`不建议覆盖 ${name}，它会影响代理连接或请求体长度。`);
    if (value.length > 8192) throw new Error(`Header ${name} 的值不能超过 8192 个字符。`);
    if (names.has(name.toLowerCase())) throw new Error(`Header ${name} 重复，请只保留一条。`);
    names.add(name.toLowerCase());
    return { name, value, enabled: header.enabled !== false };
  }).filter(Boolean);
}

module.exports = { BLOCKED_HEADERS, validateHeaders };
