// Снимает скриншоты настоящего интерфейса с демонстрационными данными.
// Запуск из корня репозитория: node docs/make-screenshots.js (нужен Playwright).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'screenshots');
const page = `file://${path.join(root, 'mac/UI/index.html')}`;
const W = 540; const H = 780;

const base = {
  version: '1.4.0', state: 'idle', elapsedText: '0:00:00', micLevel: 0, systemLevel: 0, micSilent: false, errorMessage: '',
  screenPermissionMissing: false, micPermissionMissing: false, selectedDisplayID: 2,
  displays: [
    { id: 1, number: 1, name: 'Встроенный дисплей', x: 0, y: 0, width: 1470, height: 956, isMain: true },
    { id: 2, number: 2, name: 'Внешний монитор', x: 1470, y: -260, width: 2560, height: 1440, isMain: false },
  ],
  selectedMicrophoneID: 'm1', microphones: [{ id: 'm1', name: 'Микрофон MacBook Air' }],
  transcribeAfterRecording: true, openTranscriptAutomatically: true, transcriptionLanguage: 'ru-RU', isTranscribing: false,
  transcriptionProgress: 0, transcriptionError: '', hasLastTranscript: false, saveFolderPath: '~/Movies/Interview Assistant', saveFolderIsDefault: true,
  liveEnabled: true, llmHasKey: true, llmProvider: 'deepseek', llmModel: 'deepseek-flash', questionSource: 'interviewer', liveStatus: '',
};

const replies = [
  ['идемпотентн', 'QUESTION: Что такое идемпотентность API и зачем она нужна?\nПовторный запрос не меняет результат\nЗащищает от дублей при сбоях сети\nGET, PUT и DELETE идемпотентны, POST нет\nДля POST используют Idempotency-Key'],
  ['Kafka', 'QUESTION: Чем Kafka отличается от RabbitMQ?\nKafka: журнал событий и партиции\nСообщения можно перечитывать\nRabbitMQ: очереди и гибкая маршрутизация\nВыбор зависит от нагрузки и сценария'],
  ['JWT', 'QUESTION: Как устроен JWT?\nТри части: header, payload, signature\nКодирование Base64URL, данные не зашифрованы\nПодпись защищает от подмены\nСрок жизни задаёт поле exp'],
  ['CAP', 'QUESTION: Что утверждает CAP-теорема?\nСогласованность, доступность, устойчивость к разделению\nПри разделении сети выбираем C или A\nПример CP: ZooKeeper, пример AP: Cassandra'],
  ['шардирован', 'QUESTION: Что такое шардирование?\nРазделение данных между серверами\nКлюч определяет нужный сервер\nСложности: перебалансировка и JOIN'],
];
const verdicts = [
  ['Повторный вызов', 'VERDICT: CORRECT\nCOMMENT: Ответ верный.'],
  ['брокер', 'VERDICT: PARTIAL\nCOMMENT: Не сказано про партиции и повторное чтение сообщений.'],
  ['три части', 'VERDICT: CORRECT\nCOMMENT: Ответ верный.'],
  ['не помню', 'VERDICT: WRONG\nCOMMENT: Нужно назвать три свойства и выбор при разделении сети.'],
];

async function open(browser, colorScheme) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme, locale: 'ru-RU' });
  const tab = await context.newPage();
  await tab.addInitScript((data) => {
    window.webkit = { messageHandlers: { app: { postMessage: (message) => {
      if (message.action !== 'llmRequest') return;
      const { id, messages } = message.value;
      const user = messages[messages.length - 1].content;
      const isEvaluation = messages[0].content.startsWith('Оцени');
      const table = isEvaluation ? data.verdicts : data.replies;
      const text = isEvaluation ? user.split('Ответ кандидата:')[1] : user.split('Новая фраза:')[1];
      const hit = table.find(([key]) => text.includes(key));
      setTimeout(() => {
        window.coachLlmDelta(id, hit ? hit[1] : 'NONE');
        window.coachLlmDone(id, null);
      }, 5);
    } } } };
  }, { replies, verdicts });
  await tab.goto(page);
  await tab.waitForTimeout(150);
  await tab.evaluate((state) => window.appUpdate(state), base);
  return tab;
}

const say = async (tab, track, text, isFinal = true) => {
  await tab.evaluate(([t, x, f]) => window.coachSpeech(t, x, f), [track, text, isFinal]);
  await tab.waitForTimeout(90);
};

async function playInterview(tab) {
  await tab.evaluate((state) => window.appUpdate(state), { ...base, state: 'recording', elapsedText: '0:18:42', micLevel: 0.68, systemLevel: 0.41 });
  await tab.waitForTimeout(120);
  await say(tab, 'system', 'Расскажите, что такое идемпотентность');
  await say(tab, 'mic', 'Повторный вызов не меняет результат, это защищает от дублей при сбоях');
  await say(tab, 'system', 'Чем Kafka отличается от Rabbit');
  await say(tab, 'mic', 'Kafka это брокер сообщений с высокой пропускной способностью');
  await say(tab, 'system', 'Как устроен JWT');
  await say(tab, 'mic', 'Это токен, в нём три части, а подпись защищает от подмены');
  await tab.waitForTimeout(4400);
}

async function shot(tab, name) {
  await tab.waitForTimeout(350);
  await tab.screenshot({ path: path.join(out, `raw-${name}.png`) });
}

async function frame(browser, names) {
  const context = await browser.newContext({ viewport: { width: W + 80, height: H + 80 }, deviceScaleFactor: 2 });
  const tab = await context.newPage();
  for (const name of names) {
    const image = fs.readFileSync(path.join(out, `raw-${name}.png`)).toString('base64');
    await tab.setContent(`<!doctype html><style>
      html,body{margin:0;background:transparent}
      .w{position:absolute;left:40px;top:28px;width:${W}px;height:${H}px;border-radius:14px;overflow:hidden;
         box-shadow:0 22px 48px rgba(10,10,30,.32),0 0 0 .5px rgba(0,0,0,.28)}
      img{width:100%;height:100%;display:block}
      i{position:absolute;top:10px;width:12px;height:12px;border-radius:50%}
    </style><div class="w"><img src="data:image/png;base64,${image}">
      <i style="left:12px;background:#ff5f57"></i><i style="left:32px;background:#febc2e"></i><i style="left:52px;background:#28c840"></i></div>`);
    await tab.waitForTimeout(100);
    await tab.screenshot({ path: path.join(out, `${name}.png`), omitBackground: true });
    fs.rmSync(path.join(out, `raw-${name}.png`));
  }
  await context.close();
}

async function hero(browser) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 860 }, deviceScaleFactor: 1 });
  const tab = await context.newPage();
  const data = (name) => fs.readFileSync(path.join(out, `${name}.png`)).toString('base64');
  await tab.setContent(`<!doctype html><style>
    html,body{margin:0;height:100%;overflow:hidden;font-family:Inter,-apple-system,sans-serif;color:#fff}
    .bg{position:absolute;inset:0;background:
      radial-gradient(900px 600px at 12% 8%,#ff4d6d 0%,transparent 62%),
      radial-gradient(900px 700px at 92% 12%,#ff9f0a 0%,transparent 58%),
      radial-gradient(1100px 800px at 70% 110%,#00c2a8 0%,transparent 60%),
      linear-gradient(135deg,#2a0f6b,#3b2bd6 55%,#0a84ff)}
    h1{position:absolute;left:0;right:0;top:44px;margin:0;text-align:center;font-size:76px;font-weight:800;letter-spacing:-.03em}
    p{position:absolute;left:0;right:0;top:138px;margin:0;text-align:center;font-size:27px;font-weight:500;opacity:.94}
    img{position:absolute}
    .c{width:560px;left:520px;top:200px;z-index:3}
    .l{width:470px;left:96px;top:262px;z-index:2;transform:rotate(-4deg)}
    .r{width:470px;left:1034px;top:262px;z-index:2;transform:rotate(4deg)}
  </style><div class="bg"></div><h1>Interview Assistant</h1><p>Запись, расшифровка и подсказки для тренировочных собеседований</p>
  <img class="l" src="data:image/png;base64,${data('record')}">
  <img class="c" src="data:image/png;base64,${data('interview')}">
  <img class="r" src="data:image/png;base64,${data('summary')}">`);
  await tab.waitForTimeout(300);
  await tab.screenshot({ path: path.join(out, 'hero.png') });
  await context.close();
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const errors = [];

  const light = await open(browser, 'light');
  light.on('pageerror', (e) => errors.push(e.message));
  await shot(light, 'record');

  await playInterview(light);
  await say(light, 'system', 'А теперь расскажите про', false);
  await shot(light, 'interview');

  await say(light, 'system', 'А теперь расскажите про CAP теорему');
  await say(light, 'mic', 'Честно говоря, не помню точную формулировку');
  await say(light, 'system', 'Что такое шардирование');
  await light.evaluate((state) => window.appUpdate(state), { ...base, state: 'stopping', elapsedText: '0:32:07' });
  await light.waitForTimeout(300);
  await light.evaluate((state) => window.appUpdate(state), { ...base, elapsedText: '0:32:07' });
  await shot(light, 'summary');

  await light.click('[data-tab=settings]');
  await shot(light, 'settings');
  await light.click('[data-tab=help]');
  await shot(light, 'help');

  const dark = await open(browser, 'dark');
  dark.on('pageerror', (e) => errors.push(e.message));
  await playInterview(dark);
  await shot(dark, 'interview-dark');

  await frame(browser, ['record', 'interview', 'summary', 'settings', 'help', 'interview-dark']);
  await hero(browser);
  await browser.close();
  console.log('errors', errors);
})();
