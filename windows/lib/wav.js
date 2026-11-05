'use strict';

const fs = require('fs');

const HEADER_SIZE = 44;

function header(dataSize, sampleRate) {
  const buffer = Buffer.alloc(HEADER_SIZE);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // моно
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

/** WAV 16 кГц, 16 бит, моно: формат, который напрямую читает Whisper. */
class WavWriter {
  constructor(filePath, sampleRate = 16000) {
    this.filePath = filePath;
    this.sampleRate = sampleRate;
    this.dataSize = 0;
    this.fd = fs.openSync(filePath, 'w');
    fs.writeSync(this.fd, header(0, sampleRate));
  }

  append(samples) {
    if (this.fd === null) return;
    const buffer = Buffer.from(samples);
    fs.writeSync(this.fd, buffer);
    this.dataSize += buffer.length;
  }

  close() {
    if (this.fd === null) return;
    fs.writeSync(this.fd, header(this.dataSize, this.sampleRate), 0, HEADER_SIZE, 0);
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

/** Если приложение упало, в заголовке останется нулевой размер: восстанавливаем его по размеру файла. */
function repairWav(filePath, sampleRate = 16000) {
  const size = fs.statSync(filePath).size;
  if (size <= HEADER_SIZE) return;
  const fd = fs.openSync(filePath, 'r+');
  try {
    const current = Buffer.alloc(HEADER_SIZE);
    fs.readSync(fd, current, 0, HEADER_SIZE, 0);
    if (current.toString('ascii', 0, 4) === 'RIFF' && current.readUInt32LE(40) === 0) {
      fs.writeSync(fd, header(size - HEADER_SIZE, sampleRate), 0, HEADER_SIZE, 0);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Пиковая громкость и длительность дорожки: показывает, попал ли в файл звук. */
function analyzeWav(filePath) {
  const { size } = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  let position = HEADER_SIZE;
  let peak = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read < 2) break;
      for (let offset = 0; offset + 1 < read; offset += 2) {
        const value = Math.abs(buffer.readInt16LE(offset));
        if (value > peak) peak = value;
      }
      position += read - (read % 2);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { seconds: Math.max(0, size - HEADER_SIZE) / 32000, peak: peak / 32768 };
}

/** Копия дорожки с усилением. Исходная запись не меняется. */
function writeBoostedWav(source, target, gain) {
  const input = fs.openSync(source, 'r');
  const output = fs.openSync(target, 'w');
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    fs.readSync(input, header, 0, HEADER_SIZE, 0);
    fs.writeSync(output, header);
    position = HEADER_SIZE;
    for (;;) {
      const read = fs.readSync(input, buffer, 0, buffer.length, position);
      if (read < 2) break;
      const usable = read - (read % 2);
      for (let offset = 0; offset < usable; offset += 2) {
        const value = Math.round(buffer.readInt16LE(offset) * gain);
        buffer.writeInt16LE(Math.max(-32768, Math.min(32767, value)), offset);
      }
      fs.writeSync(output, buffer, 0, usable);
      position += usable;
    }
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }
}

function writeWavFile(filePath, samples, sampleRate = 16000) {
  const writer = new WavWriter(filePath, sampleRate);
  writer.append(samples);
  writer.close();
}

module.exports = { WavWriter, repairWav, writeWavFile, analyzeWav, writeBoostedWav };
