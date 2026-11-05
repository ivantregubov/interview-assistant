const test = require('node:test');
const assert = require('node:assert');
const { createCoach, sameQuestion } = require('../ui/coach');

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
  if (phrase.includes('CAP')) return 'QUESTION: Что такое CAP?\nТри свойства';
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
  coach.speech('system', 'А что такое CAP', true);
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
  // Сам вопрос остаётся на экране, даже если сервис не ответил.
  assert.strictEqual(coach.snapshot().cards[0].question, 'Что такое JWT');
  const summary = await coach.stop();
  assert.strictEqual(summary.total, 1);
  assert.strictEqual(summary.unanswered, 1);
});

test('явный вопрос появляется сразу, до ответа сервиса, и уточняется им', async () => {
  const { coach } = harness(scripted);
  coach.start({});
  coach.speech('system', 'Что такое JWT токен', true, 700);
  let card = coach.snapshot().cards[0];
  assert.strictEqual(card.question, 'Что такое JWT токен', 'карточка есть сразу');
  assert.ok(card.questionMs >= 700);
  assert.strictEqual(card.hint, '');
  await wait(40);
  card = coach.snapshot().cards[0];
  assert.strictEqual(card.question, 'Что такое JWT?');
  assert.ok(card.hint.includes('подпись'));
  assert.ok(card.hintMs >= card.questionMs);
  assert.ok(coach.snapshot().lastLatency.hint >= 700);
});

test('предварительный вопрос убирается, если сервис решил, что это не вопрос', async () => {
  const { coach } = harness((u, isEval) => (isEval ? 'VERDICT: CORRECT\nCOMMENT: ок' : 'NONE'));
  coach.start({});
  coach.speech('system', 'Как вам погода сегодня', true);
  assert.strictEqual(coach.snapshot().cards.length, 1);
  await wait(30);
  assert.strictEqual(coach.snapshot().cards.length, 0);
});

test('договорённый после паузы вопрос дополняется и получает новую подсказку', async () => {
  const seen = [];
  const { coach } = harness((user, isEval) => {
    if (isEval) return 'VERDICT: CORRECT\nCOMMENT: ок';
    seen.push(user);
    if (user.includes('Текущий вопрос') && user.includes('токен')) return 'SAME';
    if (user.includes('Новая фраза: Что такое? JWT токен')) return 'QUESTION: Что такое JWT-токен?\nТри части';
    return 'QUESTION: Что такое?\nНеясно';
  });
  coach.start({});
  coach.speech('system', 'Что такое?', true);
  await wait(30);
  coach.speech('system', 'JWT токен', true);
  await wait(60);
  const snapshot = coach.snapshot();
  assert.strictEqual(snapshot.cards.length, 1);
  assert.strictEqual(snapshot.cards[0].question, 'Что такое JWT-токен?');
  assert.strictEqual(snapshot.cards[0].hint, 'Три части');
});

test('одно слово не отправляется в сервис, а служебная строка не попадает в подсказку', async () => {
  const { coach, calls } = harness((u, isEval) => (isEval ? 'VERDICT: CORRECT\nCOMMENT: ок' : 'QUESTION: Что такое REST?\nКлючевые тезисы ответа:\n- Ресурсы'));
  coach.start({});
  coach.speech('system', 'Нефренно', true);
  await wait(10);
  assert.strictEqual(calls.length, 0);
  coach.speech('system', 'Что такое REST', true);
  await wait(30);
  assert.ok(calls[0].user.includes('Нефренно Что такое REST'), 'слово стало началом следующей фразы');
  assert.strictEqual(coach.snapshot().cards[0].hint, 'Ресурсы');
});

test('следующий вопрос не ждёт окончания предыдущей подсказки', async () => {
  const ids = [];
  let coach;
  const host = { llm: (id) => ids.push(id) };
  coach = createCoach(host, { pauseMs: 10, answerPauseMs: 20 });
  coach.start({});
  coach.speech('system', 'Что такое JWT', true);
  assert.strictEqual(ids.length, 1);
  coach.speech('system', 'Что такое REST', true);
  assert.strictEqual(ids.length, 1, 'пока решения нет, следующий ждёт');
  coach.llmDelta(ids[0], 'QUESTION: Что такое JWT?\n');
  assert.strictEqual(ids.length, 2, 'решение есть, а подсказка ещё идёт');
  coach.llmDelta(ids[0], 'Подсказка один\n');
  coach.llmDone(ids[0], null);
  coach.llmDelta(ids[1], 'QUESTION: Что такое REST?\nПодсказка два');
  coach.llmDone(ids[1], null);
  const cards = coach.snapshot().cards;
  assert.strictEqual(cards.length, 2);
  assert.strictEqual(cards[0].hint, 'Подсказка один');
  assert.strictEqual(cards[1].hint, 'Подсказка два');
});

test('приложение показывает услышанное и подсказывает про свои вопросы', async () => {
  const { coach } = harness(scripted);
  coach.start({ questionSource: 'interviewer' });
  coach.speech('mic', 'Что такое JWT', true);
  await wait(5);
  let snapshot = coach.snapshot();
  assert.strictEqual(snapshot.cards.length, 0);
  assert.strictEqual(snapshot.micIgnored, true);
  assert.deepStrictEqual(snapshot.heard, { mic: 1, system: 0 });
  assert.deepStrictEqual(snapshot.lastHeard, { track: 'mic', text: 'Что такое JWT' });
  coach.setQuestionSource('both');
  assert.strictEqual(coach.snapshot().micIgnored, false);
  coach.speech('mic', 'Что такое JWT', true);
  await wait(30);
  assert.strictEqual(coach.snapshot().cards.length, 1);
});

test('пустой ответ сервиса показывается как ошибка и не останавливает очередь', async () => {
  let call = 0;
  const { coach, errors } = harness((user, isEval) => {
    if (isEval) return 'VERDICT: CORRECT\nCOMMENT: ок';
    call += 1;
    return call === 1 ? '' : 'QUESTION: Что такое JWT?\nПодсказка';
  });
  coach.start({});
  coach.speech('system', 'Первая фраза', true);
  await wait(20);
  assert.deepStrictEqual(errors, ['сервис вернул пустой ответ']);
  coach.speech('system', 'Что такое JWT', true);
  await wait(40);
  assert.strictEqual(coach.snapshot().cards.length, 1);
  assert.strictEqual(coach.snapshot().lastDecision, 'question');
  assert.strictEqual(errors[errors.length - 1], '', 'ошибка снята после успешного ответа');
});

test('каждый вопрос собеседника становится отдельной карточкой', async () => {
  const { coach } = harness((u, isEval) => (isEval ? 'VERDICT: CORRECT\nCOMMENT: ок' : 'NONE'));
  coach.start({});
  coach.speech('system', 'Хорошо. Что такое JWT? А что такое REST? Верно?', true);
  await wait(50);
  const cards = coach.snapshot().cards;
  assert.deepStrictEqual(cards.map((c) => c.question), ['Что такое JWT?', 'А что такое REST?'], 'сервис ответил NONE, но вопросы остались');
});

test('вопрос кандидата собеседнику не попадает в ответ и оценку', async () => {
  const { coach, calls } = harness(scripted);
  coach.start({ questionSource: 'interviewer' });
  coach.speech('system', 'Что такое JWT', true);
  await wait(30);
  coach.speech('mic', 'Токен с подписью. А вы имеете в виду подпись? Там три части.', true);
  await wait(5);
  const card = coach.snapshot().cards[0];
  assert.strictEqual(card.answer, 'Токен с подписью. Там три части.');
  assert.deepStrictEqual(card.clarifications, ['А вы имеете в виду подпись?']);
  assert.strictEqual(coach.snapshot().cards.length, 1);
  await wait(60);
  const evaluation = calls.find((c) => c.isEval);
  assert.ok(!evaluation.user.includes('имеете в виду'));
});

test('если вопросы читает сам кандидат, его вопрос отдельный, а ответ отделяется', async () => {
  const { coach } = harness((u, isEval) => (isEval ? 'VERDICT: CORRECT\nCOMMENT: ок' : 'NONE'));
  coach.start({ questionSource: 'both' });
  coach.speech('mic', 'Почему ты так работаешь? Потому что так настроено.', true);
  await wait(40);
  const cards = coach.snapshot().cards;
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].question, 'Почему ты так работаешь?');
  assert.strictEqual(cards[0].answer, 'Потому что так настроено.');
  assert.ok(!cards[0].clarifications);
});

test('разбор предложений и очистка повторов', () => {
  const { splitByQuestions, cleanSpeech } = require('../ui/coach');
  assert.deepStrictEqual(splitByQuestions('Версия 1.5 готова. Как дела? Хорошо.'), [
    { text: 'Версия 1.5 готова.', isQuestion: false },
    { text: 'Как дела?', isQuestion: true },
    { text: 'Хорошо.', isQuestion: false },
  ]);
  assert.strictEqual(cleanSpeech(`Кэ${'э'.repeat(200)} дальше`), 'Кэ дальше');
  assert.strictEqual(cleanSpeech('Ну ооо хорошо'), 'Ну ооо хорошо');
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

const asks = (reply) => (u, isEval) => (isEval ? 'VERDICT: CORRECT\nCOMMENT: ок' : reply(u));

test('повторы вопроса определяются, а разные вопросы нет', () => {
  assert.ok(sameQuestion('Почему на Mac ты запускаешь службу?', 'А почему на Mac ты запускаешь службу'));
  assert.ok(sameQuestion('Как ты запускаешь службу?', 'как ты запускаете службы'));
  assert.ok(!sameQuestion('Как работает TCP?', 'Как работает UDP?'));
  assert.ok(!sameQuestion('Что такое Kafka?', 'Почему Kafka?'));
  assert.ok(!sameQuestion('Что такое индекс в базе данных?', 'Что такое транзакция в базе данных?'));
  assert.ok(!sameQuestion('Как работает индекс в базе данных?', 'Как работает репликация в базе данных?'));
});

test('одна и та же фраза снова и снова даёт одну карточку и один запрос', async () => {
  const { coach, calls } = harness(asks(() => 'QUESTION: Почему на Mac ты запускаешь службу?\nlaunchd управляет службами'));
  coach.start({ questionSource: 'both' });
  for (let i = 0; i < 12; i += 1) {
    coach.speech(i % 2 ? 'mic' : 'system', 'Почему на Mac ты запускаешь службу?', true);
    await wait(5);
  }
  await wait(40);
  assert.strictEqual(coach.snapshot().cards.length, 1);
  assert.strictEqual(calls.filter((call) => !call.isEval).length, 1);
});

test('разные фразы, сведённые сервисом к одному вопросу, дают одну карточку', async () => {
  const { coach, calls } = harness(asks(() => 'QUESTION: Почему на Mac ты запускаешь службу?\nlaunchd управляет службами'));
  coach.start({ questionSource: 'both' });
  coach.speech('system', 'Почему на Мас ты запускаешь службу?', true);
  await wait(30);
  coach.speech('system', 'Почему на маке ты работаешь службу?', true);
  await wait(30);
  assert.deepStrictEqual(coach.snapshot().cards.map((card) => card.question), ['Почему на Mac ты запускаешь службу?']);
  coach.speech('system', 'Почему на маке ты работаешь службу?', true);
  await wait(30);
  assert.strictEqual(calls.filter((call) => !call.isEval).length, 2, 'известный повтор не идёт в сервис');
});

test('сервис убирает повтор по смыслу и бессмыслицу, ответ сохраняется', async () => {
  const { coach } = harness(asks((user) => {
    if (user.includes('Новая фраза: Как устроен JWT')) return 'QUESTION: Как устроен JWT?\nТри части';
    if (user.includes('Новая фраза: Из чего состоит')) return 'REPEAT';
    if (user.includes('Новая фраза: Ты хочешь надеть')) return 'NOISE';
    return 'NONE';
  }));
  coach.start({});
  coach.speech('system', 'Как устроен JWT?', true);
  await wait(25);
  coach.speech('system', 'Из чего состоит этот токен?', true);
  coach.speech('mic', 'Три части и подпись', true);
  await wait(25);
  coach.speech('system', 'Ты хочешь надеть колонки?', true);
  await wait(25);
  const { cards } = coach.snapshot();
  assert.deepStrictEqual(cards.map((card) => card.question), ['Как устроен JWT?']);
  assert.ok(cards[0].answer.includes('Три части и подпись'));
});

test('в режиме «Собеседник и я» микрофон, слышащий динамики, не создаёт копию', async () => {
  const { coach } = harness(asks((user) => (user.includes('Новая фраза: Что такое шардирование') ? 'QUESTION: Что такое шардирование?\nРазделение данных' : 'NONE')));
  coach.start({ questionSource: 'both' });
  coach.speech('system', 'Что такое шардирование и зачем оно?', true);
  await wait(5);
  coach.speech('mic', 'такое шардирование и зачем оно', true);
  await wait(30);
  const { cards } = coach.snapshot();
  assert.strictEqual(cards.length, 1);
  assert.strictEqual(cards[0].answer, '');
});

test('вопрос снова становится новым, когда с прошлого раза прошло много времени', async () => {
  let time = 1000000;
  const { coach } = harness(asks(() => 'QUESTION: Что такое JWT?\nТокен'), { now: () => time });
  coach.start({});
  coach.speech('system', 'Что такое JWT?', true);
  await wait(25);
  time += 60000;
  coach.speech('system', 'Что такое JWT?', true);
  time += 60000;
  coach.speech('system', 'Что такое JWT?', true);
  await wait(25);
  assert.strictEqual(coach.snapshot().cards.length, 1, 'каждый повтор продлевает окно');
  time += 100000;
  coach.speech('system', 'Что такое JWT?', true);
  await wait(25);
  assert.strictEqual(coach.snapshot().cards.length, 2);
});
