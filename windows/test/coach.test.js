const test = require('node:test');
const assert = require('node:assert');
const { createCoach } = require('../ui/coach');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Имитация LLM: отвечает по содержимому запроса, текст приходит частями. */
function harness(reply, optionsOverride) {
  const calls = [];
  const saved = [];
  const errors = [];
  let coach;
  const host = {
    llm(id, messages) {
      const user = messages[messages.length - 1].content;
      const isEval = messages[0].content.startsWith('Оцени');
      calls.push({ id, user, isEval });
      setTimeout(async () => {
        const answer = reply(user, isEval);
        if (answer instanceof Error) { coach.llmDone(id, answer.message); return; }
        for (let i = 0; i < answer.length; i += 7) {
          coach.llmDelta(id, answer.slice(i, i + 7));
          await wait(1);
        }
        coach.llmDone(id, null);
      }, 2);
    },
    save: (md, json) => saved.push({ md, json }),
    onError: (message) => errors.push(message),
  };
  coach = createCoach(host, { pauseMs: 15, answerPauseMs: 25, finishTimeoutMs: 500, ...optionsOverride });
  return { coach, calls, saved, errors };
}

const scripted = (user, isEval) => {
  if (isEval) {
    if (user.includes('подпись')) return 'VERDICT: CORRECT\nCOMMENT: Ответ верный.';
    if (user.includes('не знаю')) return 'VERDICT: WRONG\nCOMMENT: Ответа по сути нет.';
    return 'VERDICT: PARTIAL\nCOMMENT: Не хватило примеров.';
  }
  const phrase = user.split('Новая фраза: ')[1];
  if (phrase.includes('JWT')) return 'QUESTION: Что такое JWT?\n- Заголовок, нагрузка, подпись\n- Base64URL\n';
  if (phrase.includes('REST')) return 'QUESTION: Что такое REST?\nРесурсы и HTTP-методы';
  if (phrase.includes('Kafka')) return 'QUESTION: Что такое Kafka?\nЛог событий';
  if (phrase.includes('подробнее')) return 'SAME';
  return 'NONE';
};

test('вопрос, подсказка, ответ и галочка', async () => {
  const { coach } = harness(scripted);
  coach.start({ questionSource: 'interviewer' });
  coach.speech('system', 'Добрый день', false);
  await wait(40);
  assert.strictEqual(coach.snapshot().cards.length, 0, 'приветствие не вопрос');

  coach.speech('system', 'Что такое', false);
  coach.speech('system', 'Что такое JWT токен', false);
  await wait(10);
  assert.strictEqual(coach.snapshot().cards.length, 0, 'ждём паузу');
  assert.strictEqual(coach.snapshot().interim.system, 'Что такое JWT токен');
  await wait(60);
  let card = coach.snapshot().cards[0];
  assert.strictEqual(card.question, 'Что такое JWT?');
  assert.strictEqual(card.hint, 'Заголовок, нагрузка, подпись\nBase64URL');

  coach.speech('mic', 'Токен из трёх частей, главное подпись', true);
  await wait(10);
  assert.strictEqual(coach.snapshot().cards[0].answer, 'Токен из трёх частей, главное подпись');
  await wait(100);
  card = coach.snapshot().cards[0];
  assert.strictEqual(card.verdict, 'correct');
  assert.strictEqual(card.comment, 'Ответ верный.');
});

test('промежуточный текст не дублирует отправленное, финал не повторяет вопрос', async () => {
  const { coach, calls } = harness(scripted);
  coach.start({});
  coach.speech('system', 'Что такое JWT', false);
  await wait(50);
  assert.strictEqual(coach.snapshot().cards.length, 1);
  coach.speech('system', 'Что такое JWT', true);
  await wait(30);
  assert.strictEqual(calls.filter((c) => !c.isEval).length, 1, 'повторного запроса нет');
  assert.strictEqual(coach.snapshot().cards.length, 1);
});

test('продолжение вопроса и фрагменты', async () => {
  const { coach, calls } = harness(scripted);
  coach.start({});
  coach.speech('system', 'Скажите пожалуйста', true);
  await wait(30);
  coach.speech('system', 'что такое REST', true);
  await wait(30);
  assert.strictEqual(coach.snapshot().cards.length, 1);
  assert.ok(calls.some((c) => c.user.includes('Новая фраза: Скажите пожалуйста что такое REST')), 'фрагмент склеен');
  coach.speech('system', 'расскажите подробнее', true);
  await wait(30);
  assert.strictEqual(coach.snapshot().cards.length, 1, 'SAME не создаёт карточку');
});

test('эхо собеседника не становится ответом', async () => {
  const { coach } = harness(scripted);
  coach.start({});
  coach.speech('system', 'Что такое JWT', true);
  await wait(30);
  coach.speech('mic', 'что такое JWT', true);
  await wait(5);
  assert.strictEqual(coach.snapshot().cards[0].answer, '');
  coach.speech('mic', 'Это подпись и данные', true);
  await wait(5);
  assert.strictEqual(coach.snapshot().cards[0].answer, 'Это подпись и данные');
});

test('подсказка не длиннее 10 строк', async () => {
  const long = 'QUESTION: Что такое JWT?\n' + Array.from({ length: 15 }, (_, i) => `- строка ${i}`).join('\n');
  const { coach } = harness((u, isEval) => (isEval ? 'VERDICT: WRONG\nCOMMENT: x' : long));
  coach.start({});
  coach.speech('system', 'Вопрос про JWT', true);
  await wait(50);
  assert.strictEqual(coach.snapshot().cards[0].hint.split('\n').length, 10);
});

test('итоговая статистика и отчёт', async () => {
  const { coach, saved } = harness(scripted);
  coach.start({});
  coach.speech('system', 'Что такое JWT', true);
  await wait(30);
  coach.speech('mic', 'Главное подпись', true);
  await wait(5);
  coach.speech('system', 'Что такое REST', true);
  await wait(30);
  coach.speech('mic', 'Ну я не знаю', true);
  await wait(5);
  coach.speech('system', 'Что такое Kafka', true);
  await wait(30);
  coach.speech('mic', 'Брокер сообщений', true);
  await wait(5);
  coach.speech('system', 'А что такое JWT еще раз', true);
  const summary = await coach.stop();
  assert.strictEqual(summary.total, 4);
  assert.strictEqual(summary.correct, 1);
  assert.strictEqual(summary.wrong, 1);
  assert.strictEqual(summary.partial, 1);
  assert.strictEqual(summary.unanswered, 1);
  assert.strictEqual(summary.correctShare, 25);
  assert.strictEqual(coach.snapshot().phase, 'finished');
  assert.strictEqual(saved.length, 1);
  assert.ok(saved[0].md.includes('Правильных ответов: 1 (25%)'));
  assert.ok(saved[0].md.includes('## 2. Что такое REST?'));
  assert.ok(saved[0].md.includes('**Ваш ответ:** Ну я не знаю'));
  assert.strictEqual(JSON.parse(saved[0].json).questions.length, 4);
});

test('остановка дожидается незавершённого последнего ответа', async () => {
  const { coach } = harness(scripted);
  coach.start({});
  coach.speech('system', 'Что такое JWT', true);
  await wait(30);
  coach.speech('mic', 'Это подпись', false);
  const summary = await coach.stop();
  assert.strictEqual(coach.snapshot().cards[0].answer, 'Это подпись');
  assert.strictEqual(summary.correct, 1);
});

test('сбой LLM не ломает сессию и не зависает на остановке', async () => {
  const { coach, errors } = harness(() => new Error('401 неверный ключ'));
  coach.start({});
  coach.speech('system', 'Что такое JWT', true);
  await wait(30);
  assert.deepStrictEqual(errors, ['401 неверный ключ']);
  const summary = await coach.stop();
  assert.strictEqual(summary.total, 0);
});

test('режим самопроверки: вопрос и ответ с микрофона', async () => {
  const { coach } = harness(scripted);
  coach.start({ questionSource: 'both' });
  coach.speech('mic', 'Что такое JWT', true);
  await wait(30);
  coach.speech('mic', 'Это токен с подписью', true);
  await wait(70);
  const card = coach.snapshot().cards[0];
  assert.strictEqual(card.answer, 'Это токен с подписью');
  assert.strictEqual(card.verdict, 'correct');
});
