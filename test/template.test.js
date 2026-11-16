'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileTemplate } = require('../src/template');
const { validateRule } = require('../src/rules');

function seeded(seed) { // 可复现的伪随机，保证测试稳定
  let a = seed;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const render = (body, request, seed = 1) => compileTemplate(typeof body === 'string' ? body : JSON.stringify(body)).render(request, { rng: seeded(seed) });

test('类型：整段占位符输出数字/布尔，夹在文字中输出文本', () => {
  const out = JSON.parse(render({ n: '{{int 18 80}}', f: '{{float 1 2 3}}', b: '{{bool}}', s: '编号-{{int 5 5}}', id: '{{uuid}}', ts: '{{timestamp}}' }));
  assert.equal(typeof out.n, 'number');
  assert.ok(out.n >= 18 && out.n <= 80);
  assert.equal(typeof out.f, 'number');
  assert.ok(out.f >= 1 && out.f <= 2);
  assert.equal(typeof out.b, 'boolean');
  assert.equal(out.s, '编号-5');
  assert.match(out.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.equal(typeof out.ts, 'number');
});

test('常用数据：姓名、手机号、邮箱、日期、枚举、文本', () => {
  const out = JSON.parse(render({ name: '{{name}}', phone: '{{phone}}', mail: '{{email}}', d: '{{date}}', dt: '{{datetime -1 0}}', gender: '{{pick 男 女}}', city: '{{city}}', t: '{{text 20}}' }));
  assert.match(out.name, /^[一-龥]{2,3}$/);
  assert.match(out.phone, /^1[3-9]\d{9}$/);
  assert.match(out.mail, /^[a-z]{6}@example\.com$/);
  assert.match(out.d, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(out.dt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.ok(['男', '女'].includes(out.gender));
  assert.ok(out.city.length >= 2);
  assert.equal([...out.t].length, 20);
});

test('每次渲染结果不同，相同种子结果相同（可复现）', () => {
  const body = { name: '{{name}}', n: '{{int 1 1000000}}' };
  const t = compileTemplate(JSON.stringify(body));
  assert.notEqual(t.render(), t.render());
  assert.equal(render(body, {}, 7), render(body, {}, 7));
  assert.notEqual(render(body, {}, 7), render(body, {}, 8));
});

test('repeat：数组首元素控制重复次数，其后元素逐轮展开；seq 递增', () => {
  const t = compileTemplate(JSON.stringify({ list: ['{{repeat 3 5}}', { no: '{{seq}}', start: '{{seq 100}}' }], fixed: ['{{repeat 2}}', 'a', 'b'] }));
  const sizes = new Set();
  let last = 0;
  for (let i = 0; i < 30; i += 1) {
    const out = JSON.parse(t.render());
    sizes.add(out.list.length);
    assert.ok(out.list.length >= 3 && out.list.length <= 5);
    assert.deepEqual(out.fixed, ['a', 'b', 'a', 'b']);
    for (const item of out.list) { assert.equal(item.no, last + 1); last = item.no; assert.equal(item.start, last + 99, '两个 seq 各自独立计数，起始值生效'); }
  }
  assert.ok(sizes.size > 1, '次数在范围内随机');
});

test('请求回显：路径参数与查询参数', () => {
  const out = JSON.parse(render({ id: '{{params.id}}', page: '{{query.page}}', none: '{{query.missing}}', mixed: '患者{{params.id}}' }, { params: { id: '42' }, query: { page: '3' } }));
  assert.deepEqual(out, { id: '42', page: '3', none: '', mixed: '患者42' });
});

test('非 JSON 与顶层字符串：只做文本替换，输出保持合法', () => {
  assert.equal(render('姓名：{{params.id}}', { params: { id: 'x' } }), '姓名：x');
  assert.equal(render('"{{int 7 7}}"'), '"7"');
  assert.equal(compileTemplate('{"a":1}').dynamic, false);
  assert.equal(compileTemplate('{"a":1}').render(), '{"a":1}');
});

test('特殊字符会被正确转义，输出始终是合法 JSON', () => {
  const out = JSON.parse(render({ s: '引号"和\\反斜杠{{params.id}}' }, { params: { id: 'a"b\n' } }));
  assert.equal(out.s, '引号"和\\反斜杠a"b\n');
});

test('保存时校验：未知占位符、参数错误、repeat 位置不对都会给出明确提示', () => {
  const bad = (body, pattern) => assert.throws(() => compileTemplate(JSON.stringify(body)), pattern);
  bad({ a: '{{nope}}' }, /未知占位符 \{\{nope\}\}/);
  bad({ a: '{{int 9 1}}' }, /最小值不大于最大值/);
  bad({ a: '{{int 1}}' }, /格式应为/);
  bad({ a: '{{int a b}}' }, /格式应为/);
  bad({ a: '{{float 1 2 99}}' }, /小数位数/);
  bad({ a: '{{date -1}}' }, /偏移天数/);
  bad({ a: '{{pick}}' }, /参数个数/);
  bad({ a: '{{params.}}' }, /格式应为/);
  bad({ a: '{{ }}' }, /空的占位符/);
  bad({ a: '{{repeat 3}}' }, /第一个元素/);
  bad({ a: ['x', '{{repeat 3}}'] }, /第一个元素/);
  bad({ a: ['{{repeat 101}}', 1] }, /0–100/);
  assert.throws(() => compileTemplate('文本 {{nope}}'), /未知占位符/);
});

test('资源上限：嵌套 repeat 展开过多会被拦截', () => {
  const t = compileTemplate(JSON.stringify(['{{repeat 100}}', ['{{repeat 100}}', ['{{repeat 100}}', 'x']]]));
  assert.throws(() => t.render(), /节点过多/);
});

test('规则校验：dynamic 默认关闭；开启时校验模板；Base64 不能开启', () => {
  const rule = (response) => validateRule({ method: 'GET', path: '/a', response });
  assert.equal(rule({ body: '{"a":"{{nope}}"}' }).response.dynamic, false, '未开启动态时，花括号按原文处理');
  assert.equal(rule({ body: '{"a":"{{int 1 2}}"}', dynamic: true }).response.dynamic, true);
  assert.throws(() => rule({ body: '{"a":"{{nope}}"}', dynamic: true }), /未知占位符/);
  assert.throws(() => rule({ body: 'AAAA', bodyEncoding: 'base64', dynamic: true }), /Base64/);
});
