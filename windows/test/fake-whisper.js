#!/usr/bin/env node
// Заменяет whisper-cli в тестах: проверяет аргументы и входной файл, отдаёт заранее известный текст.
const fs = require('fs');
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
for (const flag of ['--model', '--file', '--language', '--threads', '--output-json', '--output-file', '--print-progress', '--vad', '--vad-model']) {
  if (!args.includes(flag)) { console.error('missing ' + flag); process.exit(2); }
}
for (const relative of [get('--model'), get('--file'), get('--vad-model')]) {
  if (relative.includes('/') || relative.includes('\\') || !fs.existsSync(relative)) { console.error('bad path ' + relative); process.exit(3); }
}
const wav = fs.readFileSync(get('--file'));
if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt32LE(24) !== 16000 || wav.readUInt32LE(40) !== wav.length - 44) { console.error('bad wav'); process.exit(4); }
let peak = 0; for (let i = 44; i + 1 < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
const seconds = (wav.length - 44) / 32000;
fs.appendFileSync(process.env.IR_FAKE_LOG, JSON.stringify({ language: get('--language'), seconds, peak }) + '\n');
console.error('whisper_print_progress_callback: progress =  50%');
const text = peak > 0 ? 'Фраза с сигналом' : 'Фраза из тишины';
fs.writeFileSync(get('--output-file') + '.json', JSON.stringify({ transcription: [
  { offsets: { from: 0, to: 900 }, text: ' [BLANK_AUDIO]' },
  { offsets: { from: 1000, to: 2000 }, text: ' ' + text + ' номер один.' },
] }));
