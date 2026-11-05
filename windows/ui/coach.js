/* Логика тренировочного интервью. Общая для версий Mac и Windows, не зависит от интерфейса и платформы. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InterviewCoach = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_HINT_LINES = 10;
  const FRAGMENT_LIFETIME_MS = 20000;

  const DETECT_PROMPT = [
    'Ты помощник кандидата на тренировочном собеседовании. На вход приходит расшифровка живой речи, в ней возможны ошибки распознавания.',
    'Отвечай строго в одном из трёх форматов.',
    'Если во фразе нет вопроса или задания кандидату (приветствие, комментарий, реакция), напиши единственную строку: NONE',
    'Если фраза только продолжает или уточняет текущий вопрос, напиши единственную строку: SAME',
    'Если это новый вопрос или задание кандидату, первая строка: QUESTION: вопрос в исправленном виде.',
    'Со второй строки дай подсказку: ключевые тезисы ответа, не больше 6 коротких строк, до 8 слов в строке, без вступления и без markdown.',
    'Исправляй термины, искажённые распознаванием, исходя из смысла. Пиши на языке вопроса.',
  ].join('\n');

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

  function createCoach(host, options) {
    const pauseMs = (options && options.pauseMs) || 1100;
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
    let answerTimer = null;
    let tracks = {};
    let finishWaiters = [];
    let summary = null;

    function emit() {
      if (host.onChange) host.onChange(snapshot());
    }

    function snapshot() {
      return {
        phase,
        cards: cards.map((card) => ({ ...card })),
        interim: { mic: tracks.mic ? tracks.mic.interim : '', system: tracks.system ? tracks.system.interim : '' },
        summary,
      };
    }

    function newTrack() {
      return { sentWords: [], text: '', interim: '', timer: null };
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
      tracks = { mic: newTrack(), system: newTrack() };
      summary = null;
      emit();
    }

    function clearPending() {
      clearTimeout(answerTimer);
      answerTimer = null;
      Object.values(tracks).forEach((track) => clearTimeout(track.timer));
    }

    /* Речь. Промежуточные результаты дополняются, поэтому считаем законченным то, что не менялось в течение паузы. */
    function speech(track, text, isFinal) {
      if (phase !== 'live' || !tracks[track]) return;
      const state = tracks[track];
      const cleaned = String(text || '').trim();
      state.text = cleaned;
      clearTimeout(state.timer);

      if (isFinal) {
        commit(track);
        state.sentWords = [];
        state.text = '';
        state.interim = '';
      } else {
        state.interim = cleaned;
        state.timer = setTimeout(() => commit(track), pauseMs);
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
      if (track === 'system') onInterviewer(fresh);
      else onMicrophone(fresh);
    }

    function activeCard() {
      return cards.length ? cards[cards.length - 1] : null;
    }

    function remember(text) {
      recent.push(text);
      if (recent.length > 4) recent.shift();
    }

    function onInterviewer(text) {
      remember(text);
      // Собеседник заговорил: предыдущий ответ закончен.
      const active = activeCard();
      if (active && active.answer) evaluate(active);
      enqueueDetect('interviewer', text);
    }

    function onMicrophone(text) {
      if (isEcho(text)) return;
      if (questionSource === 'both') {
        remember(text);
        enqueueDetect('mic', text);
      } else {
        appendAnswer(text);
      }
    }

    /* Без наушников микрофон слышит собеседника из динамиков, такие фразы ответом не считаем. */
    function isEcho(text) {
      const micWords = words(text);
      if (micWords.length < 2) return false;
      const heard = new Set();
      recent.slice(-2).forEach((phrase) => words(phrase).forEach((word) => heard.add(word)));
      if (tracks.system && tracks.system.interim) words(tracks.system.interim).forEach((word) => heard.add(word));
      if (!heard.size || questionSource === 'both') return false;
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
    function enqueueDetect(source, text) {
      const last = detectQueue[detectQueue.length - 1];
      if (last && last.source === source) last.text = `${last.text} ${text}`;
      else detectQueue.push({ source, text });
      pumpDetect();
    }

    function pumpDetect() {
      if (detectBusy || !detectQueue.length) {
        checkFinished();
        return;
      }
      const item = detectQueue.shift();
      if (item.source === 'interviewer' && fragment && now() - fragment.time < FRAGMENT_LIFETIME_MS) {
        item.text = `${fragment.text} ${item.text}`;
      }
      fragment = null;
      detectBusy = true;

      const active = activeCard();
      const lines = [];
      if (active) lines.push(`Текущий вопрос: ${active.question}`);
      const earlier = recent.slice(0, -1);
      if (earlier.length) lines.push(`Недавние фразы: ${earlier.join(' / ')}`);
      lines.push(`Новая фраза: ${item.text}`);

      request('detect', [
        { role: 'system', content: DETECT_PROMPT },
        { role: 'user', content: lines.join('\n') },
      ], 280, { item, raw: '', card: null, decided: false });
    }

    function request(kind, messages, maxTokens, context) {
      const id = nextRequestId;
      nextRequestId += 1;
      requests.set(id, { kind, ...context });
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
        if (error) {
          host.onError && host.onError(error);
        } else {
          updateDetect(entry, true);
        }
        detectBusy = false;
        pumpDetect();
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
        if (match) {
          const previous = activeCard();
          if (previous && previous.answer) evaluate(previous);
          clearTimeout(answerTimer);
          entry.card = {
            id: nextCardId,
            question: match[1].trim(),
            hint: '',
            answer: '',
            verdict: null,
            comment: '',
            hintDone: false,
            evaluatedAnswer: '',
            error: '',
          };
          nextCardId += 1;
          cards.push(entry.card);
        } else if (/^NONE/i.test(firstLine)) {
          if (entry.item.source === 'interviewer') {
            fragment = { text: entry.item.text, time: now() };
          } else {
            appendAnswer(entry.item.text);
          }
        }
      }

      if (entry.card && newline >= 0) {
        entry.card.hint = raw.slice(newline + 1).split('\n').map(cleanLine).filter(Boolean)
          .slice(0, MAX_HINT_LINES).join('\n');
      }
      if (entry.card && isDone) entry.card.hintDone = true;
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
        if (card.hint) lines.push('**Подсказка:**', '', ...card.hint.split('\n').map((line) => `- ${line}`), '');
      });
      return lines.join('\n');
    }

    /* Проверка ключа и модели из настроек */
    function testConnection(onResult) {
      request('test', [
        { role: 'user', content: 'Ответь одним словом: готово' },
      ], 20, { raw: '', onDone: (raw, error) => onResult(error, raw) });
    }

    return { start, speech, stop, llmDelta, llmDone, testConnection, snapshot, verdictLabel };
  }

  return { createCoach, MAX_HINT_LINES };
});
