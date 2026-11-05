/* Вкладка «Интервью» и настройки подсказок. Общий файл для версий Mac и Windows. */
(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const send = (action, value) => window.appSend(action, value);
  const cardElements = new Map();
  let previousState = 'idle';
  let lastApp = null;
  let wasFinished = false;

  const coach = window.InterviewCoach.createCoach({
    llm(id, messages, maxTokens) {
      send('llmRequest', { id, messages, maxTokens });
    },
    save(markdown, json) {
      if (coach.snapshot().cards.length) send('saveReport', { markdown, json });
    },
    onChange: render,
    onError: showError,
    log(message) {
      send('liveLog', message);
    },
  });

  window.coachSpeech = (track, text, isFinal, elapsedMs) => coach.speech(track, text, isFinal, elapsedMs);
  window.coachLlmDelta = (id, text) => coach.llmDelta(id, text);
  window.coachLlmDone = (id, error) => coach.llmDone(id, error);

  function showError(message) {
    const banner = byId('coach-error');
    banner.hidden = !message;
    byId('coach-error-text').textContent = message ? `Ошибка запроса подсказки: ${message}` : '';
  }

  function isNearBottom(element) {
    return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  }

  function createCard() {
    const element = document.createElement('article');
    element.className = 'card qa';
    element.innerHTML = `
      <div class="qa-head">
        <h3 class="qa-question"></h3>
        <span class="qa-mark" role="img"></span>
      </div>
      <p class="qa-hint"></p>
      <div class="qa-answer-block qa-clarify-block" hidden>
        <div class="qa-label">Вы уточнили</div>
        <p class="qa-clarify"></p>
      </div>
      <div class="qa-answer-block qa-main-answer" hidden>
        <div class="qa-label">Ваш ответ</div>
        <p class="qa-answer"></p>
      </div>
      <p class="qa-comment" hidden></p>`;
    return element;
  }

  const MARKS = {
    correct: { symbol: '✓', title: 'Правильно' },
    partial: { symbol: '~', title: 'Частично верно' },
    wrong: { symbol: '✕', title: 'Неправильно' },
    pending: { symbol: '', title: 'Оцениваю ответ' },
  };

  function updateCard(element, card, finished) {
    element.querySelector('.qa-question').textContent = card.question;
    const hint = element.querySelector('.qa-hint');
    hint.textContent = card.hint || (card.hintDone ? '' : 'Готовлю подсказку');
    hint.classList.toggle('waiting', !card.hint);
    hint.hidden = card.hintDone && !card.hint;

    const clarifications = card.clarifications || [];
    element.querySelector('.qa-clarify-block').hidden = clarifications.length === 0;
    element.querySelector('.qa-clarify').textContent = clarifications.join(' ');
    element.querySelector('.qa-main-answer').hidden = !card.answer;
    element.querySelector('.qa-answer').textContent = card.answer;

    const comment = element.querySelector('.qa-comment');
    const showComment = Boolean(card.comment) && card.verdict !== 'pending' && card.verdict !== 'correct';
    comment.hidden = !showComment;
    comment.textContent = showComment ? card.comment : '';

    const mark = element.querySelector('.qa-mark');
    const verdict = !card.answer && finished ? 'none' : card.verdict;
    const info = MARKS[verdict];
    mark.className = `qa-mark ${verdict || ''}`;
    mark.textContent = info ? info.symbol : '';
    mark.title = info ? info.title : '';
    mark.setAttribute('aria-label', info ? info.title : '');
  }

  function render(snapshot) {
    const main = document.querySelector('main');
    const stick = isNearBottom(main);
    const list = byId('qa-list');
    const finished = snapshot.phase === 'finished';

    // Предварительно показанная фраза могла оказаться не вопросом.
    const present = new Set(snapshot.cards.map((card) => card.id));
    cardElements.forEach((element, id) => {
      if (!present.has(id)) {
        element.remove();
        cardElements.delete(id);
      }
    });

    snapshot.cards.forEach((card) => {
      let element = cardElements.get(card.id);
      if (!element) {
        element = createCard();
        cardElements.set(card.id, element);
        list.appendChild(element);
      }
      updateCard(element, card, finished);
    });

    byId('qa-empty').hidden = snapshot.cards.length > 0 || snapshot.phase === 'finished';
    const interim = snapshot.interim.system
      ? `Собеседник: ${snapshot.interim.system}`
      : (snapshot.interim.mic ? `Вы: ${snapshot.interim.mic}` : '');
    const interimBar = byId('qa-interim');
    interimBar.hidden = !interim;
    interimBar.textContent = interim;

    const live = snapshot.phase === 'live';
    const heardBar = byId('qa-heard');
    heardBar.hidden = !live;
    if (live) {
      const last = snapshot.lastHeard
        ? ` Последнее: «${snapshot.lastHeard.text}»`
        : ' Пока ничего не слышно.';
      const decision = {
        none: ' Вопроса в ней нет.',
        same: ' Это продолжение вопроса.',
        question: ' Это вопрос.',
      }[snapshot.lastDecision] || '';
      const seconds = (ms) => `${(ms / 1000).toFixed(1).replace('.', ',')} с`;
      const delay = snapshot.lastLatency && snapshot.lastLatency.question !== undefined
        ? ` Задержка от конца фразы: вопрос ${seconds(snapshot.lastLatency.question)}`
          + (snapshot.lastLatency.hint !== undefined ? `, подсказка ${seconds(snapshot.lastLatency.hint)}.` : '.')
        : '';
      heardBar.textContent = `Распознано фраз: собеседник ${snapshot.heard.system}, вы ${snapshot.heard.mic}.${last}${decision}${delay}`;
    }
    byId('qa-mic-hint').hidden = !(live && snapshot.micIgnored);

    const summary = byId('qa-summary');
    summary.hidden = !finished;
    if (finished && snapshot.summary) {
      const s = snapshot.summary;
      byId('stat-total').textContent = s.total;
      byId('stat-share').textContent = `${s.correctShare}%`;
      byId('stat-correct').textContent = s.correct;
      byId('stat-partial').textContent = s.partial;
      byId('stat-wrong').textContent = s.wrong;
      byId('stat-unanswered').textContent = s.unanswered;
      byId('qa-list-title').hidden = s.total === 0;
      if (!wasFinished) main.scrollTop = 0;
    } else {
      byId('qa-list-title').hidden = true;
      if (stick && byId('page-interview').classList.contains('active')) {
        main.scrollTop = main.scrollHeight;
      }
    }
    wasFinished = finished;
  }

  function resetView() {
    cardElements.forEach((element) => element.remove());
    cardElements.clear();
    wasFinished = false;
    showError('');
  }

  /* Сюда приходит полное состояние приложения при каждом его изменении */
  window.coachAppState = function (next) {
    lastApp = next;
    const recording = next.state === 'recording';

    if (recording && previousState !== 'recording') {
      resetView();
      if (next.liveEnabled && next.llmHasKey) {
        coach.start({ questionSource: next.questionSource });
        document.querySelector('[data-tab="interview"]').click();
      }
    }
    if (!recording && previousState === 'recording' && coach.snapshot().phase === 'live') {
      coach.stop();
    }
    previousState = next.state;
    coach.setQuestionSource(next.questionSource);

    const stats = next.liveStats;
    const sttRow = byId('qa-stt');
    sttRow.hidden = !(recording && stats);
    if (recording && stats) {
      sttRow.textContent = stats.ready
        ? `Фраз найдено в звуке: собеседник ${stats.found.system}, вы ${stats.found.mic}. Без текста: ${stats.empty}.`
          + (stats.lastMs ? ` Распознавание: ${(stats.lastMs / 1000).toFixed(1)} с.` : '')
          + (stats.dropped ? ` Пропущено из-за нагрузки: ${stats.dropped}.` : '')
        : 'Загружаю распознавание речи.';
    }

    byId('qa-timer').textContent = next.elapsedText;
    byId('qa-empty').textContent = recording
      ? 'Слушаю. Вопросы появятся здесь вместе с короткими подсказками и оценкой ваших ответов.'
      : 'Начните запись на вкладке «Запись». Здесь появятся вопросы собеседника, короткие подсказки и оценка ваших ответов.';
    byId('qa-status').textContent = recording ? 'Идёт запись' : 'Запись остановлена';
    byId('qa-stop').hidden = !recording;
    byId('qa-bar').classList.toggle('on', recording);

    const noKey = next.liveEnabled && !next.llmHasKey;
    byId('qa-no-key').hidden = !noKey;
    byId('qa-live-status').hidden = !next.liveStatus;
    byId('qa-live-status-text').textContent = next.liveStatus || '';

    // Настройки
    byId('live-enabled').checked = next.liveEnabled;
    byId('llm-settings').hidden = !next.liveEnabled;
    document.querySelectorAll('[data-provider]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.provider === next.llmProvider));
    });
    document.querySelectorAll('[data-qsource]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.qsource === next.questionSource));
    });
    byId('live-quality-row').hidden = !next.liveQuality;
    document.querySelectorAll('[data-livequality]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.livequality === next.liveQuality));
    });
    const model = byId('llm-model');
    if (document.activeElement !== model) model.value = next.llmModel;
    byId('llm-key-status').textContent = next.llmHasKey ? 'Ключ сохранён на этом компьютере' : 'Ключ не добавлен';
    byId('llm-key-status').className = `sub status-pill ${next.llmHasKey ? 'ok' : 'bad'}`;
    byId('llm-key-delete').hidden = !next.llmHasKey;
    byId('llm-key-link').textContent = next.llmProvider === 'openrouter' ? 'openrouter.ai/keys' : 'platform.deepseek.com/api_keys';
  };

  /* Обработчики настроек */
  byId('live-enabled').addEventListener('change', (event) => send('setLiveEnabled', event.target.checked));
  document.querySelectorAll('[data-provider]').forEach((button) => {
    button.addEventListener('click', () => {
      byId('llm-test-result').textContent = '';
      send('setLlmProvider', button.dataset.provider);
    });
  });
  document.querySelectorAll('[data-qsource]').forEach((button) => {
    button.addEventListener('click', () => send('setQuestionSource', button.dataset.qsource));
  });
  document.querySelectorAll('[data-livequality]').forEach((button) => {
    button.addEventListener('click', () => send('setLiveQuality', button.dataset.livequality));
  });
  byId('llm-model').addEventListener('change', (event) => send('setLlmModel', event.target.value.trim()));
  byId('llm-key-save').addEventListener('click', () => {
    const input = byId('llm-key');
    const value = input.value.trim();
    if (!value) return;
    send('saveApiKey', value);
    input.value = '';
  });
  byId('llm-key-delete').addEventListener('click', () => send('deleteApiKey'));
  byId('llm-test').addEventListener('click', () => {
    const result = byId('llm-test-result');
    if (!lastApp || !lastApp.llmHasKey) {
      result.textContent = 'Сначала добавьте API-ключ.';
      result.className = 'sub status-pill bad';
      return;
    }
    result.textContent = 'Проверяю...';
    result.className = 'sub';
    coach.testConnection((error) => {
      result.textContent = error ? `Не удалось: ${error}` : 'Подключение работает';
      result.className = `sub status-pill ${error ? 'bad' : 'ok'}`;
    });
  });
  byId('qa-mic-source').addEventListener('click', () => send('setQuestionSource', 'both'));
  byId('open-diagnostics').addEventListener('click', () => send('openDiagnostics'));
  byId('qa-open-settings').addEventListener('click', () => {
    document.querySelector('[data-tab="settings"]').click();
  });

  // Этот скрипт загружается после основного: просим приложение прислать текущее состояние ещё раз.
  send('syncState');
})();
