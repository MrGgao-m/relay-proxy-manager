'use strict';

// 本地假的 AI 服务（OpenAI 兼容）：respond(userPrompt, body, headers) 返回 { text } 或 { status, error } 或 { delayMs, text }。
const http = require('node:http');

async function fakeAi(t, port, respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      const prompt = body.messages?.[1]?.content || '';
      requests.push({ url: req.url, headers: req.headers, body, prompt });
      const step = await respond(prompt, body, req.headers);
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      res.statusCode = step.status || 200;
      res.setHeader('Content-Type', 'application/json');
      if (step.error) return res.end(JSON.stringify({ error: { message: step.error } }));
      res.end(JSON.stringify({ choices: [{ message: { content: step.text } }] }));
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  t.after(() => server.close());
  return requests;
}

module.exports = { fakeAi };
