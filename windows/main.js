'use strict';

const {
  app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, ipcMain, nativeImage, net,
  powerSaveBlocker, safeStorage, screen, session, shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { WavWriter, repairWav, writeWavFile, analyzeWav, writeBoostedWav } = require('./lib/wav');
const transcript = require('./lib/transcript');
const whisper = require('./lib/whisper');
const llm = require('./lib/llm');
const { LiveStt } = require('./lib/live-stt');

const isTest = Boolean(process.env.IR_TEST);
if (isTest && process.env.IR_TEST_USER_DATA) {
  app.setPath('userData', process.env.IR_TEST_USER_DATA);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const paths = {
  settings: () => path.join(app.getPath('userData'), 'settings.json'),
  models: () => path.join(app.getPath('userData'), 'models'),
  work: () => path.join(app.getPath('userData'), 'work'),
  liveWork: () => path.join(app.getPath('userData'), 'live-work'),
  keys: () => path.join(app.getPath('userData'), 'api-keys.json'),
  diagnostics: () => path.join(app.getPath('userData'), 'diagnostics.log'),
  defaultRecordings: () => path.join(app.getPath('videos'), 'Interview Assistant'),
  whisperDir: () => (app.isPackaged
    ? path.join(process.resourcesPath, 'whisper')
    : path.join(__dirname, 'resources', 'whisper')),
};

/* Настройки */
const defaults = {
  transcribeAfterRecording: true,
  openTranscriptAutomatically: true,
  transcriptionLanguage: 'ru',
  modelQuality: 'accurate',
  customSaveFolderPath: null,
  selectedMicrophoneID: '',
  selectedDisplayID: '',
  liveEnabled: true,
  llmProvider: 'deepseek',
  llmModels: {},
  questionSource: 'interviewer',
  liveQuality: 'live',
};
let settings = { ...defaults };

function loadSettings() {
  try {
    settings = { ...defaults, ...JSON.parse(fs.readFileSync(paths.settings(), 'utf8')) };
  } catch {
    settings = { ...defaults };
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(paths.settings()), { recursive: true });
  fs.writeFileSync(paths.settings(), JSON.stringify(settings, null, 2));
}

function recordingsRoot() {
  return settings.customSaveFolderPath || paths.defaultRecordings();
}

/* Журнал диагностики. API-ключей в нём нет, но есть распознанный текст, поэтому он остаётся на этом компьютере. */
function logLine(message) {
  try {
    const file = paths.diagnostics();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.rmSync(file);
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Журнал не должен мешать работе.
  }
}

/* API-ключи хранятся в зашифрованном виде средствами Windows */
function readKeys() {
  try {
    return JSON.parse(fs.readFileSync(paths.keys(), 'utf8'));
  } catch {
    return {};
  }
}

function saveApiKey(provider, value) {
  const keys = readKeys();
  if (value) {
    if (!safeStorage.isEncryptionAvailable() && !isTest) {
      throw new Error('в системе недоступно шифрование');
    }
    keys[provider] = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(value).toString('base64')
      : `plain:${value}`;
  } else {
    delete keys[provider];
  }
  fs.mkdirSync(path.dirname(paths.keys()), { recursive: true });
  fs.writeFileSync(paths.keys(), JSON.stringify(keys));
}

function loadApiKey(provider) {
  const stored = readKeys()[provider];
  if (!stored) return '';
  if (stored.startsWith('plain:')) return isTest ? stored.slice(6) : '';
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return '';
  }
}

function llmModel() {
  return settings.llmModels[settings.llmProvider] || llm.PROVIDERS[settings.llmProvider].defaultModel;
}

/* Состояние */
const state = {
  state: 'idle',
  elapsedSeconds: 0,
  micLevel: 0,
  systemLevel: 0,
  micSilent: false,
  errorMessage: '',
  micPermissionMissing: false,
  displays: [],
  microphones: [],
  isTranscribing: false,
  transcriptionStage: 'recognize',
  transcriptionProgress: 0,
  transcriptionError: '',
  lastTranscriptPath: null,
  lastRecordingFolder: null,
  reportFolder: null,
  liveStatus: '',
  liveStats: null,
};

let mainWindow = null;
let tray = null;
let pushTimer = null;
let isQuitting = false;

function meterValue(level) {
  if (level <= 0) return 0;
  return Math.min(Math.max((20 * Math.log10(level) + 60) / 60, 0), 1);
}

function elapsedText() {
  const total = state.elapsedSeconds;
  const pad = (value) => String(value).padStart(2, '0');
  return `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

function interfaceState() {
  return {
    version: app.getVersion(),
    state: state.state,
    elapsedText: elapsedText(),
    micLevel: meterValue(state.micLevel),
    systemLevel: meterValue(state.systemLevel),
    micSilent: state.micSilent,
    errorMessage: state.errorMessage,
    micPermissionMissing: state.micPermissionMissing,
    selectedDisplayID: settings.selectedDisplayID,
    displays: state.displays,
    selectedMicrophoneID: settings.selectedMicrophoneID,
    microphones: state.microphones,
    transcribeAfterRecording: settings.transcribeAfterRecording,
    openTranscriptAutomatically: settings.openTranscriptAutomatically,
    transcriptionLanguage: settings.transcriptionLanguage,
    modelQuality: settings.modelQuality,
    isTranscribing: state.isTranscribing,
    transcriptionStage: state.transcriptionStage,
    transcriptionProgress: state.transcriptionProgress,
    transcriptionError: state.transcriptionError,
    hasLastTranscript: Boolean(state.lastTranscriptPath),
    saveFolderPath: recordingsRoot(),
    saveFolderIsDefault: !settings.customSaveFolderPath,
    liveEnabled: settings.liveEnabled,
    llmHasKey: Boolean(readKeys()[settings.llmProvider]),
    llmProvider: settings.llmProvider,
    llmModel: llmModel(),
    questionSource: settings.questionSource,
    liveStatus: state.liveStatus,
    liveStats: state.liveStats,
    liveQuality: settings.liveQuality,
    hasDiagnostics: true,
  };
}

/** Частые изменения вроде индикаторов уровня отправляем не чаще 10 раз в секунду. */
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ui:state', interfaceState());
    }
    updateTray();
  }, 100);
}

/* Экраны */
function loadDisplays() {
  const primary = screen.getPrimaryDisplay();
  const ordered = screen.getAllDisplays().sort((a, b) => {
    if (a.id === primary.id) return -1;
    if (b.id === primary.id) return 1;
    return a.bounds.x - b.bounds.x;
  });
  state.displays = ordered.map((display, index) => ({
    id: String(display.id),
    number: index + 1,
    name: display.label || (display.internal ? 'Встроенный экран' : `Экран ${index + 1}`),
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    isMain: display.id === primary.id,
    pixelWidth: Math.round(display.bounds.width * display.scaleFactor),
    pixelHeight: Math.round(display.bounds.height * display.scaleFactor),
  }));
  if (!state.displays.some((display) => display.id === settings.selectedDisplayID)) {
    settings.selectedDisplayID = state.displays.length ? state.displays[0].id : '';
  }
  pushState();
}

/* Запись */
let capture = null;
let sleepBlocker = null;
let timer = null;
let startTime = 0;
let lastMicSignal = 0;

function sessionFolderName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

/** Для разбора собеседования хватает 1080p: текст читается, файл остаётся разумного размера. */
function videoSize() {
  const display = state.displays.find((item) => item.id === settings.selectedDisplayID);
  const width = display ? display.pixelWidth : 1920;
  const height = display ? display.pixelHeight : 1080;
  const scale = Math.min(1, 1920 / Math.max(width, height));
  const even = (value) => Math.max(2, Math.floor((value * scale) / 2) * 2);
  return { videoWidth: even(width), videoHeight: even(height) };
}

function startRecording() {
  if (state.state !== 'idle') return;
  state.errorMessage = '';
  loadDisplays();

  if (state.micPermissionMissing) {
    state.errorMessage = 'Микрофон недоступен.';
    pushState();
    return;
  }

  try {
    const folder = path.join(recordingsRoot(), sessionFolderName());
    fs.mkdirSync(folder, { recursive: true });
    state.reportFolder = folder;
    capture = {
      folder,
      mic: new WavWriter(path.join(folder, 'mic.wav')),
      system: new WavWriter(path.join(folder, 'system.wav')),
      videoFd: null,
      videoPath: null,
      extension: null,
      startedAt: new Date(),
      failed: false,
      stopping: false,
    };
    state.state = 'starting';
    pushState();
    // Окно приложения не должно попасть в запись.
    if (mainWindow) mainWindow.setContentProtection(true);
    mainWindow.webContents.send('capture:start', {
      microphoneId: settings.selectedMicrophoneID,
      ...videoSize(),
    });
  } catch (error) {
    state.state = 'idle';
    capture = null;
    state.errorMessage = `Не удалось начать запись: ${error.message}`;
    pushState();
  }
}

function discardCapture() {
  if (!capture) return;
  capture.mic.close();
  capture.system.close();
  if (capture.videoFd !== null) fs.closeSync(capture.videoFd);
  fs.rmSync(capture.folder, { recursive: true, force: true });
  capture = null;
}

ipcMain.on('capture:started', (_event, info) => {
  if (!capture) return;
  capture.extension = info.extension;
  capture.videoPath = path.join(capture.folder, `screen.${info.extension}`);
  capture.videoFd = fs.openSync(capture.videoPath, 'w');

  state.state = 'recording';
  state.elapsedSeconds = 0;
  startTime = Date.now();
  lastMicSignal = Date.now();
  logLine(`Запись начата. Видео: ${info.extension}, звук системы: ${info.hasSystemAudio}, микрофон: ${settings.selectedMicrophoneID}`);
  if (!info.hasSystemAudio) {
    state.errorMessage = 'Звук собеседника не захватывается. Записываются только экран и микрофон.';
  }
  sleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
  startLive();
  timer = setInterval(() => {
    state.elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    state.micSilent = Date.now() - lastMicSignal > 10000;
    pushState();
  }, 1000);
  pushState();
});

ipcMain.on('capture:video', (_event, buffer) => {
  if (!capture || capture.videoFd === null) return;
  try {
    fs.writeSync(capture.videoFd, Buffer.from(buffer));
  } catch (error) {
    failRecording(error.message);
  }
});

ipcMain.on('capture:pcm', (_event, track, buffer, peak) => {
  if (!capture || (track !== 'mic' && track !== 'system')) return;
  try {
    capture[track].append(new Uint8Array(buffer));
    if (liveStt) liveStt.feed(track, new Int16Array(buffer));
  } catch (error) {
    failRecording(error.message);
    return;
  }
  if (track === 'mic') {
    state.micLevel = peak;
    if (peak > 0.0003) lastMicSignal = Date.now();
  } else {
    state.systemLevel = peak;
  }
  pushState();
});

function failRecording(message) {
  if (state.state === 'recording') {
    state.errorMessage = `Запись остановлена: ${message}`;
    stopRecording();
  }
}

ipcMain.on('capture:failed', (_event, message) => {
  if (state.state === 'starting') {
    discardCapture();
    state.state = 'idle';
    if (mainWindow) mainWindow.setContentProtection(false);
    state.errorMessage = `Не удалось начать запись: ${message}`;
    pushState();
  } else {
    failRecording(message);
  }
});

let onStopped = null;

function stopRecording() {
  if (state.state !== 'recording' || !capture || capture.stopping) return;
  capture.stopping = true;
  state.state = 'stopping';
  clearInterval(timer);
  stopLive();
  if (sleepBlocker !== null) {
    powerSaveBlocker.stop(sleepBlocker);
    sleepBlocker = null;
  }
  pushState();
  mainWindow.webContents.send('capture:stop');
}

ipcMain.on('capture:stopped', () => {
  if (!capture) return;
  const finished = capture;
  capture = null;

  finished.mic.close();
  finished.system.close();
  if (finished.videoFd !== null) fs.closeSync(finished.videoFd);
  writeSessionInfo(finished);

  if (mainWindow) mainWindow.setContentProtection(false);
  state.lastRecordingFolder = finished.folder;
  state.state = 'idle';
  state.micLevel = 0;
  state.systemLevel = 0;
  state.micSilent = false;
  pushState();

  if (settings.transcribeAfterRecording && !isQuitting) {
    enqueueTranscription({ type: 'recording', path: finished.folder });
  }
  if (onStopped) {
    const callback = onStopped;
    onStopped = null;
    callback();
  }
});

function writeSessionInfo(finished) {
  const microphone = state.microphones.find((item) => item.id === settings.selectedMicrophoneID);
  const display = state.displays.find((item) => item.id === settings.selectedDisplayID);
  const info = {
    startedAt: finished.startedAt.toISOString(),
    durationSeconds: (Date.now() - finished.startedAt.getTime()) / 1000,
    microphone: microphone ? microphone.name : '',
    display: display ? display.name : '',
    files: {
      [`screen.${finished.extension}`]: 'видео с курсором и общей дорожкой звука',
      'mic.wav': 'только микрофон, это вы',
      'system.wav': 'только звук системы, это собеседник',
      'transcript.md': 'расшифровка диалога',
      'transcript.json': 'расшифровка диалога с метками времени в секундах',
    },
    timeline: 'аудиофайлы начинаются в один момент, метки времени совпадают',
  };
  fs.writeFileSync(path.join(finished.folder, 'session.json'), JSON.stringify(info, null, 2));
}

ipcMain.on('capture:microphones', (_event, list, granted) => {
  state.microphones = list;
  state.micPermissionMissing = !granted;
  if (!list.some((item) => item.id === settings.selectedMicrophoneID)) {
    settings.selectedMicrophoneID = list.length ? list[0].id : '';
  }
  pushState();
});

/* Модель распознавания */
async function downloadFile(url, target, expectedSize, onProgress) {
  const partial = `${target}.part`;
  const response = await net.fetch(url);
  if (!response.ok) throw new Error(`сервер ответил кодом ${response.status}`);

  const total = Number(response.headers.get('content-length')) || expectedSize;
  const output = fs.openSync(partial, 'w');
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      fs.writeSync(output, value);
      received += value.length;
      onProgress(received / total);
    }
  } finally {
    fs.closeSync(output);
  }
  if (received !== total) {
    fs.rmSync(partial, { force: true });
    throw new Error('файл скачался не полностью');
  }
  fs.renameSync(partial, target);
}

async function ensureModel(quality = settings.modelQuality, onProgress = null) {
  const model = whisper.MODELS[quality];
  const target = path.join(paths.models(), model.file);
  if (fs.existsSync(target) && fs.statSync(target).size === model.size) return target;

  fs.mkdirSync(paths.models(), { recursive: true });
  const report = onProgress || ((progress) => {
    state.transcriptionStage = 'download';
    state.transcriptionProgress = progress;
    pushState();
  });
  report(0);
  try {
    await downloadFile(whisper.MODEL_BASE + model.file, target, model.size, report);
  } catch (error) {
    throw new Error(
      `Не удалось скачать модель распознавания (${error.message}). `
      + `Проверьте интернет или VPN. Файл можно скачать вручную и положить в папку ${paths.models()}: `
      + `${whisper.MODEL_BASE}${model.file}`
    );
  }
  return target;
}

/* Живое распознавание и подсказки */
let liveStt = null;
let liveGeneration = 0;

function serverPath() {
  if (isTest && process.env.IR_TEST_WHISPER_SERVER) return process.env.IR_TEST_WHISPER_SERVER;
  return path.join(paths.whisperDir(), 'whisper-server.exe');
}

// Для живых подсказок важнее скорость, поэтому используем лёгкую модель.
// Она скачивается заранее, иначе на первой записи подсказки появились бы только после загрузки.
let liveModelDownload = null;

function liveModel() {
  if (!liveModelDownload) {
    liveModelDownload = ensureModel(settings.liveQuality, (progress) => {
      state.liveStatus = `Скачиваю модель для подсказок: ${Math.round(progress * 100)}%.`;
      pushState();
    }).finally(() => {
      liveModelDownload = null;
      if (state.liveStatus.startsWith('Скачиваю модель')) state.liveStatus = '';
      pushState();
    });
  }
  return liveModelDownload;
}

function prepareLiveModel() {
  if (settings.liveEnabled && readKeys()[settings.llmProvider]) {
    liveModel().catch((error) => {
      logLine(`Модель для подсказок не скачана: ${error.message}`);
      state.liveStatus = `Модель для подсказок не скачана: ${error.message}`;
      pushState();
    });
  }
}

/** Заранее открытое соединение с сервисом экономит время первого запроса. */
let keepAliveTimer = null;

function startKeepAlive() {
  stopKeepAlive();
  if (isTest) return;
  const ping = () => {
    net.fetch(new URL(llm.PROVIDERS[settings.llmProvider].url).origin, { method: 'HEAD' }).catch(() => {});
  };
  ping();
  keepAliveTimer = setInterval(ping, 20000);
}

function stopKeepAlive() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

async function startLive() {
  if (!settings.liveEnabled || !readKeys()[settings.llmProvider]) {
    logLine(`Подсказки выключены: включено ${settings.liveEnabled}, ключ ${Boolean(readKeys()[settings.llmProvider])}`);
    return;
  }
  liveGeneration += 1;
  const generation = liveGeneration;
  state.liveStats = { found: { system: 0, mic: 0 }, empty: 0, lastMs: 0, ready: false };
  startKeepAlive();
  try {
    const modelPath = await liveModel();
    if (generation !== liveGeneration) return;
    state.liveStatus = 'Запускаю распознавание речи. Запись уже идёт.';
    pushState();

    const stt = new LiveStt({
      exePath: serverPath(),
      modelPath,
      workDir: paths.liveWork(),
      language: settings.transcriptionLanguage,
      onText: (track, text, recognitionMs) => {
        // Время от конца фразы: пауза, по которой определён её конец, плюс распознавание.
        if (mainWindow) mainWindow.webContents.send('coach:speech', track, text, recognitionMs + 350);
      },
      onError: (message) => {
        state.liveStatus = `Ошибка живого распознавания: ${message}. Запись продолжается.`;
        pushState();
      },
      onLog: logLine,
      onStats: (stats) => {
        state.liveStats = { ...stats, ready: true };
        pushState();
      },
    });
    liveStt = stt;
    await stt.start();
    if (generation !== liveGeneration) {
      stt.stop();
      return;
    }
    state.liveStatus = '';
    state.liveStats = { ...state.liveStats, ready: true };
  } catch (error) {
    logLine(`Подсказки недоступны: ${error.message}`);
    state.liveStatus = `Подсказки недоступны: ${error.message}. Запись продолжается.`;
    if (liveStt) liveStt.stop();
    liveStt = null;
  }
  pushState();
}

function stopLive() {
  stopKeepAlive();
  liveGeneration += 1;
  if (liveStt) liveStt.stop();
  liveStt = null;
  state.liveStatus = '';
  state.liveStats = null;
}

async function runLlm(request) {
  const provider = settings.llmProvider;
  const reply = (channel, ...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  };
  try {
    const apiKey = loadApiKey(provider);
    if (!apiKey) throw new Error('API-ключ не добавлен или не читается, сохраните его заново');
    const options = {
      fetchImpl: net.fetch,
      url: isTest ? process.env.IR_TEST_LLM_URL : undefined,
      provider,
      model: llmModel(),
      apiKey,
      messages: request.messages,
      maxTokens: request.maxTokens,
      idleTimeoutMs: isTest && process.env.IR_TEST_LLM_TIMEOUT ? Number(process.env.IR_TEST_LLM_TIMEOUT) : undefined,
      onText: (text) => reply('coach:llmDelta', request.id, text),
    };
    let result;
    try {
      result = await llm.streamChat(options);
    } catch (error) {
      // Зависший запрос повторяем один раз, если ответ ещё не начал приходить.
      if (!error.isTimeout || error.textLength) throw error;
      logLine(`Запрос ${request.id}: сервис не ответил, повторяю`);
      result = await llm.streamChat(options);
    }
    logLine(`Запрос ${request.id}: первый ответ через ${result.firstByteMs} мс, всего ${result.totalMs} мс, символов ${result.textLength}`);
    reply('coach:llmDone', request.id, null);
  } catch (error) {
    logLine(`Запрос ${request.id}: ошибка: ${error.message}`);
    reply('coach:llmDone', request.id, error.message);
  }
}

function saveReport(report) {
  const folder = state.reportFolder;
  if (!folder || !fs.existsSync(folder)) return;
  fs.writeFileSync(path.join(folder, 'interview-report.md'), report.markdown);
  fs.writeFileSync(path.join(folder, 'interview-report.json'), report.json);
}

/* Расшифровка */
const queue = [];

function exePath() {
  if (isTest && process.env.IR_TEST_WHISPER) return process.env.IR_TEST_WHISPER;
  return path.join(paths.whisperDir(), 'whisper-cli.exe');
}

function decibels(peak) {
  return peak > 0 ? `${Math.round(20 * Math.log10(peak))} дБ` : 'тишина';
}

/** Возвращает фразы и пояснение, если речи в дорожке не нашлось. */
async function runWhisper(modelPath, wavPath, speaker, from, to, label) {
  repairWav(wavPath);
  const audio = analyzeWav(wavPath);
  logLine(`${label}: ${audio.seconds.toFixed(1)} с, пик ${decibels(audio.peak)}`);

  // Тишину незачем распознавать: важнее сразу сообщить, что звук не записался.
  if (audio.peak < 0.002) {
    return { segments: [], note: `${label}: в записи нет звука (${decibels(audio.peak)}, ${Math.round(audio.seconds)} с). Проверьте устройство на вкладке «Настройки», раздел «Проверка звука».` };
  }

  // Тихую дорожку распознаём по усиленной копии: так фильтр речи и Whisper работают заметно надёжнее.
  let input = wavPath;
  const boosted = `${paths.work()}-boosted.wav`;
  if (audio.peak < 0.3) {
    const gain = Math.min(0.7 / audio.peak, 30);
    logLine(`${label}: тихая дорожка, усиление в ${gain.toFixed(1)} раза`);
    fs.mkdirSync(path.dirname(boosted), { recursive: true });
    writeBoostedWav(wavPath, boosted, gain);
    input = boosted;
  }

  const recognize = (useVad, start, end) => {
    state.transcriptionStage = 'recognize';
    state.transcriptionProgress = start;
    pushState();
    return whisper.transcribeWav({
      exePath: exePath(),
      vadPath: path.join(paths.whisperDir(), whisper.VAD_MODEL),
      modelPath,
      wavPath: input,
      workDir: paths.work(),
      language: settings.transcriptionLanguage,
      speaker,
      useVad,
      onLog: logLine,
      onProgress: (progress) => {
        state.transcriptionProgress = start + progress * (end - start);
        pushState();
      },
    });
  };

  const middle = (from + to) / 2;
  let segments;
  try {
    segments = await recognize(true, from, middle);
    if (segments.length === 0) {
      // Звук есть, а фильтр речи ничего не нашёл: проверяем дорожку целиком.
      logLine(`${label}: фильтр речи ничего не нашёл, повторяю без него`);
      segments = await recognize(false, middle, to);
    }
  } finally {
    fs.rmSync(boosted, { force: true });
  }
  logLine(`${label}: распознано фраз ${segments.length}`);
  return {
    segments,
    note: segments.length ? '' : `${label}: звук есть (пик ${decibels(audio.peak)}), но речь в нём не найдена.`,
  };
}

async function transcribeRecording(folder) {
  const micPath = path.join(folder, 'mic.wav');
  const systemPath = path.join(folder, 'system.wav');
  if (!fs.existsSync(micPath) || !fs.existsSync(systemPath)) {
    throw new Error('В папке нет файлов mic.wav и system.wav.');
  }
  const modelPath = await ensureModel();
  const mic = await runWhisper(modelPath, micPath, 'me', 0, 0.5, 'Ваш голос');
  const system = await runWhisper(modelPath, systemPath, 'interviewer', 0.5, 1, 'Собеседник');

  const turns = transcript.buildDialogue(mic.segments, system.segments);
  const target = path.join(folder, 'transcript.md');
  const notes = [mic.note, system.note].filter(Boolean);
  fs.writeFileSync(target, transcript.markdown(turns, `Запись: ${path.basename(folder)}`, notes));
  fs.writeFileSync(path.join(folder, 'transcript.json'), transcript.json(turns));
  return target;
}

let decodeCounter = 0;
const pendingDecodes = new Map();

ipcMain.on('decode:result', (_event, id, error, samples) => {
  const pending = pendingDecodes.get(id);
  if (!pending) return;
  pendingDecodes.delete(id);
  if (error) {
    pending.reject(new Error(error));
  } else {
    pending.resolve(new Uint8Array(samples));
  }
});

function decodeInWindow(filePath) {
  const { size } = fs.statSync(filePath);
  if (size > 1.5 * 1024 * 1024 * 1024) {
    return Promise.reject(new Error('Файл больше 1,5 ГБ. Извлеките из него звук и выберите аудиофайл.'));
  }
  const data = fs.readFileSync(filePath);
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return new Promise((resolve, reject) => {
    decodeCounter += 1;
    pendingDecodes.set(decodeCounter, { resolve, reject });
    mainWindow.webContents.send('decode:request', decodeCounter, buffer);
  });
}

async function transcribeFile(filePath) {
  const modelPath = await ensureModel();
  state.transcriptionStage = 'recognize';
  state.transcriptionProgress = 0;
  pushState();

  const samples = await decodeInWindow(filePath);
  fs.mkdirSync(path.dirname(paths.work()), { recursive: true });
  const temporary = `${paths.work()}-decoded.wav`;
  let result;
  try {
    writeWavFile(temporary, samples);
    result = await runWhisper(modelPath, temporary, 'unknown', 0, 1, 'Файл');
  } finally {
    fs.rmSync(temporary, { force: true });
  }

  const base = path.join(path.dirname(filePath), `${path.parse(filePath).name}.transcript`);
  const target = `${base}.md`;
  const notes = result.note ? [result.note] : [];
  fs.writeFileSync(target, transcript.markdown(result.segments, `Файл: ${path.basename(filePath)}`, notes));
  fs.writeFileSync(`${base}.json`, transcript.json(result.segments));
  return target;
}

function enqueueTranscription(job) {
  queue.push(job);
  processQueue();
}

async function processQueue() {
  if (state.isTranscribing || queue.length === 0) return;
  const job = queue.shift();
  state.isTranscribing = true;
  state.transcriptionProgress = 0;
  state.transcriptionError = '';
  pushState();

  try {
    const target = job.type === 'recording'
      ? await transcribeRecording(job.path)
      : await transcribeFile(job.path);
    state.lastTranscriptPath = target;
    // Во время новой записи файл не открываем: он перекрыл бы окно звонка.
    if (settings.openTranscriptAutomatically && state.state === 'idle') {
      await openTranscript();
    }
  } catch (error) {
    if (!isQuitting) {
      logLine(`Ошибка расшифровки: ${error.message}`);
      state.transcriptionError = `Не удалось расшифровать: ${error.message} `
        + 'Исходные файлы сохранены, расшифровку можно повторить.';
    }
  }
  state.isTranscribing = false;
  pushState();
  processQueue();
}

async function openTranscript() {
  if (!state.lastTranscriptPath || isTest) return;
  const failure = await shell.openPath(state.lastTranscriptPath);
  if (failure && process.platform === 'win32') {
    // Если для .md не назначена программа, открываем в Блокноте.
    spawn('notepad.exe', [state.lastTranscriptPath], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function chooseExistingFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите файл записи',
    buttonLabel: 'Расшифровать',
    defaultPath: recordingsRoot(),
    properties: ['openFile'],
    filters: [
      { name: 'Аудио и видео', extensions: ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'mp4', 'mov', 'webm', 'mkv'] },
      { name: 'Все файлы', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return;
  enqueueTranscription(jobForFile(result.filePaths[0]));
}

/** Любой файл из папки записи обрабатываем как всю запись: так сохраняется разделение на собеседников. */
function jobForFile(filePath) {
  const folder = path.dirname(filePath);
  const hasTracks = ['mic.wav', 'system.wav'].every((name) => fs.existsSync(path.join(folder, name)));
  return hasTracks ? { type: 'recording', path: folder } : { type: 'file', path: filePath };
}

async function chooseSaveFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите папку для новых записей',
    buttonLabel: 'Выбрать',
    defaultPath: recordingsRoot(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!result.canceled && result.filePaths.length) {
    settings.customSaveFolderPath = result.filePaths[0];
    saveSettings();
    pushState();
  }
}

function openRecordingsFolder() {
  const folder = state.lastRecordingFolder || recordingsRoot();
  fs.mkdirSync(folder, { recursive: true });
  shell.openPath(folder);
}

/* Команды интерфейса */
const actions = {
  ready() {
    loadDisplays();
    if (mainWindow) mainWindow.webContents.send('ui:state', interfaceState());
  },
  toggleRecording() {
    if (state.state === 'recording') stopRecording();
    else startRecording();
  },
  selectDisplay(value) {
    if (state.state === 'idle') { settings.selectedDisplayID = String(value); saveSettings(); }
  },
  selectMicrophone(value) {
    if (state.state === 'idle') { settings.selectedMicrophoneID = String(value); saveSettings(); }
  },
  setTranscribe(value) { settings.transcribeAfterRecording = Boolean(value); saveSettings(); },
  setAutoOpen(value) { settings.openTranscriptAutomatically = Boolean(value); saveSettings(); },
  setLanguage(value) {
    if (value === 'ru' || value === 'en') { settings.transcriptionLanguage = value; saveSettings(); }
  },
  setModelQuality(value) {
    if (whisper.MODELS[value]) { settings.modelQuality = value; saveSettings(); }
  },
  chooseSaveFolder,
  resetSaveFolder() { settings.customSaveFolderPath = null; saveSettings(); },
  transcribeExisting: chooseExistingFile,
  openRecordingsFolder,
  openLastTranscript: openTranscript,
  openMicrophoneSettings() { shell.openExternal('ms-settings:privacy-microphone'); },
  setLiveQuality(value) {
    if (value === 'live' || value === 'fast') {
      settings.liveQuality = value;
      saveSettings();
      prepareLiveModel();
    }
  },
  setLiveEnabled(value) {
    settings.liveEnabled = Boolean(value);
    saveSettings();
    prepareLiveModel();
  },
  setLlmProvider(value) {
    if (llm.PROVIDERS[value]) { settings.llmProvider = value; saveSettings(); }
  },
  setLlmModel(value) {
    settings.llmModels[settings.llmProvider] = String(value || '');
    saveSettings();
  },
  setQuestionSource(value) {
    if (value === 'interviewer' || value === 'both') { settings.questionSource = value; saveSettings(); }
  },
  saveApiKey(value) {
    try {
      saveApiKey(settings.llmProvider, String(value));
      prepareLiveModel();
    } catch (error) {
      state.errorMessage = `Не удалось сохранить ключ: ${error.message}`;
    }
  },
  deleteApiKey() { saveApiKey(settings.llmProvider, ''); },
  syncState() {},
  liveLog(value) { logLine(`Подсказки: ${value}`); },
  openDiagnostics() {
    fs.mkdirSync(path.dirname(paths.diagnostics()), { recursive: true });
    if (!fs.existsSync(paths.diagnostics())) fs.writeFileSync(paths.diagnostics(), '');
    shell.openPath(paths.diagnostics());
  },
  llmRequest: runLlm,
  saveReport,
};

ipcMain.on('ui:action', (_event, action, value) => {
  if (Object.prototype.hasOwnProperty.call(actions, action)) {
    actions[action](value);
    pushState();
  }
});

/* Окно и трей */
function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 540,
    height: 740,
    useContentSize: true,
    minWidth: 540,
    maxWidth: 540,
    minHeight: 480,
    maximizable: false,
    title: 'Interview Assistant',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#f2f2f7',
    autoHideMenuBar: true,
    show: !isTest || Boolean(process.env.IR_TEST_SHOW),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Запись не должна замедляться, когда окно свёрнуто или скрыто в трей.
      backgroundThrottling: false,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // Внешние ссылки и переходы из окна приложения запрещены.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.on('close', (event) => {
    // Пока идёт запись или расшифровка, приложение остаётся работать в трее.
    if (!isQuitting && (state.state !== 'idle' || state.isTranscribing)) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function updateTray() {
  if (!tray) return;
  const recording = state.state === 'recording';
  tray.setToolTip(recording ? `Interview Assistant: идёт запись, ${elapsedText()}` : 'Interview Assistant');
  const signature = `${state.state}`;
  if (tray.signature === signature) return;
  tray.signature = signature;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: recording ? 'Остановить запись' : 'Начать запись',
      enabled: state.state === 'idle' || recording,
      click: () => actions.toggleRecording(),
    },
    { label: 'Показать окно', click: showWindow },
    { label: 'Открыть папку записей', click: openRecordingsFolder },
    { type: 'separator' },
    { label: 'Выйти', click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  tray.on('click', showWindow);
  updateTray();
}

/* Запуск и завершение */
app.on('second-instance', showWindow);

app.on('before-quit', (event) => {
  if (isQuitting) return;
  isQuitting = true;
  whisper.cancelActive();
  stopLive();
  // Если идёт запись, сначала корректно закрываем файлы.
  if (state.state === 'recording') {
    event.preventDefault();
    onStopped = () => app.quit();
    stopRecording();
  }
});

app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  loadSettings();

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => (
    permission === 'media' || permission === 'mediaKeySystem'
  ));

  // Экран для записи выбирает само приложение. Звук системы на Windows захватывается через loopback.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const source = sources.find((item) => item.display_id === settings.selectedDisplayID) || sources[0];
      if (!source) throw new Error('экран не найден');
      const stream = { video: source };
      if (process.platform === 'win32') stream.audio = 'loopback';
      callback(stream);
    } catch {
      callback({});
    }
  });

  createWindow();
  createTray();
  if (!isTest) prepareLiveModel();
  screen.on('display-added', loadDisplays);
  screen.on('display-removed', loadDisplays);
  screen.on('display-metrics-changed', loadDisplays);
});
