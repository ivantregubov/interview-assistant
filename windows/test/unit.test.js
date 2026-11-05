const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildDialogue, markdown, json, timestamp } = require('../lib/transcript');
const { WavWriter, repairWav } = require('../lib/wav');
const { parseSegments, isSpeech } = require('../lib/whisper');

const seg = (start, end, speaker, text) => ({ start, end, speaker, text });

test('диалог склеивает реплики и убирает эхо', () => {
  const system = [seg(0, 5, 'interviewer', 'Расскажите о вашем опыте работы.'), seg(5.5, 8, 'interviewer', 'Что такое идемпотентность?'), seg(30, 34, 'interviewer', 'Хорошо, спасибо.')];
  const mic = [seg(0.2, 5, 'me', 'Расскажите о вашем опыте работы'), seg(9, 15, 'me', 'Это свойство операции.'), seg(16, 20, 'me', 'Повторный вызов не меняет результат.'), seg(31, 32, 'me', 'Да')];
  const turns = buildDialogue(mic, system);
  assert.strictEqual(turns.length, 4);
  assert.ok(turns[0].text.includes('идемпотентность'));
  assert.strictEqual(turns[1].text, 'Это свойство операции. Повторный вызов не меняет результат.');
  assert.strictEqual(turns[3].text, 'Да');
  const text = markdown(turns, 'Запись: тест');
  assert.ok(text.includes('**[00:00:09] Я:** Это свойство'));
  assert.ok(text.includes('**[00:00:00] Интервьюер:**'));
  assert.strictEqual(JSON.parse(json(turns))[0].speaker, 'Интервьюер');
  assert.ok(markdown([], 'x').includes('Речь не распознана'));
  assert.strictEqual(timestamp(3725), '01:02:05');
});

test('WAV пишется и восстанавливается после сбоя', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-'));
  const file = path.join(dir, 'папка.wav');
  const w = new WavWriter(file);
  w.append(new Uint8Array(new Int16Array([1, 2, 3, 4]).buffer));
  w.close();
  let b = fs.readFileSync(file);
  assert.strictEqual(b.readUInt32LE(40), 8); assert.strictEqual(b.readUInt32LE(4), 44); assert.strictEqual(b.readUInt32LE(24), 16000);
  const crash = path.join(dir, 'crash.wav');
  const c = new WavWriter(crash);
  c.append(new Uint8Array(100));
  fs.closeSync(c.fd); // как при падении: заголовок не обновлён
  assert.strictEqual(fs.readFileSync(crash).readUInt32LE(40), 0);
  repairWav(crash);
  assert.strictEqual(fs.readFileSync(crash).readUInt32LE(40), 100);
});

test('разбор ответа Whisper отбрасывает служебные пометки', () => {
  assert.strictEqual(isSpeech('[BLANK_AUDIO]'), false);
  assert.strictEqual(isSpeech('(музыка)'), false);
  assert.strictEqual(isSpeech('Обычная речь (с пояснением).'), true);
  const out = parseSegments(JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1000 }, text: ' [BLANK_AUDIO]' }, { offsets: { from: 1500, to: 2500 }, text: ' Привет ' }] }), 'me');
  assert.deepStrictEqual(out, [{ start: 1.5, end: 2.5, speaker: 'me', text: 'Привет' }]);
});
