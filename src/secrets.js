'use strict';

// AI API Key 的加密存储：只在主进程使用 Electron safeStorage（Windows 下为 DPAPI），不写入配置文件、日志或导出文件。

const path = require('node:path');
const fs = require('node:fs/promises');

const FILE = 'secrets.json';

async function readAll(dir) {
  try { return JSON.parse(await fs.readFile(path.join(dir, FILE), 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`${FILE} 已损坏，请删除后重新填写 API Key。`);
  }
}

async function writeAll(dir, data) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, FILE);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}

async function hasApiKey(dir) { return Boolean((await readAll(dir)).aiApiKey); }

async function saveApiKey(dir, key, safeStorage) {
  const value = String(key || '').trim();
  if (!value) { const data = await readAll(dir); delete data.aiApiKey; return writeAll(dir, data); }
  if (value.length > 500 || /\s/.test(value)) throw new Error('API Key 格式不正确（不能包含空白字符）。');
  if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('当前系统不支持安全存储，无法保存 API Key。');
  const data = await readAll(dir);
  data.aiApiKey = safeStorage.encryptString(value).toString('base64');
  return writeAll(dir, data);
}

async function loadApiKey(dir, safeStorage) {
  const encoded = (await readAll(dir)).aiApiKey;
  if (!encoded) return '';
  if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('当前系统不支持安全存储，无法读取 API Key。');
  try { return safeStorage.decryptString(Buffer.from(encoded, 'base64')); } catch { throw new Error('API Key 无法解密（可能来自另一台电脑或另一个用户），请重新填写。'); }
}

module.exports = { hasApiKey, saveApiKey, loadApiKey };
