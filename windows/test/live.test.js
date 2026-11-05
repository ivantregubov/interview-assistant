const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { streamChat, createSseParser, httpError, requestBody } = require('../lib/llm');
const { PhraseDetector, wavBuffer, normalize } = require('../lib/live-stt');

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

test('тихая речь распознаётся как фраза, а ровный шум нет', () => {
  const quiet = [];
  const d = new PhraseDetector((s) => quiet.push(s.length / 16));
  d.feed(silence(500));
  d.feed(tone(1200, 150));      // уровень около 0,3% полной шкалы
  d.feed(silence(800));
  assert.strictEqual(quiet.length, 1, 'тихий голос найден');

  const noisy = [];
  const n = new PhraseDetector((s) => noisy.push(s));
  const hum = (ms) => tone(ms, 200);
  for (let i = 0; i < 700; i += 1) n.feed(hum(100));
  const countAfterAdaptation = noisy.length;
  for (let i = 0; i < 100; i += 1) n.feed(hum(100));
  assert.strictEqual(noisy.length, countAfterAdaptation, 'к постоянному шуму порог подстроился');
});

test('громкость фразы выравнивается, громкая не меняется', () => {
  const q = normalize(new Int16Array([100, -200, 50]));
  assert.strictEqual(q[1], -6000);
  const loud = new Int16Array([30000, -20000]);
  assert.strictEqual(normalize(loud), loud);
  const silent = new Int16Array(4);
  assert.strictEqual(normalize(silent), silent);
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

test('зависший запрос обрывается по простою, а медленный идущий ответ нет', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/hang') return; // сервис молчит
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      res.write(`data: {"choices":[{"delta":{"content":"${n}"}}]}\n\n`);
      if (n === 4) { clearInterval(timer); res.end('data: [DONE]\n\n'); }
    }, 60);
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const common = { fetchImpl: fetch, provider: 'deepseek', model: 'm', apiKey: 'k', messages: [], maxTokens: 1 };
  await assert.rejects(
    streamChat({ ...common, url: `${base}/hang`, idleTimeoutMs: 100, onText() {} }),
    (error) => error.isTimeout === true && error.message === 'сервис не ответил вовремя'
  );
  let text = '';
  const result = await streamChat({ ...common, url: `${base}/slow`, idleTimeoutMs: 150, onText: (t) => { text += t; } });
  assert.strictEqual(text, '1234', 'общее время больше таймаута простоя');
  assert.ok(result.firstByteMs !== null && result.textLength === 4);
  server.closeAllConnections();
  server.close();
});

test('фраза упаковывается в корректный WAV', () => {
  const b = wavBuffer(new Int16Array([1, -1, 2]));
  assert.strictEqual(b.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(b.readUInt32LE(40), 6);
  assert.strictEqual(b.readInt16LE(46), -1);
  assert.strictEqual(b.readUInt32LE(24), 16000);
});

test('короткий всплеск чуть выше шума не считается фразой', () => {
  const out = [];
  const d = new PhraseDetector((s) => out.push(s));
  // Постоянный шум, порог подстроился под него.
  for (let i = 0; i < 30; i += 1) d.feed(tone(100, 60));
  // Всплеск на грани порога.
  d.feed(tone(500, 210));
  d.feed(tone(800, 60));
  assert.strictEqual(out.length, 0);
  d.feed(tone(800, 3000));
  d.feed(tone(800, 60));
  assert.strictEqual(out.length, 1, 'речь намного громче шума определяется');
});
