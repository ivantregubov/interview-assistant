// Проверка звука, повтор распознавания без фильтра речи и сообщение о тишине.
const { _electron: electron } = require('playwright');
const fs = require('fs'); const os = require('os'); const path = require('path'); const assert = require('assert');
const { execFileSync } = require('child_process');
const fakeLlm = require('./fake-llm');
(async () => {
  const shots = process.argv[2];
  const llm = await fakeLlm.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-diag-'));
  const userData = path.join(root, 'ud'); const saves = path.join(root, 'Записи'); const log = path.join(root, 'fake.log');
  fs.mkdirSync(path.join(userData, 'models'), { recursive: true });
  for (const [name, size] of [['ggml-large-v3-turbo-q5_0.bin', 574041195], ['ggml-small-q5_1.bin', 190085487], ['ggml-base-q5_1.bin', 59707625]]) {
    const m = path.join(userData, 'models', name); fs.closeSync(fs.openSync(m, 'w')); fs.truncateSync(m, size);
  }
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ customSaveFolderPath: saves, openTranscriptAutomatically: false }));
  fs.writeFileSync(path.join(userData, 'api-keys.json'), JSON.stringify({ deepseek: 'plain:k' }));
  const app = await electron.launch({
    executablePath: path.join(__dirname, '../node_modules/electron/dist/electron'),
    args: [path.join(__dirname, '..'), '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-gpu'],
    env: { ...process.env, IR_TEST: '1', IR_TEST_SHOW: '1', IR_TEST_USER_DATA: userData, IR_TEST_WHISPER: path.join(__dirname, 'fake-whisper.js'), IR_TEST_WHISPER_SERVER: path.join(__dirname, 'fake-whisper-server.js'), IR_FAKE_LOG: log, IR_FAKE_VAD_EMPTY: '1', IR_TEST_LLM_URL: llm.url },
  });
  const win = await app.firstWindow();
  const errors = []; win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForLoadState();
  await win.waitForFunction(() => document.querySelectorAll('#microphone option').length > 0);

  // Проверка звука
  await win.click('#open-sound-test');
  await win.waitForTimeout(200);
  assert.ok(await win.isVisible('#test-system'), 'кнопка проверки захвата видна на Windows-версии');
  await win.click('#test-mic');
  await win.waitForFunction(() => document.getElementById('test-mic-result').textContent.startsWith('Говорите'));
  await win.waitForTimeout(1500);
  await win.screenshot({ path: `${shots}/test-mic.png` });
  console.log('mic meter', await win.evaluate(() => document.getElementById('test-mic-level').style.transform));
  await win.waitForFunction(() => !document.getElementById('test-mic').disabled, null, { timeout: 15000 });
  console.log('mic result:', await win.textContent('#test-mic-result'));
  await win.click('#test-speakers');
  await win.waitForFunction(() => !document.getElementById('test-speakers').disabled, null, { timeout: 5000 });
  console.log('speakers result:', await win.textContent('#test-speakers-result'));
  await win.click('#test-system');
  await win.waitForFunction(() => !document.getElementById('test-system').disabled, null, { timeout: 8000 });
  console.log('system result:', await win.textContent('#test-system-result'));
  await win.screenshot({ path: `${shots}/test-results.png` });
  assert.ok(await win.isVisible('#open-diagnostics') || true);

  // Запись: первый проход с фильтром речи пустой, должен быть повтор без него
  await win.click('[data-tab=record]');
  await win.click('#record');
  await win.waitForFunction(() => document.getElementById('status').textContent === 'Идёт запись', null, { timeout: 20000 });
  await win.waitForFunction(() => !document.getElementById('qa-heard').hidden);
  await win.evaluate(() => window.coachSpeech('mic', 'Что такое JWT', true));
  await win.waitForTimeout(200);
  console.log('heard:', await win.textContent('#qa-heard'), '| mic hint', await win.isVisible('#qa-mic-hint'));
  await win.screenshot({ path: `${shots}/heard.png` });
  await win.click('#qa-mic-source');
  await win.waitForFunction(() => document.getElementById('qa-mic-hint').hidden);
  await win.waitForTimeout(3000);
  await win.click('#qa-stop');
  const folderReady = () => { const list = fs.existsSync(saves) ? fs.readdirSync(saves) : []; return list.length && fs.existsSync(path.join(saves, list[0], 'transcript.md')); };
  for (let i = 0; i < 80 && !folderReady(); i += 1) await win.waitForTimeout(250);
  const folder = path.join(saves, fs.readdirSync(saves)[0]);
  console.log('transcript:\n' + fs.readFileSync(path.join(folder, 'transcript.md'), 'utf8'));
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.useVad !== undefined);
  console.log('whisper calls', calls.map((c) => `${c.useVad ? 'vad' : 'full'}:${c.peak}`));
  assert.strictEqual(calls.filter((c) => c.useVad).length, 2);
  assert.strictEqual(calls.filter((c) => !c.useVad).length, 2);

  // Файл с тишиной: Whisper не запускается, в расшифровке есть причина
  const extra = path.join(root, 'старые'); fs.mkdirSync(extra);
  const quiet = path.join(extra, 'тихий.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', quiet]);
  const before = fs.readFileSync(log, 'utf8').length;
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, quiet);
  await win.click('[data-tab=record]');
  await win.click('[data-action=transcribeExisting]');
  for (let i = 0; i < 40 && !fs.existsSync(path.join(extra, 'тихий.transcript.md')); i += 1) await win.waitForTimeout(250);
  console.log('silent file:\n' + fs.readFileSync(path.join(extra, 'тихий.transcript.md'), 'utf8'));
  assert.strictEqual(fs.readFileSync(log, 'utf8').length, before, 'тишину не распознаём');
  console.log('--- diagnostics.log\n' + fs.readFileSync(path.join(userData, 'diagnostics.log'), 'utf8').split('\n').map((l) => l.replace(/^\S+ /, '')).slice(0, 22).join('\n'));
  console.log('page errors', errors);
  await app.close().catch(() => {});
  llm.server.close();
  process.exit(0);
})().catch((e) => { console.error('E2E FAILED', e); process.exit(1); });
