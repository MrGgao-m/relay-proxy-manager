'use strict';

// Markdown 接口文档的本地识别（兜底方案，优先使用 AI 提取）。
// 原则：不静默猜测——识别不了的信息进入 needsConfirm，由用户确认后才生成 Mock。

const { toRulePath } = require('./openapi');

const METHOD = '(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)';
const INLINE = new RegExp(`\\b${METHOD}\\b\\s*[:：]?\\s*\`?(/[^\\s\`|)]*)`, 'i');
const METHOD_LINE = new RegExp(`(?:请求方式|请求方法|方法|Method)\\s*[:：|]?\\s*\`?${METHOD}\\b`, 'i');
const URL_LINE = /(?:请求地址|接口地址|请求路径|接口路径|路径|URL|Url|地址)\s*[:：|]?\s*`?(\/[^\s`|)]*)/;
const REQUEST_LABEL = /请求(参数|示例|体|body)|request/i;
const RESPONSE_LABEL = /响应|返回|response|result/i;

/**
 * 把文档里“像 JSON 的示例”整理成合法 JSON：去掉 // 和 /* *\/ 注释（字符串里的 // 不动）、
 * 去掉省略号 ...（含 […]、{…}）、清理多余逗号。返回 { text, dropped }，dropped 表示省略号被当作空处理。
 */
function repairJson(text) {
  const strings = [];
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\') j += 1; j += 1; }
      if (j >= text.length) return null; // 字符串没有结束，无法整理
      strings.push(text.slice(i, j + 1));
      out += `"@@${strings.length - 1}@@"`;
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else { out += c; i += 1; }
  }
  const dropped = /\.\.\.|…/.test(out);
  out = out.replace(/\.\.\.|…/g, '');
  let previous;
  do {
    previous = out;
    out = out.replace(/,(\s*,)+/g, ',').replace(/([[{])\s*,/g, '$1').replace(/,\s*([\]}])/g, '$1');
  } while (out !== previous);
  return { text: out.replace(/"@@(\d+)@@"/g, (_, n) => strings[Number(n)]), dropped };
}

function parseJsonLoose(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { /* 再尝试整理后解析 */ }
  const repaired = repairJson(text);
  if (repaired) { try { return { ok: true, value: JSON.parse(repaired.text), dropped: repaired.dropped }; } catch { /* 无法整理 */ } }
  return { ok: false };
}

function parseTable(lines, start) {
  const rows = [];
  for (let i = start; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) {
    const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
  }
  return rows;
}

function paramsFromTable(rows) {
  if (rows.length < 2) return [];
  const header = rows[0].map((c) => c.toLowerCase());
  const col = (patterns) => header.findIndex((c) => patterns.some((p) => c.includes(p)));
  const name = col(['参数', '字段', '名称', 'name', 'param', 'field']);
  if (name < 0) return [];
  const type = col(['类型', 'type']);
  const required = col(['必填', '必须', 'required']);
  const desc = col(['说明', '描述', 'desc', '备注']);
  return rows.slice(1).filter((r) => r[name]).map((r) => ({
    name: r[name].replace(/`/g, ''), in: 'query', type: type >= 0 ? r[type] || 'string' : 'string',
    required: required >= 0 && /^(是|y|yes|true|必填|必须|✓|√)$/i.test(r[required] || ''), description: desc >= 0 ? r[desc] || '' : '',
  }));
}

function splitSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence && line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (heading) {
      current = { level: heading[1].length, title: heading[2].replace(/^[\d.、\s]+/, '').trim(), line: index + 1, lines: [] };
      sections.push(current);
    } else if (current) current.lines.push(line);
  });
  return sections;
}

const GENERIC_TITLE = /^(请求信息|接口信息|基本信息|基础信息|接口说明|说明|概述|简介|详情|请求|request|info)$/i;

const ALL_INLINE = new RegExp(`\\b${METHOD}\\b\\s*[:：]?\\s*\`?(/[^\\s\`|)]*)`, 'gi');

/** 章节自己的文字里出现 2 个以上不同的 METHOD /path：这是“接口一览”之类的目录，不是某个接口本身。 */
function listedPaths(text) {
  const found = new Map();
  for (const m of text.replace(/\*\*|__/g, '').matchAll(ALL_INLINE)) found.set(`${m[1].toUpperCase()} ${m[2]}`, { method: m[1].toUpperCase(), path: m[2] });
  return [...found.values()];
}

/** 文档写“统一前缀 `X`”时，标题里的短路径（/appOps/biz）与 X 末尾重叠：把它们接起来。 */
function resolveWithPrefix(path, prefix) {
  if (!prefix || path.startsWith(`${prefix}/`) || path === prefix) return path;
  const pre = prefix.split('/').filter(Boolean);
  const seg = path.split('/').filter(Boolean);
  for (let k = Math.min(pre.length, seg.length); k >= 1; k -= 1) {
    if (pre.slice(-k).join('/') === seg.slice(0, k).join('/')) return `/${[...pre, ...seg.slice(k)].join('/')}`;
  }
  return path;
}

function findMethodAndPath(raw) {
  const text = raw.replace(/\*\*|__/g, ''); // 去掉加粗符号：**请求方式**：GET
  const inline = text.match(INLINE);
  if (inline) return { method: inline[1].toUpperCase(), rawPath: inline[2] };
  const method = text.match(METHOD_LINE)?.[1]?.toUpperCase();
  const rawPath = text.match(URL_LINE)?.[1];
  return method && rawPath ? { method, rawPath } : null;
}

/** 把章节分组：含 Method + 路径的章节是一个接口，其下更深层级的子章节并入该接口。 */
function groupEndpoints(sections) {
  const groups = [];
  const stack = []; // 祖先标题，用来给“请求信息”之类的通用小标题找名字
  let holder = null;
  const unmatched = [];
  const overviewPaths = [];
  for (const section of sections) {
    while (stack.length && stack[stack.length - 1].level >= section.level) stack.pop();
    const ownText = `${section.title}\n${section.lines.join('\n')}`;
    const listed = listedPaths(ownText);
    if (listed.length >= 2 && !(holder && section.level > holder.level)) {
      // “接口一览”目录：不是接口本身，但它写的是完整路径，用来补全各章节里的短路径
      overviewPaths.push(...listed.map((item) => toRulePath(item.path.replace(/[`，。,;；]+$/, ''))));
      holder = null;
      stack.push(section);
      continue;
    }
    const hit = findMethodAndPath(ownText);
    if (hit && !(holder && section.level > holder.level)) {
      const parent = stack[stack.length - 1];
      holder = { ...section, ...hit, title: GENERIC_TITLE.test(section.title) && parent ? parent.title : section.title, lines: [...section.lines] };
      groups.push(holder);
    } else if (holder && section.level > holder.level) {
      holder.lines.push(`${'#'.repeat(section.level)} ${section.title}`, ...section.lines);
    } else {
      holder = null;
      unmatched.push(section);
    }
    stack.push(section);
  }
  return { groups, unmatched, overviewPaths };
}

/** 返回 { endpoints, skipped, warnings }：skipped 是看起来像接口、但找不到 Method / 路径的章节。 */
function parseMarkdownDoc(text) {
  if (Buffer.byteLength(text, 'utf8') > 10 * 1024 * 1024) throw new Error('文档超过 10 MB，已拒绝导入。');
  const endpoints = [];
  const skipped = [];
  const seen = new Set();
  const { groups, unmatched, overviewPaths } = groupEndpoints(splitSections(text));
  const docPrefix = text.match(/统一前缀[^`\n]*`(\/[^`\s]+)`/)?.[1]?.replace(/\/$/, '') || '';

  for (const section of unmatched) {
    const body = section.lines.join('\n');
    if (/```/.test(body) && /接口|api/i.test(`${section.title}\n${body}`)) skipped.push({ title: section.title, line: section.line, reason: '没有识别到请求方法和路径' });
  }

  for (const section of groups) {
    const written = toRulePath(section.rawPath.replace(/<([^>]+)>/g, '{$1}').replace(/[`，。,;；]+$/, ''));
    const method = section.method;
    // 标题里写的可能是短路径：优先用“接口一览”里的完整路径，其次用“统一前缀”补全
    const suffixMatches = overviewPaths.filter((full) => full !== written && full.endsWith(written));
    const path = suffixMatches.length === 1 ? suffixMatches[0] : resolveWithPrefix(written, docPrefix);
    const id = `${method} ${path}`;
    if (seen.has(id)) { skipped.push({ title: section.title, line: section.line, reason: `与前面的 ${id} 重复` }); continue; }
    seen.add(id);

    const needsConfirm = [];
    if (path !== written) needsConfirm.push(`路径已按文档的${suffixMatches.length === 1 ? '「接口一览」' : '「统一前缀」'}补全为 ${path}（文档标题写的是 ${written}）`);
    const lines = section.lines;
    let params = [];
    const fences = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\s*\|/.test(lines[i]) && !params.length) {
        const rows = parseTable(lines, i);
        const found = paramsFromTable(rows);
        if (found.length) params = found;
        i += rows.length;
      }
      if (/^\s*```/.test(lines[i])) {
        const label = lines.slice(Math.max(0, i - 3), i).join(' ');
        const buf = [];
        let j = i + 1;
        while (j < lines.length && !/^\s*```/.test(lines[j])) { buf.push(lines[j]); j += 1; }
        fences.push({ label, content: buf.join('\n') });
        i = j;
      }
    }

    let response = fences.filter((f) => RESPONSE_LABEL.test(f.label) && !REQUEST_LABEL.test(f.label))[0];
    const requestExample = fences.find((f) => REQUEST_LABEL.test(f.label) && !RESPONSE_LABEL.test(f.label));
    if (!response && fences.length === 1 && !requestExample) { response = fences[0]; needsConfirm.push('只有一个代码块，无法确定它是响应示例，请确认'); }
    const responses = [];
    if (response) {
      const parsed = parseJsonLoose(response.content);
      if (parsed.ok) {
        responses.push({ status: 200, description: '', example: parsed.value });
        if (parsed.dropped) needsConfirm.push('示例里的省略号（...）已按空处理，被省略的内容需要自行补充');
      } else if (/^\s*[{[]/.test(response.content)) {
        // 明显是 JSON 却无法整理：不能把带注释的原文当成响应返回，否则前端解析必然失败
        needsConfirm.push('响应示例看起来是 JSON，但无法解析（请检查括号、引号），将生成空对象；可以改用 AI 提取');
      } else responses.push({ status: 200, description: '', example: response.content }); // 纯文本响应
    } else needsConfirm.push('没有找到响应示例，将生成空对象');
    needsConfirm.push('状态码未在文档中声明，按 200 处理');

    let requestBody = null;
    if (requestExample) { const parsed = parseJsonLoose(requestExample.content); requestBody = { example: parsed.ok ? parsed.value : requestExample.content }; }
    endpoints.push({ id, method, path, summary: section.title, tags: [], params, requestBody, responses, successStatus: 200, needsConfirm });
  }
  const warnings = [];
  if (!endpoints.length) warnings.push('没有识别到任何接口。可以改用 AI 提取，或检查标题下是否写有「POST /path」或「请求方式 / 请求地址」。');
  return { endpoints, skipped, warnings };
}

module.exports = { parseMarkdownDoc };
