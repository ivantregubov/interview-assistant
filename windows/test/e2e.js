// Полный прогон на настоящем Electron: запись экрана и микрофона (тестовое устройство), файлы, расшифровка.
const { _electron: electron } = require('playwright');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const assert = require('assert');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-e2e-'));
  const userData = path.join(root, 'данные пользователя');
  const saves = path.join(root, 'Записи');
  const log = path.join(root, 'fake.log');
  fs.mkdirSync(path.join(userData, 'models'), { recursive: true });
  // Подставная модель нужного размера вместо загрузки
  const model = path.join(userData, 'models', 'ggml-large-v3-turbo-q5_0.bin');
  fs.closeSync(fs.openSync(model, 'w')); fs.truncateSync(model, 574041195);
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ customSaveFolderPath: saves }));
  const app = await electron.launch({
    executablePath: path.join(__dirname, '../node_modules/electron/dist/electron'),
    args: [path.join(__dirname, '..'), '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-gpu'],
    env: { ...process.env, IR_TEST: '1', IR_TEST_SHOW: '1', IR_TEST_USER_DATA: userData, IR_TEST_WHISPER: path.join(__dirname, 'fake-whisper.js'), IR_FAKE_LOG: log },
  });
  const win = await app.firstWindow();
  const errors = []; win.on('pageerror', (e) => errors.push(e.message)); win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await win.waitForLoadState();
  await win.waitForFunction(() => document.querySelectorAll('#microphone option').length > 0);
  await win.waitForFunction(() => document.querySelectorAll('.screen').length > 0);
  console.log('mics', await win.locator('#microphone option').count(), 'screens', await win.locator('.screen').count(), 'footer', await win.textContent('#version'));
  await win.screenshot({ path: path.join(process.argv[2], 'win-idle.png') });
  await win.click('#record');
  await win.waitForFunction(() => document.getElementById('status').textContent === 'Идёт запись', null, { timeout: 20000 }).catch(async (e) => { console.log('STATUS', await win.textContent('#status'), await win.textContent('#error-text'), errors); throw e; });
  await win.waitForTimeout(5000);
  const during = await win.evaluate(() => ({ timer: document.getElementById('timer').textContent, mic: document.getElementById('mic-level').style.transform, err: document.getElementById('error-text').textContent }));
  console.log('during', during);
  await win.screenshot({ path: path.join(process.argv[2], 'win-recording.png') });
  await win.click('#record');
  await win.waitForFunction(() => document.getElementById('status').textContent === 'Готово к записи', null, { timeout: 20000 });
  await win.waitForFunction(() => !document.getElementById('last-transcript').hidden || !document.getElementById('transcription-error').hidden, null, { timeout: 20000 });
  console.log('transcription error:', await win.textContent('#transcription-error-text'));
  const folder = path.join(saves, fs.readdirSync(saves)[0]);
  console.log('files', fs.readdirSync(folder).map((f) => f + ':' + fs.statSync(path.join(folder, f)).size));
  const video = fs.readdirSync(folder).find((f) => f.startsWith('screen.'));
  console.log('ffprobe', execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'compact', path.join(folder, video)]).toString());
  for (const name of ['mic.wav', 'system.wav']) console.log(name, execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,duration', '-of', 'compact', path.join(folder, name)]).toString().trim());
  console.log('--- transcript.md\n' + fs.readFileSync(path.join(folder, 'transcript.md'), 'utf8'));
  console.log('fake log', fs.readFileSync(log, 'utf8'));
  // Существующий файл без соседних дорожек: видео с аудио и mp3
  const extra = path.join(root, 'старые файлы'); fs.mkdirSync(extra);
  const sample = path.join(extra, 'интервью.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=4', '-c:a', 'aac', '-c:v', 'libx264', '-shortest', sample]);
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, sample);
  const before = fs.readFileSync(log, 'utf8').split('\n').length;
  await win.click('[data-action=transcribeExisting]');
  for (let i = 0; i < 60 && !fs.existsSync(path.join(extra, 'интервью.transcript.md')); i += 1) await win.waitForTimeout(250);
  await win.waitForTimeout(500);
  console.log('existing files', fs.readdirSync(extra), 'err:', await win.textContent('#transcription-error-text'));
  console.log(fs.readFileSync(path.join(extra, 'интервью.transcript.md'), 'utf8'));
  console.log('fake log tail', fs.readFileSync(log, 'utf8').split('\n').slice(before - 1).join(' '));
  // Файл из папки записи обрабатывается как вся запись
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, path.join(folder, video));
  fs.rmSync(path.join(folder, 'transcript.md'));
  await win.click('[data-action=transcribeExisting]');
  for (let i = 0; i < 60 && !fs.existsSync(path.join(folder, 'transcript.md')); i += 1) await win.waitForTimeout(250);
  console.log('re-transcribed folder', fs.existsSync(path.join(folder, 'transcript.md')));
  // Настройки сохраняются
  await win.click('[data-tab=settings]');
  await win.click('[data-quality=fast]');
  await win.click('.toggle:has(#auto-open)');
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(process.argv[2], 'win-settings.png') });
  await win.click('[data-tab=help]'); await win.waitForTimeout(250);
  await win.screenshot({ path: path.join(process.argv[2], 'win-help.png') });
  console.log('settings', fs.readFileSync(path.join(userData, 'settings.json'), 'utf8').replace(/\s+/g, ' '));
  console.log('page errors', errors);
  // Выход во время записи сохраняет файлы
  await win.click('[data-tab=record]');
  await win.click('#record');
  await win.waitForFunction(() => document.getElementById('status').textContent === 'Идёт запись', null, { timeout: 20000 });
  await win.waitForTimeout(2000);
  const count = fs.readdirSync(saves).length;
  await app.evaluate(({ app }) => app.quit());
  await new Promise((r) => setTimeout(r, 4000));
  const lastFolder = path.join(saves, fs.readdirSync(saves).sort().pop());
  console.log('after quit folders', count, fs.readdirSync(lastFolder).map((f) => f + ':' + fs.statSync(path.join(lastFolder, f)).size), 'mic header ok', fs.readFileSync(path.join(lastFolder, 'mic.wav')).readUInt32LE(40) > 0);
  await app.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('E2E FAILED', e); process.exit(1); });
