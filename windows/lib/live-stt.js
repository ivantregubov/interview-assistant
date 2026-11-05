'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { isSpeech } = require('./whisper');

const SAMPLE_RATE = 16000;
const FRAME = 320; // 20 мс

/**
 * Выделяет фразы из потока звука по громкости.
 * Фраза заканчивается после короткой тишины: от этого зависит задержка появления вопроса.
 */
class PhraseDetector {
  constructor(onPhrase, options = {}) {
    this.onPhrase = onPhrase;
    this.silenceFrames = Math.round((options.silenceMs || 650) / 20);
    this.minSpeechFrames = Math.round((options.minSpeechMs || 200) / 20);
    this.maxFrames = Math.round((options.maxPhraseMs || 9000) / 20);
    this.preRollFrames = Math.round((options.preRollMs || 300) / 20);
    this.noise = 0.003;
    this.pending = new Int16Array(0);
    this.preRoll = [];
    this.frames = [];
    this.speechFrames = 0;
    this.silence = 0;
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
    const threshold = Math.max(0.008, this.noise * 3);
    const loud = level > threshold;
    if (!this.active && !loud) this.noise = this.noise * 0.98 + level * 0.02;

    if (!this.active) {
      this.preRoll.push(frame);
      if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      if (loud) {
        this.active = true;
        this.frames = [...this.preRoll];
        this.preRoll = [];
        this.speechFrames = 1;
        this.silence = 0;
      }
      return;
    }

    this.frames.push(frame);
    if (loud) {
      this.speechFrames += 1;
      this.silence = 0;
    } else {
      this.silence += 1;
    }
    if (this.silence >= this.silenceFrames || this.frames.length >= this.maxFrames) this.finish();
  }

  finish() {
    if (this.active && this.speechFrames >= this.minSpeechFrames) {
      const output = new Int16Array(this.frames.length * FRAME);
      this.frames.forEach((frame, index) => output.set(frame, index * FRAME));
      this.onPhrase(output);
    }
    this.active = false;
    this.frames = [];
    this.speechFrames = 0;
    this.silence = 0;
  }
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
  constructor({ exePath, modelPath, vadPath, workDir, language, onText, onError, startTimeoutMs = 90000 }) {
    Object.assign(this, { exePath, modelPath, vadPath, workDir, language, onText, onError, startTimeoutMs });
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
    fs.rmSync(this.workDir, { recursive: true, force: true });
    fs.mkdirSync(this.workDir, { recursive: true });
    linkOrCopy(this.modelPath, path.join(this.workDir, 'model.bin'));
    linkOrCopy(this.vadPath, path.join(this.workDir, 'vad.bin'));

    this.port = await freePort();
    const threads = Math.max(2, Math.min(6, Math.floor(os.cpus().length * 0.5)));
    this.child = spawn(this.exePath, [
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '--model', 'model.bin',
      '--language', this.language,
      '--threads', String(threads),
      '--vad',
      '--vad-model', 'vad.bin',
    ], { cwd: this.workDir, windowsHide: true, stdio: 'ignore' });
    this.running = true;

    await new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('exit', (code) => {
        if (this.running) reject(new Error(`сервис распознавания завершился с кодом ${code}`));
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
    this.ready = true;
    this.pump();
  }

  feed(track, samples) {
    if (this.running && this.detectors[track]) this.detectors[track].feed(samples);
  }

  enqueue(track, samples) {
    // Фразы собеседника важнее: они идут вперёд, а при перегрузке отбрасываем самые старые ответы.
    const item = { track, samples };
    if (track === 'system') {
      const index = this.queue.findIndex((queued) => queued.track !== 'system');
      if (index >= 0) this.queue.splice(index, 0, item);
      else this.queue.push(item);
    } else {
      this.queue.push(item);
    }
    if (this.queue.length > 8) {
      const index = this.queue.findIndex((queued) => queued.track === 'mic');
      this.queue.splice(index >= 0 ? index : 0, 1);
    }
    this.pump();
  }

  async pump() {
    if (!this.ready || this.busy || !this.running || !this.queue.length) return;
    this.busy = true;
    const { track, samples } = this.queue.shift();
    try {
      const form = new FormData();
      form.append('file', new Blob([wavBuffer(samples)], { type: 'audio/wav' }), 'phrase.wav');
      form.append('response_format', 'json');
      form.append('temperature', '0.0');
      const response = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: form });
      if (!response.ok) throw new Error(`код ${response.status}`);
      const data = await response.json();
      const text = String(data.text || '').replace(/\s+/g, ' ').trim();
      if (this.running && isSpeech(text)) this.onText(track, text);
    } catch (error) {
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
    setTimeout(() => fs.rmSync(workDir, { recursive: true, force: true }), 2000);
  }
}

module.exports = { PhraseDetector, LiveStt, wavBuffer };
