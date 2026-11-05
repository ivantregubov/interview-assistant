/* Проверка микрофона, наушников и захвата звука. Общий файл для версий Mac и Windows. */
(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const send = (action, value) => window.appSend(action, value);
  let lastApp = null;
  let busy = false;

  function meterValue(level) {
    if (level <= 0) return 0;
    return Math.min(Math.max((20 * Math.log10(level) + 60) / 60, 0), 1);
  }

  function setResult(id, text, kind) {
    const element = byId(id);
    element.textContent = text;
    element.className = `sub ${kind ? `status-pill ${kind}` : ''}`;
  }

  function setBusy(value) {
    busy = value;
    ['test-mic', 'test-speakers', 'test-system'].forEach((id) => { byId(id).disabled = value; });
  }

  /* Обновления проверки микрофона: приходят от браузерного движка на Windows и от приложения на Mac */
  window.soundTestUpdate = function (update) {
    if (update.level !== undefined) {
      byId('test-mic-level').style.transform = `scaleX(${meterValue(update.level)})`;
    }
    if (update.stage === 'recording') {
      setResult('test-mic-result', 'Говорите: идёт запись 4 секунды', '');
    } else if (update.stage === 'playing') {
      setResult('test-mic-result', 'Воспроизвожу запись. Вы должны услышать свой голос', '');
    } else if (update.stage === 'done') {
      byId('test-mic-level').style.transform = 'scaleX(0)';
      setBusy(false);
      if (update.error) {
        setResult('test-mic-result', `Не удалось проверить: ${update.error}`, 'bad');
      } else if (update.peak < 0.01) {
        setResult('test-mic-result', 'Сигнала почти нет. Проверьте выбранный микрофон и его громкость в системе', 'bad');
      } else {
        setResult('test-mic-result', 'Микрофон работает', 'ok');
      }
    }
  };

  byId('test-mic').addEventListener('click', () => {
    if (busy || !lastApp || lastApp.state !== 'idle') return;
    setBusy(true);
    setResult('test-mic-result', 'Подключаю микрофон', '');
    if (window.localMicrophoneTest) window.localMicrophoneTest(lastApp.selectedMicrophoneID);
    else send('testMicrophone');
  });

  /* Проверочный сигнал из трёх нот. Он звучит в устройстве вывода, выбранном в системе. */
  function playChime() {
    const context = new AudioContext();
    const start = context.currentTime + 0.05;
    [523.25, 659.25, 783.99].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      const at = start + index * 0.28;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.25, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.34);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.36);
    });
    return new Promise((resolve) => {
      setTimeout(() => context.close().then(resolve, resolve), 1200);
    });
  }
  window.playTestChime = playChime;

  byId('test-speakers').addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    setResult('test-speakers-result', 'Звучит сигнал', '');
    await playChime();
    setBusy(false);
    setResult('test-speakers-result', 'Вы слышали три ноты? Если нет, проверьте устройство вывода и громкость в системе', '');
  });

  byId('test-system').addEventListener('click', async () => {
    if (busy || !window.localSystemAudioTest || !lastApp || lastApp.state !== 'idle') return;
    setBusy(true);
    setResult('test-system-result', 'Проигрываю сигнал и слушаю звук системы', '');
    const result = await window.localSystemAudioTest();
    setBusy(false);
    if (result.error) setResult('test-system-result', `Не удалось проверить: ${result.error}`, 'bad');
    else if (result.peak < 0.003) setResult('test-system-result', 'Приложение не слышит звук системы, голос собеседника не запишется', 'bad');
    else setResult('test-system-result', 'Звук собеседника захватывается', 'ok');
  });

  byId('open-sound-test').addEventListener('click', () => {
    document.querySelector('[data-tab="settings"]').click();
  });

  window.soundTestAppState = function (next) {
    lastApp = next;
    byId('test-system-row').hidden = !window.localSystemAudioTest;
    byId('diagnostics-row').hidden = !next.hasDiagnostics;
    const idle = next.state === 'idle';
    if (!busy) {
      byId('test-mic').disabled = !idle;
      byId('test-system').disabled = !idle;
    }
  };
})();
