const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { streamChat, createSseParser, httpError, requestBody } = require('../lib/llm');
const { PhraseDetector, wavBuffer } = require('../lib/live-stt');

function tone(ms, amp = 8000) { const n = Math.floor(16 * ms); const a = new Int16Array(n); for (let i = 0; i < n; i += 1) a[i] = Math.sin(i * 0.1) * amp; return a; }
const silence = (ms) => new Int16Array(Math.floor(16 * ms));

test('фразы выделяются по паузе, шум и щелчки игнорируются', () => {
  const out = [];
  const d = new PhraseDetector((s) => out.push(s.length / 16));
  d.feed(silence(500));
  d.feed(tone(40));             // щелчок короче минимальной речи
  d.feed(silence(800));
  assert.strictEqual(out.length, 0);
  d.feed(tone(1500));
  assert.strictEqual(out.length, 0, 'пока идёт речь, фраза не закончена');
  d.feed(silence(800));
  assert.strictEqual(out.length, 1);
  assert.ok(out[0] > 1500 && out[0] < 2600, `длина ${out[0]}`);
  // разрезанные части и долгая речь
  for (let i = 0; i < 60; i += 1) d.feed(tone(200));
  assert.strictEqual(out.length, 2, 'длинная фраза принудительно закрыта');
});

test('разбор потока SSE с разрезанными строками', () => {
  let text = '';
  const p = createSseParser((t) => { text += t; });
  p('data: {"choices":[{"delta":{"content":"При"}}]}\n\ndata: {"cho');
  p('ices":[{"delta":{"content":"вет"}}]}\n\n: keep-alive\n');
  p('data: {"choices":[{"delta":{"reasoning_content":"думаю"}}]}\n');
  p('data: [DONE]\n\n');
  assert.strictEqual(text, 'Привет');
});

test('запрос к сервису и понятные ошибки', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      if (req.headers.authorization === 'Bearer bad') { res.writeHead(401); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"QUESTION: Что"}}]}\n\n');
      res.end('data: {"choices":[{"delta":{"content":" такое?"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let text = '';
  await streamChat({ fetchImpl: fetch, url, provider: 'deepseek', model: 'deepseek-flash', apiKey: 'k', messages: [{ role: 'user', content: 'x' }], maxTokens: 10, onText: (t) => { text += t; } });
  assert.strictEqual(text, 'QUESTION: Что такое?');
  assert.strictEqual(seen[0].auth, 'Bearer k');
  assert.strictEqual(seen[0].body.stream, true);
  assert.deepStrictEqual(seen[0].body.thinking, { type: 'disabled' });
  await assert.rejects(streamChat({ fetchImpl: fetch, url, provider: 'openrouter', model: 'm', apiKey: 'bad', messages: [], maxTokens: 1, onText() {} }), /неверный API-ключ/);
  assert.strictEqual(seen[1].body.reasoning.enabled, false);
  server.close();
  assert.ok(httpError(402, '').includes('средств'));
  assert.ok(httpError(500, '{"error":{"message":"сбой"}}').includes('сбой'));
  assert.strictEqual(JSON.parse(requestBody('openrouter', 'm', [], 5)).model, 'm');
});

test('фраза упаковывается в корректный WAV', () => {
  const b = wavBuffer(new Int16Array([1, -1, 2]));
  assert.strictEqual(b.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(b.readUInt32LE(40), 6);
  assert.strictEqual(b.readInt16LE(46), -1);
  assert.strictEqual(b.readUInt32LE(24), 16000);
});
