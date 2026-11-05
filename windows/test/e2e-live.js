const { _electron: electron } = require('playwright');
const fs = require('fs'); const os = require('os'); const path = require('path'); const assert = require('assert');
const fakeLlm = require('./fake-llm');
(async () => {
  const shots = process.argv[2];
  const llm = await fakeLlm.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-live-'));
  const userData = path.join(root, 'ud'); const saves = path.join(root, 'Записи'); const log = path.join(root, 'fake.log');
  fs.mkdirSync(path.join(userData, 'models'), { recursive: true });
  for (const [name, size] of [['ggml-large-v3-turbo-q5_0.bin', 574041195], ['ggml-small-q5_1.bin', 190085487]]) {
    const m = path.join(userData, 'models', name); fs.closeSync(fs.openSync(m, 'w')); fs.truncateSync(m, size);
  }
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ customSaveFolderPath: saves, transcribeAfterRecording: false }));
  const app = await electron.launch({
    executablePath: path.join(__dirname, '../node_modules/electron/dist/electron'),
    args: [path.join(__dirname, '..'), '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-gpu'],
    env: { ...process.env, IR_TEST: '1', IR_TEST_SHOW: '1', IR_TEST_USER_DATA: userData, IR_TEST_WHISPER: path.join(__dirname, 'fake-whisper.js'), IR_TEST_WHISPER_SERVER: path.join(__dirname, 'fake-whisper-server.js'), IR_FAKE_LOG: log, IR_TEST_LLM_URL: llm.url },
  });
  const win = await app.firstWindow();
  const errors = []; win.on('pageerror', (e) => errors.push(e.message)); win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.waitForLoadState();
  await win.setViewportSize({ width: 540, height: 760 });
  await win.waitForFunction(() => document.querySelectorAll('#microphone option').length > 0);

  // Без ключа запись работает, но вкладка просит ключ
  await win.click('[data-tab=interview]');
  await win.waitForTimeout(250);
  assert.ok(await win.isVisible('#qa-no-key'), 'нет сообщения о ключе');
  await win.screenshot({ path: `${shots}/live-no-key.png` });

  // Настройки
  await win.click('#qa-open-settings');
  await win.waitForTimeout(200);
  assert.strictEqual(await win.inputValue('#llm-model'), 'deepseek-flash');
  await win.fill('#llm-key', 'secret-key-1');
  await win.click('#llm-key-save');
  await win.waitForFunction(() => document.getElementById('llm-key-status').textContent.includes('сохранён'));
  assert.strictEqual(await win.inputValue('#llm-key'), '');
  const stored = fs.readFileSync(path.join(userData, 'api-keys.json'), 'utf8');
  console.log('key stored', stored.includes('secret-key-1') ? 'PLAIN (test env without OS keychain)' : 'encrypted');
  await win.click('#llm-test');
  await win.waitForFunction(() => document.getElementById('llm-test-result').textContent === 'Подключение работает', null, { timeout: 5000 });
  assert.strictEqual(llm.seen[0].auth, 'Bearer secret-key-1');
  await win.click('[data-provider=openrouter]');
  await win.waitForFunction(() => document.getElementById('llm-model').value === 'deepseek/deepseek-v4-flash');
  assert.ok((await win.textContent('#llm-key-status')).includes('не добавлен'), 'у каждого сервиса свой ключ');
  await win.click('[data-provider=deepseek]');
  await win.waitForFunction(() => document.getElementById('llm-key-status').textContent.includes('сохранён'));
  await win.evaluate(() => document.querySelector('main').scrollTo(0, 0));
  await win.waitForTimeout(200);
  await win.screenshot({ path: `${shots}/live-settings.png` });

  // Запись: вкладка переключается сама, звук идёт через настоящий путь до whisper-server
  await win.click('[data-tab=record]');
  await win.click('#record');
  await win.waitForFunction(() => document.getElementById('status').textContent === 'Идёт запись', null, { timeout: 20000 });
  await win.waitForFunction(() => document.getElementById('page-interview').classList.contains('active'));
  for (let i = 0; i < 60 && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('inference')); i += 1) await win.waitForTimeout(250);
  console.log('live status:', await win.textContent('#qa-live-status-text'));
  console.log('stt requests:', fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('inference')).slice(0, 2) : 'none');
  await win.waitForTimeout(800);
  console.log('cards from audio path:', await win.locator('.qa').count());

  // Дальше сценарий с известным текстом: речь подаётся так же, как от распознавания
  const say = (track, text, final = true) => win.evaluate(([t, x, f]) => window.coachSpeech(t, x, f), [track, text, final]);
  await say('system', 'Что такое REST');
  await win.waitForTimeout(500);
  await say('mic', 'Ну я не знаю, что-то про сервисы');
  await win.waitForTimeout(400);
  await say('system', 'Что такое шардирование');
  await win.waitForTimeout(300);
  await say('system', 'Как устроена Kafka', false);
  await win.waitForTimeout(200);
  await win.screenshot({ path: `${shots}/live-interim.png` });
  await win.waitForTimeout(1500);
  await say('mic', 'Kafka это брокер сообщений');
  await win.waitForTimeout(300);
  await say('system', 'Что такое JWT токен и зачем подпись');
  await win.waitForTimeout(400);
  await say('mic', 'Токен из трёх частей, подпись защищает от подмены');
  await win.waitForTimeout(4600);
  console.log('cards', await win.locator('.qa').count(), 'marks', await win.evaluate(() => [...document.querySelectorAll('.qa-mark')].map((e) => e.className)));
  const scrolled = await win.evaluate(() => { const m = document.querySelector('main'); return [m.scrollTop, m.scrollHeight, m.clientHeight]; });
  console.log('scroll', scrolled);
  await win.screenshot({ path: `${shots}/live-cards.png` });

  await win.click('#qa-stop');
  await win.waitForFunction(() => !document.getElementById('qa-summary').hidden, null, { timeout: 15000 });
  await win.waitForTimeout(400);
  await win.screenshot({ path: `${shots}/live-summary.png` });
  const stats = await win.evaluate(() => ['stat-total', 'stat-share', 'stat-correct', 'stat-partial', 'stat-wrong', 'stat-unanswered'].map((id) => document.getElementById(id).textContent));
  console.log('stats', stats);
  const folder = path.join(saves, fs.readdirSync(saves)[0]);
  for (let i = 0; i < 20 && !fs.existsSync(path.join(folder, 'interview-report.md')); i += 1) await win.waitForTimeout(200);
  console.log('files', fs.readdirSync(folder));
  console.log(fs.readFileSync(path.join(folder, 'interview-report.md'), 'utf8').slice(0, 900));
  console.log('page errors', errors);
  await app.close().catch(() => {});
  llm.server.close();
  process.exit(0);
})().catch((e) => { console.error('E2E FAILED', e); process.exit(1); });
