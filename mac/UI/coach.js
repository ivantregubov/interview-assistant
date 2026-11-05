/* Логика тренировочного интервью. Общая для версий Mac и Windows, не зависит от интерфейса и платформы. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InterviewCoach = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_HINT_LINES = 10;
  const FRAGMENT_LIFETIME_MS = 20000;
  /* Вопрос считается повтором, если похожий уже звучал за это время. Каждый повтор продлевает окно. */
  const REPEAT_WINDOW_MS = 90000;
  const REPEAT_CARDS = 8;
  const REPEAT_PHRASE_MS = 20000;
  const ECHO_WINDOW_MS = 8000;

  const DETECT_PROMPT = [
    'Ты помощник кандидата на тренировочном собеседовании. На вход приходит расшифровка живой речи, в ней возможны ошибки распознавания.',
    'Отвечай строго в одном из трёх форматов.',
    'Если во фразе нет вопроса или задания кандидату (приветствие, комментарий, реакция), напиши единственную строку: NONE',
    'Если фраза только продолжает или уточняет текущий вопрос, напиши единственную строку: SAME',
    'Если фраза повторяет по смыслу текущий или уже заданный вопрос, напиши единственную строку: REPEAT',
    'Если это новый вопрос или задание кандидату, первая строка: QUESTION: вопрос в исправленном виде.',
    'Со второй строки дай подсказку: ключевые тезисы ответа, не больше 6 коротких строк, до 8 слов в строке, без вступления и без markdown.',
    'Исправляй термины, искажённые распознаванием, исходя из смысла. Вопрос формулируй только из новой фразы, не подставляй вместо неё текущий вопрос. Пиши на языке вопроса.',
  ].join('\n');

  const FORCED_NOTE = 'Это вопросительное предложение: считай его отдельным вопросом на любую тему и ответь в формате QUESTION. Исключения: REPEAT, если оно повторяет уже заданный вопрос; NOISE, если из-за ошибок распознавания в нём нет смысла.';

  const EVALUATE_PROMPT = [
    'Оцени устный ответ кандидата на вопрос тренировочного собеседования. Учитывай, что в расшифровке возможны ошибки распознавания.',
    'Ответь ровно двумя строками:',
    'VERDICT: CORRECT, PARTIAL или WRONG',
    'COMMENT: чего не хватило или что неверно, до 15 слов. Если всё верно, напиши, что ответ верный.',
    'CORRECT ставь, только если ответ верен и раскрывает суть вопроса. Пиши на языке вопроса.',
  ].join('\n');

  function words(text) {
    return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu)) || [];
  }

  function cleanLine(line) {
    return line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim();
  }

  /* Явный вопрос показываем сразу, ещё до ответа сервиса: так он появляется почти без задержки. */
  const QUESTION_START = /^(что|как|какой|какая|какое|какие|каким|какую|почему|зачем|когда|где|кто|чем|сколько|расскажите|расскажи|объясните|объясни|опишите|опиши|назовите|назови|в ч[её]м|для чего|what|how|why|when|where|who|which|explain|describe|tell me)(?=[\s,?!.]|$)/iu;

  function looksLikeQuestion(text) {
    return words(text).length >= 2 && (/\?\s*$/.test(text) || QUESTION_START.test(text.trim()));
  }

  function isQuestionSentence(text) {
    return /\?[!.…"»)\s]*$/u.test(text);
  }

  /* Разбивает фразу на части: каждое вопросительное предложение отдельно, остальной текст вместе. */
  function splitByQuestions(text) {
    const parts = [];
    let plain = [];
    const flush = () => {
      if (plain.length) parts.push({ text: plain.join(' '), isQuestion: false });
      plain = [];
    };
    text.split(/(?<=[.!?…])\s+/u).filter(Boolean).forEach((sentence) => {
      if (isQuestionSentence(sentence)) {
        flush();
        parts.push({ text: sentence, isQuestion: true });
      } else {
        plain.push(sentence);
      }
    });
    flush();
    return parts;
  }

  const FILLER_WORDS = new Set(('а и но в во на с со к ко у о об от до по за из ну же ли бы то это такое ты вы тебе вам тебя вас мне нам ещё еще вот так '
    + 'the a an is are do does to of in on you').split(' '));

  function editDistance(a, b) {
    let row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      const next = [i];
      for (let j = 1; j <= b.length; j += 1) {
        next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      row = next;
    }
    return row[b.length];
  }

  /* Одно слово в разных формах или с ошибкой распознавания. Короткие термины вроде TCP и UDP сравниваются точно. */
  function closeWords(a, b) {
    if (a === b) return true;
    if (Math.min(a.length, b.length) < 4) return false;
    return editDistance(a, b) <= Math.floor(Math.max(a.length, b.length) / 4);
  }

  /* Сравнивает вопросы по значимым словам. Вопросы, различающиеся термином, повторами не считаются. */
  function sameQuestion(first, second) {
    const all = [words(first), words(second)];
    if (!all[0].length || !all[1].length) return false;
    if (all[0].join(' ') === all[1].join(' ')) return true;
    const [a, b] = all.map((list) => {
      const meaningful = list.filter((word) => !FILLER_WORDS.has(word));
      return meaningful.length ? meaningful : list;
    });
    const free = [...b];
    let matches = 0;
    a.forEach((word) => {
      const index = free.findIndex((other) => closeWords(word, other));
      if (index >= 0) {
        free.splice(index, 1);
        matches += 1;
      }
    });
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    if (matches === shorter && shorter >= 3 && longer <= shorter + 2) return true;
    return (2 * matches) / (a.length + b.length) >= 0.85;
  }

  /* Распознавание иногда выдаёт длинные повторы одного символа: на смысл они не влияют, а вёрстку ломают. */
  function cleanSpeech(text) {
    return String(text || '').replace(/(.)\1{4,}/gu, '$1').replace(/\s+/g, ' ').trim();
  }

  function createCoach(host, options) {
    const pauseMs = (options && options.pauseMs) || 800;
    const answerPauseMs = (options && options.answerPauseMs) || 4000;
    const finishTimeoutMs = (options && options.finishTimeoutMs) || 12000;
    const now = (options && options.now) || Date.now;

    let phase = 'idle';
    let cards = [];
    let nextCardId = 1;
    let nextRequestId = 1;
    let questionSource = 'interviewer';
    let requests = new Map();
    let detectQueue = [];
    let detectBusy = false;
    let fragment = null;
    let recent = [];
    let systemPhrases = [];
    let answerTimer = null;
    let tracks = {};
    let finishWaiters = [];
    let summary = null;
    let heard = { mic: 0, system: 0 };
    let lastHeard = null;
    let micIgnored = false;
    let lastDecision = null;
    let lastLatency = null;

    function log(message) {
      if (host.log) host.log(message);
    }

    function emit() {
      if (host.onChange) host.onChange(snapshot());
    }

    function snapshot() {
      return {
        phase,
        cards: cards.map((card) => ({ ...card })),
        interim: { mic: tracks.mic ? tracks.mic.interim : '', system: tracks.system ? tracks.system.interim : '' },
        summary,
        heard: { ...heard },
        lastHeard,
        micIgnored,
        lastDecision,
        lastLatency,
      };
    }

    /* Меняется и во время записи: так пользователь сразу видит результат настройки. */
    function setQuestionSource(value) {
      if ((value === 'interviewer' || value === 'both') && value !== questionSource) {
        if (value === 'both') micIgnored = false;
        questionSource = value;
        // После смены режима та же фраза значит уже другое.
        Object.values(tracks).forEach((track) => { track.lastPhrase = ''; });
        emit();
      }
    }

    function newTrack() {
      return { sentWords: [], text: '', interim: '', timer: null, speechEndAt: 0, lastPhrase: '', lastPhraseAt: 0 };
    }

    function start(config) {
      clearPending();
      phase = 'live';
      cards = [];
      questionSource = (config && config.questionSource) || 'interviewer';
      requests = new Map();
      detectQueue = [];
      detectBusy = false;
      fragment = null;
      recent = [];
      systemPhrases = [];
      tracks = { mic: newTrack(), system: newTrack() };
      summary = null;
      heard = { mic: 0, system: 0 };
      lastHeard = null;
      micIgnored = false;
      lastDecision = null;
      lastLatency = null;
      log('Интервью начато');
      emit();
    }

    function clearPending() {
      clearTimeout(answerTimer);
      answerTimer = null;
      Object.values(tracks).forEach((track) => clearTimeout(track.timer));
    }

    /* Речь. Промежуточные результаты дополняются, поэтому считаем законченным то, что не менялось в течение паузы. */
    /* elapsedMs: сколько времени уже прошло с конца фразы до этого момента, например на распознавание. */
    function speech(track, text, isFinal, elapsedMs) {
      if (phase !== 'live' || !tracks[track]) return;
      const state = tracks[track];
      const cleaned = cleanSpeech(text);
      state.text = cleaned;
      clearTimeout(state.timer);

      if (isFinal) {
        state.speechEndAt = now() - (elapsedMs || 0);
        commit(track);
        state.sentWords = [];
        state.text = '';
        state.interim = '';
      } else {
        state.interim = cleaned;
        state.timer = setTimeout(() => {
          state.speechEndAt = now() - pauseMs;
          commit(track);
        }, pauseMs);
      }
      emit();
    }

    function commit(track) {
      const state = tracks[track];
      const current = state.text.split(/\s+/).filter(Boolean);
      let shared = 0;
      while (
        shared < current.length && shared < state.sentWords.length
        && words(current[shared]).join() === words(state.sentWords[shared]).join()
      ) shared += 1;
      const fresh = current.slice(shared).join(' ');
      state.sentWords = current;
      state.interim = '';
      if (!words(fresh).length) return;
      // Одна и та же фраза подряд: на шуме распознавание может выдавать её снова и снова.
      const phrase = words(fresh).join(' ');
      if (words(fresh).length >= 3 && phrase === state.lastPhrase && now() - state.lastPhraseAt < REPEAT_PHRASE_MS) {
        state.lastPhraseAt = now();
        log(`Повтор фразы пропущен (${track}): ${fresh}`);
        return;
      }
      state.lastPhrase = phrase;
      state.lastPhraseAt = now();
      heard[track] += 1;
      lastHeard = { track, text: fresh };
      log(`Услышано (${track}): ${fresh}`);
      if (track === 'system') onInterviewer(fresh, state.speechEndAt);
      else onMicrophone(fresh, state.speechEndAt);
    }

    function activeCard() {
      return cards.length ? cards[cards.length - 1] : null;
    }

    function remember(text) {
      recent.push(text);
      if (recent.length > 4) recent.shift();
    }

    function onInterviewer(text, endAt) {
      remember(text);
      systemPhrases.push({ text, at: now() });
      if (systemPhrases.length > 6) systemPhrases.shift();
      // Собеседник заговорил: предыдущий ответ закончен.
      const active = activeCard();
      if (active && active.answer) evaluate(active);
      splitByQuestions(text).forEach((part) => {
        const count = words(part.text).length;
        if (part.isQuestion && count >= 2) {
          // Каждый вопрос собеседника становится отдельной карточкой.
          enqueueDetect('interviewer', part.text, endAt, true);
        } else if (part.isQuestion) {
          // Короткие реплики вроде «Верно?» не считаем вопросами.
        } else if (count < 2) {
          // Одно слово не вопрос: оставляем его как начало следующей фразы и не тратим время на запрос.
          fragment = { text: fragment ? `${fragment.text} ${part.text}` : part.text, time: now() };
        } else {
          enqueueDetect('interviewer', part.text, endAt);
        }
      });
    }

    function onMicrophone(text, endAt) {
      if (isEcho(text)) return;
      splitByQuestions(text).forEach((part) => {
        const count = words(part.text).length;
        if (part.isQuestion) {
          if (count < 2) return;
          if (questionSource === 'both') {
            // Пользователь сам читает вопросы: это отдельный вопрос.
            remember(part.text);
            enqueueDetect('mic', part.text, endAt, true);
          } else {
            addClarification(part.text);
          }
        } else if (questionSource === 'both' && count >= 2) {
          remember(part.text);
          enqueueDetect('mic', part.text, endAt);
        } else {
          // Вопросов ещё нет, а речь слышна только в микрофоне: вероятно, вопросы читает сам пользователь.
          if (questionSource !== 'both' && !activeCard()) micIgnored = true;
          appendAnswer(part.text);
        }
      });
    }

    /* Вопрос кандидата собеседнику уточняет текущий вопрос. В ответ и оценку он не входит. */
    function addClarification(text) {
      const active = activeCard();
      if (!active) {
        micIgnored = true;
        emit();
        return;
      }
      active.clarifications = [...(active.clarifications || []), text];
      emit();
    }

    /* Без наушников микрофон слышит собеседника из динамиков, такие фразы ответом не считаем. */
    function isEcho(text) {
      const micWords = words(text);
      if (micWords.length < 2) return false;
      const heard = new Set();
      // Когда вопросы читает сам кандидат, сравниваем только с тем, что только что прозвучало в динамиках.
      const phrases = questionSource === 'both'
        ? systemPhrases.filter((phrase) => now() - phrase.at < ECHO_WINDOW_MS)
        : systemPhrases.slice(-2);
      phrases.forEach((phrase) => words(phrase.text).forEach((word) => heard.add(word)));
      if (tracks.system && tracks.system.interim) words(tracks.system.interim).forEach((word) => heard.add(word));
      if (!heard.size) return false;
      const matches = micWords.filter((word) => heard.has(word)).length;
      return matches / micWords.length >= 0.7;
    }

    function appendAnswer(text) {
      const active = activeCard();
      if (!active) return;
      active.answer = active.answer ? `${active.answer} ${text}` : text;
      clearTimeout(answerTimer);
      answerTimer = setTimeout(() => evaluate(active), answerPauseMs);
      emit();
    }

    /* Определение вопроса. Запросы идут по очереди, чтобы новая фраза видела уже определённый предыдущий вопрос. */
    function enqueueDetect(source, text, endAt, forced) {
      // Повтор не создаёт карточку и не тратит запрос к сервису.
      const twin = findDuplicate(text);
      if (twin) {
        noteRepeat(twin, text);
        return;
      }
      if (detectQueue.some((item) => !item.regenerate && sameQuestion(item.text, text))) {
        log(`Повтор вопроса пропущен: ${text}`);
        return;
      }
      const last = detectQueue[detectQueue.length - 1];
      if (last && !forced && last.source === source && !last.regenerate && !last.forced) {
        last.text = `${last.text} ${text}`;
        last.endAt = endAt;
      } else {
        detectQueue.push({ source, text, endAt, forced: Boolean(forced) });
      }
      pumpDetect();
    }

    function findDuplicate(text, except) {
      const time = now();
      for (let index = cards.length - 1; index >= 0 && index >= cards.length - REPEAT_CARDS; index -= 1) {
        const card = cards[index];
        if (card !== except && time - card.askedAt < REPEAT_WINDOW_MS
          && [card.question, ...card.spoken].some((form) => sameQuestion(form, text))) return card;
      }
      return null;
    }

    /* Запоминаем, как прозвучал повтор: в следующий раз он отсеется сразу, без запроса к сервису. */
    function noteRepeat(card, text) {
      card.askedAt = now();
      if (!card.spoken.includes(text)) card.spoken = [...card.spoken, text].slice(-8);
      log(`Повтор вопроса пропущен: ${text}`);
    }

    function dropCard(entry) {
      if (!entry.card) return;
      const keptAnswer = entry.card.answer;
      cards = cards.filter((card) => card !== entry.card);
      entry.card = null;
      entry.provisional = false;
      if (keptAnswer) appendAnswer(keptAnswer);
    }

    function newCard(question) {
      const card = {
        id: nextCardId,
        question,
        hint: '',
        answer: '',
        verdict: null,
        comment: '',
        hintDone: false,
        evaluatedAnswer: '',
        error: '',
        createdAt: now(),
        askedAt: now(),
        spoken: [question],
      };
      nextCardId += 1;
      micIgnored = false;
      cards.push(card);
      return card;
    }

    function noteLatency(card, endAt, field) {
      if (!endAt || card[field] !== undefined) return;
      card[field] = Math.max(0, now() - endAt);
      lastLatency = { question: card.questionMs, hint: card.hintMs };
      if (field === 'hintMs') {
        log(`Задержка от конца фразы: вопрос ${card.questionMs} мс, подсказка ${card.hintMs} мс`);
      }
    }

    /* Следующий запрос можно отправлять, как только известно решение по текущему: ждать конца подсказки незачем. */
    function releaseDetect(entry) {
      if (entry.released) return;
      entry.released = true;
      detectBusy = false;
      pumpDetect();
    }

    function pumpDetect() {
      if (detectBusy || !detectQueue.length) {
        checkFinished();
        return;
      }
      const item = detectQueue.shift();
      // Законченное предложение перед вопросом, например «Хорошо.», к самому вопросу не относится.
      const fragmentIsComplete = fragment && /[.!?…]\s*$/u.test(fragment.text);
      if (item.source === 'interviewer' && fragment && now() - fragment.time < FRAGMENT_LIFETIME_MS
        && !(item.forced && fragmentIsComplete)) {
        item.text = `${fragment.text} ${item.text}`;
      }
      fragment = null;
      detectBusy = true;

      const active = activeCard();
      const lines = [];
      if (active && !item.regenerate) lines.push(`Текущий вопрос: ${active.question}`);
      const earlier = recent.slice(0, -1);
      if (earlier.length && !item.regenerate) lines.push(`Недавние фразы: ${earlier.join(' / ')}`);
      const asked = cards.slice(-6, -1).map((card) => card.question);
      if (asked.length && !item.regenerate) lines.push(`Уже заданные вопросы: ${asked.join(' / ')}`);
      lines.push(`Новая фраза: ${item.text}`);
      if (item.forced) lines.push(FORCED_NOTE);

      let card = item.regenerate || null;
      let provisional = false;
      if (!card && (item.forced || looksLikeQuestion(item.text))) {
        if (active && active.answer) evaluate(active);
        clearTimeout(answerTimer);
        card = newCard(item.text);
        // Обычную фразу сервис может отклонить, а явный вопрос остаётся в любом случае.
        provisional = !item.forced;
        noteLatency(card, item.endAt, 'questionMs');
        emit();
      }

      const id = request('detect', [
        { role: 'system', content: DETECT_PROMPT },
        { role: 'user', content: lines.join('\n') },
      ], 280, { item, raw: '', card, provisional, decided: false, released: false });
      if (card) card.hintRequest = id;
    }

    function request(kind, messages, maxTokens, context) {
      const id = nextRequestId;
      nextRequestId += 1;
      requests.set(id, { id, kind, ...context });
      host.llm(id, messages, maxTokens);
      return id;
    }

    function llmDelta(id, delta) {
      const entry = requests.get(id);
      if (!entry) return;
      entry.raw = (entry.raw || '') + delta;
      if (entry.kind === 'detect') updateDetect(entry, false);
    }

    function llmDone(id, error) {
      const entry = requests.get(id);
      if (!entry) return;
      requests.delete(id);

      if (entry.kind === 'detect') {
        if (entry.card) entry.card.hintDone = true;
        if (error) {
          log(`Ошибка запроса подсказки: ${error}`);
          host.onError && host.onError(error);
        } else {
          const answer = (entry.raw || '').trim();
          log(`Ответ сервиса: ${answer.split('\n')[0] || '(пусто)'}`);
          if (answer) {
            host.onError && host.onError('');
            updateDetect(entry, true);
          } else {
            host.onError && host.onError('сервис вернул пустой ответ');
          }
        }
        releaseDetect(entry);
      } else if (entry.kind === 'evaluate') {
        finishEvaluation(entry, error);
      } else if (entry.onDone) {
        entry.onDone(entry.raw || '', error);
      }
      emit();
      checkFinished();
    }

    function updateDetect(entry, isDone) {
      const raw = entry.raw || '';
      const newline = raw.indexOf('\n');
      const complete = newline >= 0 || isDone;

      if (!entry.decided && complete) {
        const firstLine = cleanLine(newline >= 0 ? raw.slice(0, newline) : raw);
        const match = firstLine.match(/^QUESTION\s*:\s*(.+)$/i);
        entry.decided = true;
        const isSame = /^SAME/i.test(firstLine);
        const isRepeat = /^REPEAT/i.test(firstLine);
        const isNoise = /^NOISE/i.test(firstLine);
        lastDecision = match ? 'question' : (isSame || isRepeat ? 'same' : 'none');
        const question = match ? match[1].trim() : '';
        // Разные фразы сервис может свести к одному вопросу: второй раз карточка не нужна.
        const twin = match && !entry.item.regenerate ? findDuplicate(question, entry.card) : null;

        if (twin) {
          dropCard(entry);
          noteRepeat(twin, entry.item.text);
        } else if (match) {
          if (entry.card) {
            // Показанный сразу вопрос заменяем исправленным: сервис убирает ошибки распознавания.
            entry.card.question = question;
            entry.provisional = false;
          } else {
            const previous = activeCard();
            if (previous && previous.answer) evaluate(previous);
            clearTimeout(answerTimer);
            entry.card = newCard(question);
            noteLatency(entry.card, entry.item.endAt, 'questionMs');
          }
        } else if (!entry.item.regenerate && isRepeat) {
          dropCard(entry);
          const repeated = activeCard();
          if (repeated) noteRepeat(repeated, entry.item.text);
        } else if (!entry.item.regenerate && isNoise) {
          dropCard(entry);
          log(`Бессмысленная фраза пропущена: ${entry.item.text}`);
        } else if (entry.item.regenerate || entry.item.forced) {
          // Вопрос оставляем как есть, даже если сервис не дал подсказку.
          if (entry.card) entry.card.hintDone = true;
          entry.card = null;
        } else {
          let keptAnswer = '';
          if (entry.provisional) {
            keptAnswer = entry.card.answer;
            cards = cards.filter((card) => card !== entry.card);
            entry.card = null;
          }
          const active = activeCard();

          if (isSame) {
            // Вопрос договорили после паузы: дополняем его и обновляем подсказку.
            if (active && !active.answer && now() - active.createdAt < 15000) {
              active.question = `${active.question} ${entry.item.text}`;
              active.hint = '';
              active.hintDone = false;
              detectQueue.unshift({ source: entry.item.source, text: active.question, endAt: entry.item.endAt, regenerate: active });
            }
          } else if (/^NONE/i.test(firstLine)) {
            if (entry.item.source === 'interviewer') {
              fragment = { text: entry.item.text, time: now() };
            } else {
              appendAnswer(entry.item.text);
            }
          }
          if (keptAnswer) appendAnswer(keptAnswer);
        }
        releaseDetect(entry);
      }

      const card = entry.card;
      if (card && card.hintRequest !== undefined && entry.id !== card.hintRequest && !entry.item.regenerate) return;
      if (card && newline >= 0) {
        const hint = raw.slice(newline + 1).split('\n').map(cleanLine)
          .filter((line) => line && !/^(ключевые\s+)?(тезисы|подсказка)[^:]*:$/iu.test(line))
          .slice(0, MAX_HINT_LINES).join('\n');
        if (hint) {
          card.hint = hint;
          noteLatency(card, entry.item.endAt, 'hintMs');
        }
      }
      if (card && isDone) card.hintDone = true;
      emit();
    }

    /* Оценка ответа. Если кандидат договорил после начала проверки, оцениваем ещё раз. */
    function evaluate(card) {
      if (!card.answer || card.answer === card.evaluatedAnswer) return;
      if (card.evaluating) {
        card.reevaluate = true;
        return;
      }
      card.evaluating = true;
      card.reevaluate = false;
      card.evaluatedAnswer = card.answer;
      if (!card.verdict) card.verdict = 'pending';
      request('evaluate', [
        { role: 'system', content: EVALUATE_PROMPT },
        { role: 'user', content: `Вопрос: ${card.question}\nОтвет кандидата: ${card.answer}` },
      ], 90, { card, raw: '' });
      emit();
    }

    function finishEvaluation(entry, error) {
      const { card } = entry;
      card.evaluating = false;
      if (error) {
        if (card.verdict === 'pending') card.verdict = 'unknown';
        card.error = error;
      } else {
        const raw = entry.raw || '';
        const verdict = raw.match(/VERDICT\s*:\s*\**\s*(CORRECT|PARTIAL|WRONG)/i);
        const comment = raw.match(/COMMENT\s*:\s*(.+)/i);
        card.verdict = verdict ? verdict[1].toLowerCase() : 'unknown';
        card.comment = comment ? cleanLine(comment[1]) : '';
      }
      if (card.reevaluate) {
        card.reevaluate = false;
        evaluate(card);
      }
    }

    /* Завершение */
    function stop() {
      if (phase !== 'live') return Promise.resolve(summary);
      phase = 'finishing';
      clearTimeout(answerTimer);
      Object.keys(tracks).forEach((name) => {
        clearTimeout(tracks[name].timer);
        if (tracks[name].text) {
          const saved = phase;
          phase = 'live';
          commit(name);
          phase = saved;
        }
        tracks[name].interim = '';
      });
      cards.forEach(evaluate);
      emit();

      return new Promise((resolve) => {
        const waiter = { resolve, timer: setTimeout(() => finish(), finishTimeoutMs) };
        finishWaiters.push(waiter);
        checkFinished();
      });
    }

    function checkFinished() {
      if (phase !== 'finishing') return;
      if (detectBusy || detectQueue.length) return;
      // Последний ответ мог появиться только после завершения определения вопроса.
      cards.forEach(evaluate);
      const pending = [...requests.values()].some((entry) => entry.kind === 'detect' || entry.kind === 'evaluate');
      if (!pending) finish();
    }

    function finish() {
      if (phase !== 'finishing') return;
      phase = 'finished';
      requests.forEach((entry) => {
        if (entry.kind === 'evaluate' && entry.card.verdict === 'pending') entry.card.verdict = 'unknown';
      });
      requests = new Map(requests);
      summary = summarize();
      if (host.save) host.save(report(), JSON.stringify({ summary, questions: cards.map(exportCard) }, null, 2));
      emit();
      finishWaiters.forEach((waiter) => {
        clearTimeout(waiter.timer);
        waiter.resolve(summary);
      });
      finishWaiters = [];
    }

    function summarize() {
      const total = cards.length;
      const count = (name) => cards.filter((card) => card.verdict === name).length;
      const correct = count('correct');
      return {
        total,
        correct,
        partial: count('partial'),
        wrong: count('wrong'),
        unanswered: cards.filter((card) => !card.answer).length,
        unknown: count('unknown') + count('pending'),
        correctShare: total ? Math.round((correct / total) * 100) : 0,
      };
    }

    function verdictLabel(card) {
      if (!card.answer) return 'Без ответа';
      return {
        correct: 'Правильно', partial: 'Частично', wrong: 'Неправильно',
      }[card.verdict] || 'Не оценено';
    }

    function exportCard(card) {
      return {
        question: card.question,
        hint: card.hint,
        answer: card.answer,
        clarifications: card.clarifications || [],
        verdict: verdictLabel(card),
        comment: card.comment,
      };
    }

    function report() {
      const s = summary;
      const lines = [
        '# Итоги тренировочного интервью', '',
        `Вопросов: ${s.total}`,
        `Правильных ответов: ${s.correct} (${s.correctShare}%)`,
        `Частично верных: ${s.partial}`,
        `Неправильных: ${s.wrong}`,
        `Без ответа: ${s.unanswered}`,
        '',
      ];
      cards.forEach((card, index) => {
        lines.push(`## ${index + 1}. ${card.question}`, '');
        lines.push(`**Оценка:** ${verdictLabel(card)}${card.comment ? `. ${card.comment}` : ''}`, '');
        lines.push(`**Ваш ответ:** ${card.answer || 'нет'}`, '');
        if (card.clarifications && card.clarifications.length) {
          lines.push(`**Вы уточняли:** ${card.clarifications.join(' ')}`, '');
        }
        if (card.hint) lines.push('**Подсказка:**', '', ...card.hint.split('\n').map((line) => `- ${line}`), '');
      });
      return lines.join('\n');
    }

    /* Проверка ключа и модели из настроек */
    function testConnection(onResult) {
      request('test', [
        { role: 'user', content: 'Ответь одним словом: готово' },
      ], 20, {
        raw: '',
        onDone: (raw, error) => onResult(error || (raw.trim() ? null : 'сервис вернул пустой ответ'), raw),
      });
    }

    return { start, speech, stop, llmDelta, llmDone, testConnection, snapshot, verdictLabel, setQuestionSource };
  }

  return { createCoach, MAX_HINT_LINES, splitByQuestions, cleanSpeech, sameQuestion };
});
