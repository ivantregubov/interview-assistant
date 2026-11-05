// Первый запрос к сервису зависает: приложение должно повторить его и получить ответ.
const { _electron: electron } = require('playwright');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
(async () => {
  let count = 0;
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      count += 1;
      if (count === 1) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"Готово"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-retry-'));
  fs.writeFileSync(path.join(userData, 'api-keys.json'), JSON.stringify({ deepseek: 'plain:k' }));
  const app = await electron.launch({
    executablePath: path.join(__dirname, '../node_modules/electron/dist/electron'),
    args: [path.join(__dirname, '..'), '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-gpu'],
    env: { ...process.env, IR_TEST: '1', IR_TEST_SHOW: '1', IR_TEST_USER_DATA: userData, IR_TEST_LLM_URL: `http://127.0.0.1:${server.address().port}/`, IR_TEST_LLM_TIMEOUT: '400' },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState();
  await win.click('[data-tab=settings]');
  await win.waitForTimeout(200);
  await win.click('#llm-test');
  await win.waitForFunction(() => /работает|Не удалось/.test(document.getElementById('llm-test-result').textContent), null, { timeout: 6000 });
  console.log('result:', await win.textContent('#llm-test-result'), '| requests:', count);
  console.log(fs.readFileSync(path.join(userData, 'diagnostics.log'), 'utf8').split('\n').map((l) => l.replace(/^\S+ /, '')).join(' / '));
  await app.close().catch(() => {});
  server.closeAllConnections(); server.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
