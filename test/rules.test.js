'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRule, validateRules, matchRule, normalizePath, switchScenario, addScenario, explainMiss } = require('../src/rules');

const rule = (method, path, extra = {}) => ({ method, path, ...extra });

test('规则校验：默认值、规范化与非法输入', () => {
  const ok = validateRule(rule('get', '/patient/list/?page=1'));
  assert.equal(ok.method, 'GET');
  assert.equal(ok.path, '/patient/list');
  assert.equal(ok.mode, 'mock');
  assert.equal(ok.enabled, true);
  assert.equal(ok.response.status, 200);
  assert.equal(ok.response.delayMs, 0);
  assert.ok(ok.id);

  assert.throws(() => validateRule(rule('FETCH', '/a')), /请求方法/);
  assert.throws(() => validateRule(rule('GET', '/a/*/b')), /通配符/);
  assert.throws(() => validateRule(rule('GET', '/a/:1x')), /路径参数/);
  assert.throws(() => validateRule(rule('GET', '/a/:id/:id')), /重复/);
  assert.throws(() => validateRule(rule('GET', '/a', { mode: 'auto' })), /当前模式/);
  assert.throws(() => validateRule(rule('GET', '/a', { response: { status: 99 } })), /状态码/);
  assert.throws(() => validateRule(rule('GET', '/a', { response: { delayMs: 30001 } })), /延迟/);
  assert.throws(() => validateRule(rule('GET', '/a', { response: { bodyEncoding: 'base64', body: '***' } })), /Base64/);
  assert.throws(() => validateRule(rule('GET', '/a', { response: { headers: [{ name: 'Content-Length', value: '1' }] } })), /不建议覆盖/);
  assert.equal(normalizePath('patient//list/'), '/patient/list');
  assert.equal(normalizePath(''), '/');
});

test('规则列表：同一接口不能重复，参数名不同也视为重复', () => {
  assert.throws(() => validateRules([rule('GET', '/a/:id'), rule('GET', '/a/:uid')]), /规则重复/);
  assert.doesNotThrow(() => validateRules([rule('GET', '/a/:id'), rule('POST', '/a/:id')]));
  assert.deepEqual(validateRules(undefined), []);
});

test('匹配优先级：静态 > 参数 > 通配，Method 精确 > ANY', () => {
  const rules = validateRules([
    rule('ANY', '/files/*', { note: 'wild' }),
    rule('GET', '/patient/detail/:id', { note: 'param' }),
    rule('GET', '/patient/detail/vip', { note: 'static' }),
    rule('GET', '/files/a/b', { note: 'deep-static' }),
    rule('GET', '/files/*', { note: 'get-wild' }),
  ]);
  const note = (method, path) => matchRule(rules, method, path)?.rule.note ?? null;
  assert.equal(note('GET', '/patient/detail/vip'), 'static');
  assert.equal(note('GET', '/patient/detail/42'), 'param');
  assert.equal(note('GET', '/files/a/b'), 'deep-static');
  assert.equal(note('GET', '/files/a/c/d'), 'get-wild');
  assert.equal(note('POST', '/files/x'), 'wild');
  assert.equal(note('POST', '/patient/detail/42'), null);
  assert.equal(note('GET', '/files'), null, '通配符至少匹配一段');
  assert.equal(note('GET', '/other'), null);
});

test('匹配细节：查询串与末尾斜杠忽略、参数提取、中文路径、禁用规则', () => {
  const rules = validateRules([
    rule('GET', '/patient/:id/记录'),
    rule('GET', '/off', { enabled: false }),
  ]);
  const hit = matchRule(rules, 'get', '/patient/9/%E8%AE%B0%E5%BD%95/?x=1');
  assert.deepEqual(hit.params, { id: '9' });
  assert.equal(matchRule(rules, 'GET', '/off'), null);
  assert.equal(matchRule(rules, 'GET', '/patient/9'), null);
});

test('Mock 场景：默认场景、名称唯一、数量上限、备选场景同样做完整校验', () => {
  const plain = validateRule(rule('GET', '/a', { response: { body: '1' } }));
  assert.equal(plain.scenario.name, '默认');
  assert.deepEqual(plain.alternatives, []);
  assert.ok(plain.scenario.id);

  const multi = validateRule(rule('GET', '/a', { scenario: { name: '成功' }, response: { body: '{"ok":1}' }, alternatives: [{ name: '失败', response: { status: 500, body: '{"ok":0}' } }] }));
  assert.equal(multi.response.status, 200, 'response 始终是当前启用的场景');
  assert.equal(multi.alternatives[0].response.status, 500);
  assert.ok(multi.alternatives[0].id);

  const alt = (name, response = {}) => ({ name, response });
  assert.throws(() => validateRule(rule('GET', '/a', { alternatives: [alt('默认')] })), /场景名称「默认」重复/);
  assert.throws(() => validateRule(rule('GET', '/a', { alternatives: [alt('x'), alt('x')] })), /重复/);
  assert.throws(() => validateRule(rule('GET', '/a', { alternatives: [alt('')] })), /1–30 个字符/);
  assert.throws(() => validateRule(rule('GET', '/a', { alternatives: [alt('x'.repeat(31))] })), /1–30 个字符/);
  assert.throws(() => validateRule(rule('GET', '/a', { alternatives: [alt('坏', { status: 9 })] })), /状态码/);
  assert.throws(() => validateRule(rule('GET', '/a', { alternatives: [alt('坏', { dynamic: true, body: '{{nope}}' })] })), /未知占位符/, '备选场景的模板同样在保存时校验');
  assert.throws(() => validateRule(rule('GET', '/a', { alternatives: 'x' })), /场景列表格式/);
  const many = Array.from({ length: 20 }, (_, i) => alt(`s${i}`));
  assert.throws(() => validateRule(rule('GET', '/a', { alternatives: many })), /最多支持 20 个/);
  assert.doesNotThrow(() => validateRule(rule('GET', '/a', { alternatives: many.slice(1) })));
});

test('切换场景：原位互换不丢数据，匹配使用当前启用场景；追加场景自动去重名称', () => {
  const base = validateRule(rule('GET', '/a', { scenario: { name: '成功' }, response: { body: '"ok"' }, alternatives: [{ name: '失败', response: { status: 500, body: '"bad"' } }, { name: '空', response: { body: '[]' } }] }));
  const failId = base.alternatives[0].id;
  const emptyId = base.alternatives[1].id;
  const switched = switchScenario(base, failId);
  assert.equal(switched.scenario.name, '失败');
  assert.equal(switched.response.status, 500);
  assert.deepEqual(switched.alternatives.map((a) => a.name), ['成功', '空'], '原位互换，其余场景顺序不变');
  assert.equal(switched.alternatives[0].response.body, '"ok"');
  assert.equal(base.scenario.name, '成功', '不修改原对象');
  assert.equal(switchScenario(base, base.scenario.id), base, '切到当前场景无变化');
  assert.throws(() => switchScenario(base, 'nope'), /找不到此 Mock 场景/);

  const roundTrip = switchScenario(switchScenario(switched, switched.alternatives[0].id), emptyId);
  assert.equal(roundTrip.scenario.name, '空');
  assert.deepEqual([roundTrip.scenario.name, ...roundTrip.alternatives.map((a) => a.name)].sort(), ['失败', '成功', '空']);
  assert.equal(validateRule(roundTrip).scenario.name, '空', '切换后的规则仍能通过校验');
  assert.equal(matchRule(validateRules([roundTrip]), 'GET', '/a').rule.response.body, '[]');

  const added = addScenario(base, '失败', { body: 'x' });
  assert.deepEqual(added.alternatives.map((a) => a.name), ['失败', '空', '失败 2']);
  assert.equal(addScenario(added, '失败', { body: 'y' }).alternatives.at(-1).name, '失败 3');
  assert.equal(added.scenario.name, '成功', '追加的场景不会自动启用');
});

test('未命中原因：停用、方法不同、大小写、规则带了代理前缀、完全没匹配', () => {
  const prefix = '/cgw/aiadmin';
  const rules = validateRules([
    { method: 'GET', path: '/user/list', enabled: false },
    { method: 'POST', path: '/order/create' },
    { method: 'GET', path: '/Report/Month' },
    { method: 'GET', path: '/cgw/aiadmin/patient/list' },
    { method: 'GET', path: '/patient/detail/:id' },
  ]);
  const why = (method, path) => explainMiss(rules, method, path, prefix);
  assert.match(why('GET', '/user/list?page=1'), /规则「GET \/user\/list」已停用/);
  assert.match(why('GET', '/order/create'), /请求方法是 GET，方法不一致/);
  assert.match(why('GET', '/report/month'), /只有大小写不同/);
  assert.match(why('GET', '/patient/list'), /带了代理前缀，应写成「\/patient\/list」/);
  const tailRules = validateRules([{ method: 'POST', path: '/appOps/biz' }]);
  assert.match(explainMiss(tailRules, 'POST', '/messages/appOps/biz', prefix), /只是请求路径「\/messages\/appOps\/biz」的结尾部分，缺少前面的 \/messages/, '规则只写了路径末尾');
  assert.match(why('GET', '/user/list/detail'), /没有规则匹配「GET \/user\/list\/detail」.*已配置 5 条.*去掉代理前缀/);
  assert.equal(matchRule(rules, 'GET', '/patient/detail/9').rule.path, '/patient/detail/:id', '对照：正确的规则可以命中');
});
