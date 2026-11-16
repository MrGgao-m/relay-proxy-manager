'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOpenApi, toRulePath } = require('../src/openapi');
const { parseMarkdownDoc } = require('../src/markdown-doc');
const { exampleFromSchema, templatizeSample } = require('../src/sample-gen');
const { compileTemplate } = require('../src/template');

const OPENAPI3_YAML = `
openapi: 3.0.1
info: { title: 患者系统, version: "1.0" }
servers: [ { url: /api } ]
paths:
  /patient/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      summary: 患者详情
      parameters:
        - $ref: '#/components/parameters/Lang'
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Result' }
        "404": { description: not found }
  /patient/list:
    post:
      summary: 患者列表
      requestBody:
        content:
          application/json:
            schema: { type: object, properties: { page: { type: integer } } }
      responses:
        "201":
          description: created
          content:
            application/json:
              schema: { type: array, items: { $ref: '#/components/schemas/Patient' } }
  /ping:
    get:
      responses:
        default: { description: 默认响应 }
components:
  parameters:
    Lang: { name: lang, in: query, schema: { type: string } }
  schemas:
    Result:
      type: object
      required: [code]
      properties:
        code: { type: integer, example: 0 }
        data: { $ref: '#/components/schemas/Patient' }
    Base:
      type: object
      properties: { id: { type: string } }
    Patient:
      allOf:
        - $ref: '#/components/schemas/Base'
        - type: object
          properties:
            name: { type: string }
            phone: { type: string }
            age: { type: integer }
            status: { type: string, enum: [ACTIVE, DONE] }
            createTime: { type: string, format: date-time }
            friends: { type: array, items: { $ref: '#/components/schemas/Patient' } }
`;

test('OpenAPI 3（YAML）：路径转换、参数合并、$ref、allOf、循环引用、成功响应', () => {
  const { info, endpoints, warnings } = parseOpenApi(OPENAPI3_YAML);
  assert.equal(info.title, '患者系统');
  assert.equal(info.basePath, '/api');
  assert.deepEqual(endpoints.map((e) => e.id), ['GET /patient/:id', 'POST /patient/list', 'GET /ping']);
  assert.deepEqual(warnings, []);

  const detail = endpoints[0];
  assert.equal(detail.summary, '患者详情');
  assert.deepEqual(detail.params.map((p) => `${p.in}:${p.name}`).sort(), ['path:id', 'query:lang'], '路径级与 $ref 参数合并');
  assert.equal(detail.successStatus, 200);
  assert.deepEqual(detail.needsConfirm, []);
  const schema = detail.responses.find((r) => r.status === 200).schema;
  assert.deepEqual(schema.required, ['code']);
  assert.deepEqual(Object.keys(schema.properties.data.properties).sort(), ['age', 'createTime', 'friends', 'id', 'name', 'phone', 'status'], 'allOf 合并了 Base');
  assert.match(schema.properties.data.properties.friends.items.description, /循环引用/);

  const list = endpoints[1];
  assert.equal(list.successStatus, 201);
  assert.equal(list.requestBody.schema.properties.page.type, 'integer');
  assert.equal(list.responses[0].schema.type, 'array');

  const ping = endpoints[2];
  assert.equal(ping.successStatus, 200);
  assert.match(ping.needsConfirm.join(), /default/);
  assert.match(ping.needsConfirm.join(), /没有 Schema/);
});

test('Swagger 2.0（JSON）：definitions、body 参数、examples、多个 2xx 取最小', () => {
  const doc = {
    swagger: '2.0', info: { title: 'old', version: '1' }, basePath: '/v1',
    paths: {
      '/order/{orderNo}': { get: { parameters: [{ name: 'orderNo', in: 'path', required: true, type: 'string' }], responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Order' }, examples: { 'application/json': { orderNo: 'A1' } } } } } },
      '/order': { post: { parameters: [{ name: 'body', in: 'body', schema: { $ref: '#/definitions/Order' } }], responses: { 202: { description: 'a' }, 201: { description: 'b', schema: { type: 'object' } } } } },
    },
    definitions: { Order: { type: 'object', properties: { orderNo: { type: 'string' }, amount: { type: 'number' } } } },
  };
  const { info, endpoints } = parseOpenApi(JSON.stringify(doc));
  assert.equal(info.specVersion, '2.0');
  assert.equal(info.basePath, '/v1');
  const post = endpoints.find((e) => e.method === 'POST');
  assert.equal(post.successStatus, 201);
  assert.equal(post.requestBody.schema.properties.amount.type, 'number');
  const get = endpoints.find((e) => e.method === 'GET');
  assert.deepEqual(get.responses[0].example, { orderNo: 'A1' });
  assert.equal(get.path, '/order/:orderNo');
});

test('OpenAPI：无效文档给出明确提示', () => {
  assert.throws(() => parseOpenApi('hello: 1'), /不是受支持的 Swagger/);
  assert.throws(() => parseOpenApi('a: ['), /不是有效的 JSON 或 YAML/);
  assert.throws(() => parseOpenApi('- 1\n- 2'), /不是对象/);
  assert.throws(() => parseOpenApi('openapi: 3.0.0\ninfo: {}\n'), /没有 paths/);
  assert.throws(() => parseOpenApi('openapi: 3.0.0\npaths:\n  /a: {}\n'), /没有任何接口方法/);
  const { warnings } = parseOpenApi('openapi: 3.0.0\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          content:\n            application/json:\n              schema: { $ref: "#/components/schemas/Missing" }\n');
  assert.match(warnings.join(), /找不到/);
  assert.equal(toRulePath('/a/{b-c}/d'), '/a/:b_c/d');
});

test('由 Schema 生成样例：静态用 example/默认值，动态用占位符，结果能通过模板校验', () => {
  const { endpoints } = parseOpenApi(OPENAPI3_YAML);
  const schema = endpoints[0].responses.find((r) => r.status === 200).schema;
  const fixed = exampleFromSchema(schema);
  assert.equal(fixed.code, 0, '使用 schema 的 example');
  assert.equal(fixed.data.name, '张三');
  assert.equal(fixed.data.status, 'ACTIVE');
  assert.ok(Array.isArray(fixed.data.friends));

  const dynamic = exampleFromSchema(schema, { dynamic: true });
  const template = compileTemplate(JSON.stringify(dynamic));
  assert.equal(template.dynamic, true);
  const out = JSON.parse(template.render());
  assert.equal(typeof out.data.age, 'number');
  assert.match(out.data.phone, /^1[3-9]\d{9}$/);
  assert.ok(['ACTIVE', 'DONE'].includes(out.data.status));
  assert.match(out.data.createTime, /^\d{4}-\d{2}-\d{2} /);
  assert.ok(Array.isArray(out.data.friends));
});

test('固定样例改写成模板：语义字段随机化，code/status 等保持不变，数组可变长', () => {
  const sample = { code: 0, msg: 'ok', data: { id: 7, name: '李四', phone: '13900001111', age: 41, vip: true, remark: '无', list: [{ no: 1, price: 12.5 }, { no: 2, price: 7 }] } };
  const tpl = templatizeSample(sample);
  assert.equal(tpl.code, 0);
  assert.equal(tpl.msg, 'ok');
  assert.equal(tpl.data.remark, '无', '没有语义线索的文本保持原样');
  assert.equal(tpl.data.name, '{{name}}');
  assert.equal(tpl.data.vip, '{{bool}}');
  assert.equal(tpl.data.list[0].startsWith('{{repeat'), true);
  const out = JSON.parse(compileTemplate(JSON.stringify(tpl)).render());
  assert.equal(out.code, 0);
  assert.equal(typeof out.data.age, 'number');
  assert.equal(typeof out.data.vip, 'boolean');
  assert.ok(out.data.list.length >= 2 && out.data.list.every((r) => typeof r.no === 'number'));
});

const MD = `
# 患者接口文档

## 1. 患者详情

**请求方式**：GET
**请求地址**：\`/patient/detail/{id}\`

### 请求参数
| 参数名 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | string | 是 | 患者ID |
| lang | string | 否 | 语言 |

### 响应示例
\`\`\`json
{
  "code": 0, // 注释
  "data": { "name": "张三" },
}
\`\`\`

## 2. 新增患者
POST /patient/create

请求示例：
\`\`\`json
{ "name": "李四" }
\`\`\`
返回结果：
\`\`\`json
{ "code": 0, "id": 9 }
\`\`\`

## 3. 查询列表
### 请求信息
| 项 | 值 |
|---|---|
| Method | POST |
| URL | /patient/list |

只有一个代码块：
\`\`\`json
{ "rows": [] }
\`\`\`

## 4. 导出接口
这个接口还没写路径。
\`\`\`
参数说明
\`\`\`

## 5. 患者详情（重复）
GET /patient/detail/:id
`;

test('Markdown 本地识别：多种写法、参数表、宽松 JSON、请求/响应示例区分、待确认标记', () => {
  const { endpoints, skipped } = parseMarkdownDoc(MD);
  assert.deepEqual(endpoints.map((e) => e.id), ['GET /patient/detail/:id', 'POST /patient/create', 'POST /patient/list']);

  const detail = endpoints[0];
  assert.equal(detail.summary, '患者详情');
  assert.deepEqual(detail.params.map((p) => [p.name, p.required]), [['id', true], ['lang', false]]);
  assert.deepEqual(detail.responses[0].example, { code: 0, data: { name: '张三' } }, '注释和尾逗号被容忍');
  assert.deepEqual(detail.needsConfirm, ['状态码未在文档中声明，按 200 处理']);

  const create = endpoints[1];
  assert.deepEqual(create.requestBody.example, { name: '李四' });
  assert.deepEqual(create.responses[0].example, { code: 0, id: 9 }, '请求示例与响应示例不混淆');

  const list = endpoints[2];
  assert.equal(list.summary, '查询列表', '“请求信息”这类通用小标题使用上一级标题');
  assert.match(list.needsConfirm.join(), /无法确定它是响应示例/);

  assert.deepEqual(skipped.map((s) => s.title), ['导出接口', '患者详情（重复）']);
  assert.match(skipped[0].reason, /没有识别到请求方法和路径/);
  assert.match(skipped[1].reason, /重复/);
});

test('Markdown 本地识别：无响应示例、示例不是 JSON、什么都没识别到', () => {
  const none = parseMarkdownDoc('# a\n## 查询\nGET /x\n\n无示例\n');
  assert.match(none.endpoints[0].needsConfirm.join(), /没有找到响应示例/);
  const text = parseMarkdownDoc('## 查询\nGET /x\n响应：\n```\n{ not json\n```\n');
  assert.match(text.endpoints[0].needsConfirm.join(), /看起来是 JSON，但无法解析/);
  assert.deepEqual(text.endpoints[0].responses, [], '看起来是 JSON 却无法解析时，不把原文当作响应返回');
  const plain = parseMarkdownDoc('## 查询\nGET /x\n响应：\n```\nOK\n```\n');
  assert.equal(plain.endpoints[0].responses[0].example, 'OK', '纯文本响应仍然原样保留');
  const empty = parseMarkdownDoc('# 只有说明\n没有接口');
  assert.deepEqual(empty.endpoints, []);
  assert.match(empty.warnings[0], /没有识别到任何接口/);
});

// 仿照真实文档的结构：统一前缀、接口一览（完整路径）、标题里写短路径、示例带注释和省略号
const OPS_DOC = `
# 运营页接口文档

| 项 | 说明 |
|---|---|
| 接口 | 每个 Tab 一个接口。统一前缀 \`/cgw/aiadmin/messages/appOps\`，全部 **POST** |

## 二、接口一览

| # | 接口 | 对应 Tab |
|---|---|---|
| 1 | \`POST /cgw/aiadmin/messages/appOps/install\` | 装机量 |
| 2 | \`POST /cgw/aiadmin/messages/appOps/biz\` | 业务转化 |

## 三、装机量 \`POST /appOps/install\`

\`\`\`json
{
  "code": 200, "message": "OK",   // 状态
  "result": { "link": "http://example.com/a//b", "total": 10 }   // 字符串里的 // 不能被当成注释
}
\`\`\`

## 四、业务转化 \`POST /appOps/biz\`

\`\`\`json
{
  "code": 200,
  "result": {
    "functions": [                          // 8 个类别
      { "node": "guess", "value": 6 }
      // ...
    ],
    "rates": [ ... ],                       // 占位
    "trend": { "day": [ ... ], "month": [ { "period": "2026-10" }, ... ] },
    "tail": null
  }
}
\`\`\`
`;

test('Markdown：接口一览不当作接口；短路径按“接口一览 / 统一前缀”补全；省略号与注释被整理成合法 JSON', () => {
  const { endpoints, skipped } = parseMarkdownDoc(OPS_DOC);
  assert.deepEqual(endpoints.map((e) => e.id), ['POST /cgw/aiadmin/messages/appOps/install', 'POST /cgw/aiadmin/messages/appOps/biz'], '没有把“接口一览”目录误识别成接口');
  assert.deepEqual(skipped, []);
  const install = endpoints[0];
  assert.match(install.needsConfirm.join(), /路径已按文档的「接口一览」补全.*文档标题写的是 \/appOps\/install/);
  assert.deepEqual(install.responses[0].example, { code: 200, message: 'OK', result: { link: 'http://example.com/a//b', total: 10 } }, '字符串里的 // 保持原样，行尾注释被去掉');

  const biz = endpoints[1];
  const example = biz.responses[0].example;
  assert.equal(typeof example, 'object', '不再把带注释的原文当作响应');
  assert.deepEqual(example.result.functions, [{ node: 'guess', value: 6 }]);
  assert.deepEqual(example.result.rates, []);
  assert.deepEqual(example.result.trend, { day: [], month: [{ period: '2026-10' }] });
  assert.equal(example.result.tail, null);
  assert.match(biz.needsConfirm.join(), /省略号（\.\.\.）已按空处理/);
});

test('Markdown：只有“统一前缀”没有接口一览时，也能把短路径接上', () => {
  const doc = '统一前缀 `/cgw/aiadmin/messages/appOps`\n\n## 业务\nPOST /appOps/biz\n```json\n{"a":1}\n```\n';
  const { endpoints } = parseMarkdownDoc(doc);
  assert.equal(endpoints[0].path, '/cgw/aiadmin/messages/appOps/biz');
  assert.match(endpoints[0].needsConfirm.join(), /「统一前缀」补全/);
  assert.equal(parseMarkdownDoc('## 业务\nPOST /appOps/biz\n').endpoints[0].path, '/appOps/biz', '没有任何前缀线索时保持原样');
});
