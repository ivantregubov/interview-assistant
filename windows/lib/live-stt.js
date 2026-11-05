'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { isSpeech, missingRuntime, VC_REDIST_URL, EXIT_DLL_NOT_FOUND } = require('./whisper');

const SAMPLE_RATE = 16000;
const FRAME = 320; // 20 мс

/**
 * Выделяет фразы из потока звука по громкости.
 * Фраза заканчивается после короткой тишины: от этого зависит задержка появления вопроса.
 */
class PhraseDetector {
  constructor(onPhrase, options = {}) {
    this.onPhrase = onPhrase;
    this.silenceFrames = Math.round((options.silenceMs || 350) / 20);
    this.minSpeechFrames = Math.round((options.minSpeechMs || 300) / 20);
    this.maxFrames = Math.round((options.maxPhraseMs || 8000) / 20);
    this.preRollFrames = Math.round((options.preRollMs || 300) / 20);
    this.noise = 0.001;
    this.pending = new Int16Array(0);
    this.preRoll = [];
    this.frames = [];
    this.speechFrames = 0;
    this.silence = 0;
    this.peak = 0;
    this.active = false;
  }

  feed(samples) {
    const joined = new Int16Array(this.pending.length + samples.length);
    joined.set(this.pending);
    joined.set(samples, this.pending.length);
    let offset = 0;
    while (offset + FRAME <= joined.length) {
      this.frame(joined.slice(offset, offset + FRAME));
      offset += FRAME;
    }
    this.pending = joined.slice(offset);
  }

  frame(frame) {
    let sum = 0;
    for (let index = 0; index < frame.length; index += 1) {
      const value = frame[index] / 32768;
      sum += value * value;
    }
    const level = Math.sqrt(sum / frame.length);
    // Порог считается от уровня шума: на тихом микрофоне речь бывает во много раз ниже полной шкалы.
    const threshold = Math.max(0.0015, this.noise * 3);
    const loud = level > threshold;
    // В тишине уровень шума подстраивается быстро, а во время звука медленно: так постоянный шум вентилятора не считается речью.
    const rate = loud ? 0.001 : 0.02;
    this.noise = this.noise * (1 - rate) + level * rate;

    if (!this.active) {
      this.preRoll.push(frame);
      if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      if (loud) {
        this.active = true;
        this.frames = [...this.preRoll];
        this.preRoll = [];
        this.speechFrames = 1;
        this.silence = 0;
        this.peak = level;
        this.startNoise = this.noise;
      }
      return;
    }

    this.frames.push(frame);
    this.peak = Math.max(this.peak, level);
    if (loud) {
      this.speechFrames += 1;
      this.silence = 0;
    } else {
      this.silence += 1;
    }
    if (this.silence >= this.silenceFrames || this.frames.length >= this.maxFrames) this.finish();
  }

  finish() {
    // Всплеск чуть выше шума речью не считаем: усиленный шум Whisper превращает в выдуманные фразы.
    const clear = this.peak >= Math.max(0.002, this.startNoise * 4);
    if (this.active && this.speechFrames >= this.minSpeechFrames && clear) {
      const output = new Int16Array(this.frames.length * FRAME);
      this.frames.forEach((frame, index) => output.set(frame, index * FRAME));
      this.onPhrase(output);
    }
    this.active = false;
    this.frames = [];
    this.speechFrames = 0;
    this.silence = 0;
    this.peak = 0;
  }
}

/** Выравнивает громкость фразы: Whisper хуже распознаёт очень тихую запись. */
function normalize(samples, targetPeak = 0.7, maxGain = 30) {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
  if (peak === 0) return samples;
  const gain = Math.min((targetPeak * 32767) / peak, maxGain);
  if (gain <= 1) return samples;
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) output[index] = Math.round(samples[index] * gain);
  return output;
}

function wavBuffer(samples) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(samples.buffer, samples.byteOffset, dataSize).copy(buffer, 44);
  return buffer;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function linkOrCopy(source, target) {
  fs.rmSync(target, { force: true });
  try {
    fs.linkSync(source, target);
  } catch {
    fs.copyFileSync(source, target);
  }
}

/** Живое распознавание: держит модель в памяти локального whisper-server и отправляет ему готовые фразы. */
class LiveStt {
  constructor({ exePath, modelPath, workDir, language, onText, onError, onLog = () => {}, onStats = () => {}, startTimeoutMs = 90000 }) {
    // Отдельная папка на каждый запуск: остановка прошлого сервера не помешает новому.
    const sessionDir = `${workDir}-${Date.now()}`;
    Object.assign(this, { exePath, modelPath, baseDir: workDir, workDir: sessionDir, language, onText, onError, onLog, onStats, startTimeoutMs });
    this.stats = { found: { system: 0, mic: 0 }, empty: 0, lastMs: 0 };
    this.queue = [];
    this.busy = false;
    this.running = false;
    this.child = null;
    this.detectors = {
      system: new PhraseDetector((samples) => this.enqueue('system', samples)),
      mic: new PhraseDetector((samples) => this.enqueue('mic', samples)),
    };
  }

  async start() {
    if (missingRuntime()) {
      throw new Error(`не установлен Microsoft Visual C++ Redistributable, скачайте его: ${VC_REDIST_URL}`);
    }
    this.removeOldFolders();
    fs.mkdirSync(this.workDir, { recursive: true });
    linkOrCopy(this.modelPath, path.join(this.workDir, 'model.bin'));

    this.port = await freePort();
    const threads = Math.max(2, Math.min(8, Math.floor(os.cpus().length * 0.5)));
    this.child = spawn(this.exePath, [
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '--model', 'model.bin',
      '--language', this.language,
      '--threads', String(threads),
      // Фразы не длиннее 8 секунд: меньший контекст заметно ускоряет распознавание.
      '--audio-ctx', '768',
      '--no-timestamps',
    ], { cwd: this.workDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.running = true;
    let output = '';
    const onOutput = (chunk) => { output = (output + chunk.toString()).slice(-2000); };
    this.child.stdout.on('data', onOutput);
    this.child.stderr.on('data', onOutput);

    await new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('exit', (code) => {
        this.onLog(`whisper-server завершился с кодом ${code}. Конец вывода:\n${output}`);
        if (!this.running) return;
        const message = code === EXIT_DLL_NOT_FOUND
          ? `не хватает компонентов Windows, установите Microsoft Visual C++ Redistributable: ${VC_REDIST_URL}`
          : `сервис распознавания завершился с кодом ${code}`;
        if (this.ready) this.onError(message);
        reject(new Error(message));
      });
      const deadline = Date.now() + this.startTimeoutMs;
      const poll = async () => {
        if (!this.running) { resolve(); return; }
        try {
          const response = await fetch(`http://127.0.0.1:${this.port}/health`);
          if (response.ok) { resolve(); return; }
        } catch {
          // Сервис ещё загружает модель.
        }
        if (Date.now() > deadline) reject(new Error('сервис распознавания не запустился вовремя'));
        else setTimeout(poll, 300);
      };
      poll();
    });
    await this.warmUp();
    this.ready = true;
    this.onLog('whisper-server готов');
    this.pump();
  }

  /** Первое распознавание самое долгое: выполняем его заранее на короткой тишине. */
  async warmUp() {
    try {
      await this.send(new Int16Array(16000));
    } catch (error) {
      this.onLog(`Прогрев распознавания не удался: ${error.message}`);
    }
  }

  /** Контекст подбирается под длину фразы: чем он короче, тем быстрее распознавание. */
  async send(samples) {
    const seconds = samples.length / 16000;
    const audioContext = Math.max(256, Math.min(768, Math.ceil((seconds + 0.5) * 50)));
    const form = new FormData();
    form.append('file', new Blob([wavBuffer(normalize(samples))], { type: 'audio/wav' }), 'phrase.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    form.append('temperature_inc', '0.0');
    form.append('audio_ctx', String(audioContext));
    // Строже обычного отбрасываем отрезки, где Whisper не уверен, что звучит речь.
    form.append('no_speech_thold', '0.45');
    const response = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: form });
    if (!response.ok) throw new Error(`код ${response.status}`);
    const data = await response.json();
    return String(data.text || '').replace(/\s+/g, ' ').trim();
  }

  removeOldFolders() {
    const parent = path.dirname(this.baseDir);
    const prefix = `${path.basename(this.baseDir)}-`;
    if (!fs.existsSync(parent)) return;
    for (const name of fs.readdirSync(parent)) {
      if (name.startsWith(prefix)) {
        try {
          fs.rmSync(path.join(parent, name), { recursive: true, force: true });
        } catch {
          // Папка ещё занята завершающимся процессом, уберём при следующем запуске.
        }
      }
    }
  }

  feed(track, samples) {
    if (this.running && this.detectors[track]) this.detectors[track].feed(samples);
  }

  enqueue(track, samples) {
    this.stats.found[track] += 1;
    this.onStats(this.stats);
    // Фразы собеседника важнее: они идут вперёд, а при перегрузке отбрасываем самые старые ответы.
    const item = { track, samples };
    if (track === 'system') {
      const index = this.queue.findIndex((queued) => queued.track !== 'system');
      if (index >= 0) this.queue.splice(index, 0, item);
      else this.queue.push(item);
    } else {
      this.queue.push(item);
    }
    // Устаревшая фраза бесполезна для подсказки, очередь держим короткой.
    if (this.queue.length > 4) {
      const index = this.queue.findIndex((queued) => queued.track === 'mic');
      this.queue.splice(index >= 0 ? index : 0, 1);
      this.stats.dropped = (this.stats.dropped || 0) + 1;
      this.onLog('Очередь распознавания переполнена, старая фраза пропущена');
    }
    this.pump();
  }

  async pump() {
    if (!this.ready || this.busy || !this.running || !this.queue.length) return;
    this.busy = true;
    const { track, samples } = this.queue.shift();
    const started = Date.now();
    try {
      const text = await this.send(samples);
      this.stats.lastMs = Date.now() - started;
      if (!isSpeech(text)) this.stats.empty += 1;
      this.onStats(this.stats);
      this.onLog(`Фраза ${track}: ${(samples.length / 16000).toFixed(1)} с, распознавание ${this.stats.lastMs} мс: ${text || '(пусто)'}`);
      if (this.running && isSpeech(text)) this.onText(track, text, Date.now() - started);
    } catch (error) {
      this.onLog(`Ошибка распознавания фразы: ${error.message}`);
      if (this.running) this.onError(error.message);
    }
    this.busy = false;
    this.pump();
  }

  stop() {
    this.running = false;
    this.ready = false;
    this.queue = [];
    if (this.child) this.child.kill();
    this.child = null;
    const { workDir } = this;
    setTimeout(() => {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // Уберём при следующем запуске.
      }
    }, 2000);
  }
}

module.exports = { PhraseDetector, LiveStt, wavBuffer, normalize };
