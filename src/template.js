'use strict';

// Mock 动态数据模板：把 {{占位符}} 在每次请求时渲染成不同的随机值。纯本地运行，不依赖 AI。
//
// JSON Body：整个字符串值恰好是一个占位符时输出带类型的值（"{{int 1 9}}" → 5），
//            夹在文字中间时输出文本（"编号-{{int 1 9}}" → "编号-5"）。
//            数组的第一个元素写 "{{repeat 3 8}}"，其后的元素会被重复生成 3–8 轮。
// 非 JSON Body：只做文本替换。

const { randomUUID } = require('node:crypto');

const MAX_REPEAT = 100;
const MAX_NODES = 20_000;
const MAX_OUTPUT = 5 * 1024 * 1024;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const SOLE = /^\{\{\s*([^{}]*?)\s*\}\}$/;

const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董潘袁蔡蒋余于杜叶程魏苏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严武戴莫孔向汤';
const GIVEN = '伟芳娜敏静丽强磊军洋勇艳杰涛明超秀娟英华慧巧美淑惠珠雅芝玉萍红玲芬燕彩春兰洁梅琳云真雪荣爱霞香月媛瑞佳嘉琼珍莉桂晶妍茜秋珊婷婉瑾颖瑶怡荷丹蓉君琴蕊薇梦岚馨悦昭冰羽希宁欣晓欢枫芸菲伊舒';
const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '重庆', '长沙', '苏州'];
const TEXT_POOL = '的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工已话儿者向情部正名定女问力机给等几很业最间新什打便位因重被走电四第门相次东政海口使教西再平真听世气信北少关并内加化由却代军产入先山无常别间体通水直提表';

const GENERATORS = {
  uuid: { args: [0, 0], run: () => randomUUID() },
  int: { args: [0, 2], typed: true, run: (a, c) => { const [lo, hi] = range(a, 0, 100); return lo + Math.floor(c.rng() * (hi - lo + 1)); } },
  float: { args: [0, 3], typed: true, run: (a, c) => {
    const [lo, hi] = range(a.slice(0, 2), 0, 1);
    const digits = a[2] === undefined ? 2 : Number(a[2]);
    return Number((lo + c.rng() * (hi - lo)).toFixed(digits));
  } },
  bool: { args: [0, 0], typed: true, run: (a, c) => c.rng() < 0.5 },
  name: { args: [0, 0], run: (a, c) => pickChar(SURNAMES, c) + pickChar(GIVEN, c) + (c.rng() < 0.6 ? pickChar(GIVEN, c) : '') },
  phone: { args: [0, 0], run: (a, c) => `1${pickChar('3456789', c)}${digits(9, c)}` },
  email: { args: [0, 0], run: (a, c) => `${letters(6, c)}@example.com` },
  city: { args: [0, 0], run: (a, c) => CITIES[Math.floor(c.rng() * CITIES.length)] },
  text: { args: [0, 1], run: (a, c) => { let out = ''; for (let i = 0; i < (a[0] === undefined ? 10 : Number(a[0])); i += 1) out += pickChar(TEXT_POOL, c); return out; } },
  date: { args: [0, 2], run: (a, c) => formatDate(shiftDays(a, c), false) },
  datetime: { args: [0, 2], run: (a, c) => formatDate(shiftDays(a, c), true) },
  timestamp: { args: [0, 0], typed: true, run: () => Date.now() },
  pick: { args: [1, 50], run: (a, c) => a[Math.floor(c.rng() * a.length)] },
  seq: { args: [0, 1], typed: true, run: (a, c) => c.seq(c.path, a[0] === undefined ? 1 : Number(a[0])) }, // 每个占位符位置各自计数
};

function range(args, defLo, defHi) {
  return args.length ? [Number(args[0]), Number(args[1])] : [defLo, defHi];
}
function pickChar(pool, c) { return pool[Math.floor(c.rng() * pool.length)]; }
function digits(n, c) { let s = ''; for (let i = 0; i < n; i += 1) s += Math.floor(c.rng() * 10); return s; }
function letters(n, c) { return Array.from({ length: n }, () => pickChar('abcdefghijklmnopqrstuvwxyz', c)).join(''); }
function shiftDays(args, c) {
  const [lo, hi] = args.length ? [Number(args[0]), Number(args[1])] : [0, 0];
  return new Date(Date.now() + (lo + Math.floor(c.rng() * (hi - lo + 1))) * 86_400_000);
}
const pad = (n) => String(n).padStart(2, '0');
function formatDate(d, withTime) {
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : day;
}

const isNum = (v) => v !== undefined && v !== '' && Number.isFinite(Number(v));

/** 解析并校验一个占位符内容，返回 { name, args, ... }；非法时抛出明确的中文错误。 */
function parseToken(raw) {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const label = `{{${raw.trim()}}}`;
  if (!tokens.length) throw new Error('存在空的占位符 {{ }}。');
  const [name, ...args] = tokens;

  if (name.startsWith('params.') || name.startsWith('query.')) {
    const [scope, ...rest] = name.split('.');
    if (!rest.join('.') || args.length) throw new Error(`占位符 ${label} 格式应为 {{${scope}.字段名}}。`);
    return { kind: 'request', scope, key: rest.join('.') };
  }
  if (name === 'repeat') {
    if (args.length < 1 || args.length > 2 || !args.every(isNum)) throw new Error(`${label} 格式应为 {{repeat 次数}} 或 {{repeat 最少 最多}}。`);
    const [min, max] = [Number(args[0]), Number(args[args.length - 1])];
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || max > MAX_REPEAT) throw new Error(`${label} 的次数需为 0–${MAX_REPEAT} 的整数，且最少不大于最多。`);
    return { kind: 'repeat', min, max };
  }
  const gen = GENERATORS[name];
  if (!gen) throw new Error(`未知占位符 ${label}。可用：${[...Object.keys(GENERATORS), 'params.字段', 'query.字段', 'repeat'].join('、')}。`);
  const [lo, hi] = gen.args;
  if (args.length < lo || args.length > hi) throw new Error(`占位符 ${label} 的参数个数不正确。`);
  if (['int', 'float'].includes(name) && args.length && (args.length < 2 || !args.slice(0, 2).every(isNum) || Number(args[0]) > Number(args[1]))) throw new Error(`${label} 格式应为 {{${name} 最小值 最大值}}，且最小值不大于最大值。`);
  if (name === 'float' && args[2] !== undefined && !(Number.isInteger(Number(args[2])) && Number(args[2]) >= 0 && Number(args[2]) <= 10)) throw new Error(`${label} 的小数位数需为 0–10。`);
  if (name === 'text' && args[0] !== undefined && !(Number.isInteger(Number(args[0])) && Number(args[0]) >= 0 && Number(args[0]) <= 2000)) throw new Error(`${label} 的字数需为 0–2000 的整数。`);
  if (['date', 'datetime'].includes(name) && args.length && (args.length < 2 || !args.every((a) => Number.isInteger(Number(a))) || Number(args[0]) > Number(args[1]))) throw new Error(`${label} 格式应为 {{${name} 最早偏移天数 最晚偏移天数}}，例如 {{date -30 0}}。`);
  if (name === 'seq' && args[0] !== undefined && !Number.isInteger(Number(args[0]))) throw new Error(`${label} 的起始值需为整数。`);
  return { kind: 'gen', name, args, gen };
}

function evalToken(token, ctx) {
  if (token.kind === 'request') {
    const value = ctx[token.scope]?.[token.key];
    return value === undefined ? '' : Array.isArray(value) ? String(value[0]) : String(value);
  }
  if (token.kind === 'repeat') throw new Error('{{repeat}} 只能写在 JSON 数组的第一个元素。');
  return token.gen.run(token.args, ctx);
}

function interpolate(text, ctx) {
  const base = ctx.path;
  let index = 0;
  return text.replace(PLACEHOLDER, (all, raw) => {
    ctx.path = `${base}#${index++}`;
    return String(evalToken(parseToken(raw), ctx));
  });
}

function validateText(text) {
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (parseToken(match[1]).kind === 'repeat') throw new Error('{{repeat}} 只能写在 JSON 数组的第一个元素。');
  }
}

function validateTree(node) {
  if (typeof node === 'string') {
    const sole = node.match(SOLE);
    if (sole) { if (parseToken(sole[1]).kind === 'repeat') throw new Error('{{repeat}} 只能写在 JSON 数组的第一个元素。'); } else validateText(node);
  } else if (Array.isArray(node)) {
    const head = typeof node[0] === 'string' && node[0].match(SOLE);
    const repeat = head && parseToken(head[1]).kind === 'repeat';
    node.forEach((child, index) => { if (!(repeat && index === 0)) validateTree(child); });
  } else if (node && typeof node === 'object') Object.values(node).forEach(validateTree);
}

function renderTree(node, ctx, path = '$') {
  ctx.path = path;
  if (++ctx.nodes > MAX_NODES) throw new Error(`模板展开的节点过多（超过 ${MAX_NODES}），请减少 {{repeat}} 嵌套。`);
  if (typeof node === 'string') {
    const sole = node.match(SOLE);
    if (sole) {
      const token = parseToken(sole[1]);
      const value = evalToken(token, ctx);
      return token.kind === 'gen' && token.gen.typed ? value : String(value);
    }
    return interpolate(node, ctx);
  }
  if (Array.isArray(node)) {
    const head = typeof node[0] === 'string' && node[0].match(SOLE);
    const token = head && parseToken(head[1]);
    if (token?.kind === 'repeat') {
      const times = token.min + Math.floor(ctx.rng() * (token.max - token.min + 1));
      const out = [];
      for (let i = 0; i < times; i += 1) node.slice(1).forEach((child, at) => out.push(renderTree(child, ctx, `${path}[${at + 1}]`)));
      return out;
    }
    return node.map((child, at) => renderTree(child, ctx, `${path}[${at}]`));
  }
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, renderTree(value, ctx, `${path}.${key}`)]));
  }
  return node;
}

/**
 * 编译模板（同时校验所有占位符）。返回 { dynamic, render(request, options) }。
 * 没有任何占位符时 dynamic 为 false，渲染结果与原文一致。
 */
function compileTemplate(body) {
  const text = String(body ?? '');
  let tree;
  try { tree = JSON.parse(text); } catch { tree = undefined; }
  const isJson = tree !== undefined && tree !== null && typeof tree === 'object';
  if (isJson) validateTree(tree); else validateText(text);
  const counters = new Map(); // 占位符位置 → 下一个序号，跨请求保留
  return {
    isJson,
    dynamic: /\{\{[^{}]*\}\}/.test(text),
    render(request = {}, options = {}) {
      const ctx = {
        params: request.params || {}, query: request.query || {}, rng: options.rng || Math.random,
        seq: (key, start) => { const value = counters.get(key) ?? start; counters.set(key, value + 1); return value; }, nodes: 0, path: '$',
      };
      const out = isJson ? JSON.stringify(renderTree(tree, ctx)) : interpolate(text, ctx);
      if (Buffer.byteLength(out, 'utf8') > MAX_OUTPUT) throw new Error('渲染后的响应超过 5 MB，请减少 {{repeat}} 次数。');
      return out;
    },
  };
}

module.exports = { compileTemplate, GENERATOR_NAMES: Object.keys(GENERATORS) };
