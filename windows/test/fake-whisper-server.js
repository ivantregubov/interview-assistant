#!/usr/bin/env node
// Заменяет whisper-server в тестах: проверяет аргументы и формат запроса.
const http = require('http'); const fs = require('fs');
const args = process.argv.slice(2);
const get = (f) => args[args.indexOf(f) + 1];
for (const f of ['--host', '--port', '--model', '--language', '--threads', '--audio-ctx', '--no-timestamps']) if (!args.includes(f)) process.exit(2);
if (args.includes('--vad')) process.exit(4); // фразы уже выделены приложением
if (get('--model').includes('/') || !fs.existsSync(get('--model'))) process.exit(3);
const phrases = ['Что такое JWT'];
let n = 0;
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('{"status":"ok"}'); return; }
  if (req.url === '/inference') {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const ok = (req.headers['content-type'] || '').startsWith('multipart/form-data') && body.includes('RIFF') && body.includes('name="file"') && body.includes('name="response_format"') && body.includes('name="audio_ctx"');
      fs.appendFileSync(process.env.IR_FAKE_LOG, JSON.stringify({ inference: ok, bytes: body.length }) + '\n');
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: ` ${phrases[n++ % phrases.length]}\n` }));
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(Number(get('--port')), get('--host'));
