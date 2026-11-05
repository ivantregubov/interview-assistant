'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const MODELS = {
  accurate: { file: 'ggml-large-v3-turbo-q5_0.bin', size: 574041195 },
  fast: { file: 'ggml-small-q5_1.bin', size: 190085487 },
};
const VAD_MODEL = 'ggml-silero-v5.1.2.bin';
const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

// Эти коды Windows возвращает, если программа не смогла запуститься.
const EXIT_DLL_NOT_FOUND = 3221225781;
const EXIT_ILLEGAL_INSTRUCTION = 3221225501;

let activeChild = null;

function cancelActive() {
  if (activeChild) activeChild.kill();
}

function missingRuntime() {
  if (process.platform !== 'win32') return false;
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  return ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll'].some(
    (name) => !fs.existsSync(path.join(system32, name))
  );
}

function linkOrCopy(source, target) {
  fs.rmSync(target, { force: true });
  try {
    fs.linkSync(source, target);
  } catch {
    fs.copyFileSync(source, target);
  }
}

/** Служебные пометки Whisper вроде [BLANK_AUDIO] или (музыка) не являются речью. */
function isSpeech(text) {
  return text.length > 0 && !/^[\[(（♪*].*[\])）♪*]$/su.test(text);
}

function parseSegments(raw, speaker) {
  const data = JSON.parse(raw);
  const segments = [];
  for (const item of data.transcription || []) {
    const text = String(item.text || '').trim();
    if (!isSpeech(text)) continue;
    segments.push({
      start: item.offsets.from / 1000,
      end: item.offsets.to / 1000,
      speaker,
      text,
    });
  }
  return segments;
}

/**
 * Запускает whisper-cli и возвращает фразы с метками времени.
 * Все пути передаются относительно рабочей папки: так кириллица в имени пользователя
 * или в папке записи не попадает в аргументы консольной программы.
 */
function transcribeWav({ exePath, vadPath, modelPath, wavPath, workDir, language, speaker, onProgress }) {
  if (missingRuntime()) {
    return Promise.reject(new Error(
      `В Windows не установлен пакет Microsoft Visual C++ Redistributable. Скачайте его: ${VC_REDIST_URL}`
    ));
  }

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  linkOrCopy(modelPath, path.join(workDir, 'model.bin'));
  linkOrCopy(vadPath, path.join(workDir, 'vad.bin'));
  linkOrCopy(wavPath, path.join(workDir, 'input.wav'));

  const threads = Math.max(2, Math.min(8, Math.floor(os.cpus().length * 0.75)));
  const args = [
    '--model', 'model.bin',
    '--file', 'input.wav',
    '--language', language,
    '--threads', String(threads),
    '--output-json',
    '--output-file', 'output',
    '--print-progress',
    '--vad',
    '--vad-model', 'vad.bin',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, { cwd: workDir, windowsHide: true });
    activeChild = child;
    let log = '';

    const onData = (chunk) => {
      const text = chunk.toString();
      log = (log + text).slice(-4000);
      const matches = [...text.matchAll(/progress\s*=\s*(\d+)%/g)];
      if (matches.length) {
        onProgress(Number(matches[matches.length - 1][1]) / 100);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (error) => {
      activeChild = null;
      reject(new Error(`Не удалось запустить распознавание: ${error.message}`));
    });

    child.on('close', (code) => {
      activeChild = null;
      try {
        if (code === EXIT_DLL_NOT_FOUND) {
          throw new Error(`Не хватает компонентов Windows. Установите Microsoft Visual C++ Redistributable: ${VC_REDIST_URL}`);
        }
        if (code === EXIT_ILLEGAL_INSTRUCTION) {
          throw new Error('Этот процессор не поддерживает набор команд, нужный для распознавания.');
        }
        if (code !== 0) {
          const lastLine = log.trim().split(/\r?\n/).pop() || '';
          throw new Error(`Распознавание завершилось с кодом ${code}. ${lastLine}`.trim());
        }
        resolve(parseSegments(fs.readFileSync(path.join(workDir, 'output.json'), 'utf8'), speaker));
      } catch (error) {
        reject(error);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    });
  });
}

module.exports = { MODELS, MODEL_BASE, VAD_MODEL, transcribeWav, parseSegments, isSpeech, cancelActive };
