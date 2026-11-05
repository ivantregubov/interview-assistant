<p align="center">
  <img src="docs/screenshots/hero.png" alt="Interview Assistant: окна записи, живого интервью и итогов" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/macOS-26%2B-111111?style=for-the-badge&logo=apple&logoColor=white" alt="macOS 26+">
  <img src="https://img.shields.io/badge/Windows-x64-0078D4?style=for-the-badge&logoColor=white" alt="Windows x64">
  <img src="https://img.shields.io/badge/Swift-F05138?style=for-the-badge&logo=swift&logoColor=white" alt="Swift">
  <img src="https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron">
  <img src="https://img.shields.io/badge/Whisper-6E40C9?style=for-the-badge&logoColor=white" alt="Whisper">
  <img src="https://img.shields.io/badge/DeepSeek-4D6BFE?style=for-the-badge&logoColor=white" alt="DeepSeek">
  <img src="https://img.shields.io/badge/OpenRouter-FF7A18?style=for-the-badge&logoColor=white" alt="OpenRouter">
</p>

<h3 align="center">Записывайте собеседования, получайте расшифровку и тренируйтесь с подсказками ИИ</h3>

<p align="center">
  <a href="#-возможности">Возможности</a> •
  <a href="#-скриншоты">Скриншоты</a> •
  <a href="#-как-это-работает">Как это работает</a> •
  <a href="#-установка">Установка</a> •
  <a href="#-статус-проекта">Статус</a>
</p>

---

**Interview Assistant** помогает готовиться к собеседованиям. Приложение записывает разговор, разделяет ваш голос и голос собеседника, а в режиме тренировки распознаёт вопросы, сразу даёт короткую подсказку и оценивает ответы.

> [!IMPORTANT]
> Подсказки предназначены для тренировочных интервью. Предупреждайте собеседника о записи: требования к согласию зависят от страны и правил компании.

## ✨ Возможности

| | Функция | Что она даёт |
| --- | --- | --- |
| 🎥 | **Запись экрана** | Видео с курсором, микрофоном и звуком собеседника |
| 🖥️ | **Выбор экрана** | Мониторы показаны прямоугольниками в их реальном расположении |
| 📝 | **Расшифровка** | Диалог «Интервьюер» и «Я» с метками времени в `transcript.md` |
| 💡 | **Живые подсказки** | Вопрос и ответ-подсказка до 10 строк прямо во время записи |
| ✅ | **Оценка ответов** | Зелёная галочка за верный ответ, комментарий к неполному |
| 📊 | **Итоги** | Количество вопросов, доля правильных ответов, весь список в `interview-report.md` |
| 🔑 | **Свой API-ключ** | DeepSeek или OpenRouter, ключ хранится на вашем компьютере |
| 🌗 | **Светлая и тёмная тема** | Интерфейс следует настройкам системы |

## 📸 Скриншоты

<table>
  <tr>
    <td align="center"><b>🎥 Запись</b></td>
    <td align="center"><b>💡 Живое интервью</b></td>
    <td align="center"><b>📊 Итоги</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/record.png" alt="Вкладка записи с выбором экрана"></td>
    <td><img src="docs/screenshots/interview.png" alt="Вопросы, подсказки и оценка ответов"></td>
    <td><img src="docs/screenshots/summary.png" alt="Итоговая статистика интервью"></td>
  </tr>
  <tr>
    <td align="center"><b>⚙️ Настройки</b></td>
    <td align="center"><b>📖 Справка</b></td>
    <td align="center"><b>🌙 Тёмная тема</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/settings.png" alt="Настройки подсказок и API-ключа"></td>
    <td><img src="docs/screenshots/help.png" alt="Встроенная справка"></td>
    <td><img src="docs/screenshots/interview-dark.png" alt="Живое интервью в тёмной теме"></td>
  </tr>
</table>

<sub>На снимках настоящий интерфейс приложения с демонстрационными данными. Они сделаны в браузере скриптом `docs/make-screenshots.js`, рамка окна дорисована, а шрифт может отличаться от системного.</sub>

## 🧠 Как это работает

```mermaid
flowchart LR
    A["🎙️ Микрофон"]:::voice --> C["📝 Распознавание<br>на компьютере"]:::local
    B["🔊 Звук собеседника"]:::voice --> C
    C -->|только текст| D["🤖 DeepSeek<br>или OpenRouter"]:::cloud
    D --> E["💡 Подсказка"]:::result
    D --> F["✅ Оценка ответа"]:::result
    E --> G["📊 Итоги интервью"]:::final
    F --> G
    classDef voice fill:#FF4D6D,stroke:#C9184A,color:#fff
    classDef local fill:#3B2BD6,stroke:#2A0F6B,color:#fff
    classDef cloud fill:#FF9F0A,stroke:#C77700,color:#fff
    classDef result fill:#00C2A8,stroke:#008F7C,color:#fff
    classDef final fill:#34C759,stroke:#248A3D,color:#fff
```

Голоса записываются отдельными дорожками, поэтому в расшифровке сразу понятно, кто что сказал. Запись работает независимо от подсказок: если сервис недоступен, видео и звук всё равно сохранятся.

## 🚀 Установка

Интерфейс приложения на русском языке.

<details open>
<summary><b>🍎 macOS 26 и новее</b></summary>

Нужны Xcode Command Line Tools.

```bash
git clone https://github.com/ivantregubov/interview-assistant.git
cd interview-assistant
bash mac/build.sh
```

Скрипт соберёт приложение, поставит его в `~/Applications` и запустит. Затем разрешите доступ к микрофону и записи экрана. Для установочного файла добавьте флаг `--package`: `bash mac/build.sh --package`.

</details>

<details>
<summary><b>🪟 64-битная Windows</b></summary>

Нужен Node.js. Сборка на Linux или macOS также требует Wine.

```powershell
git clone https://github.com/ivantregubov/interview-assistant.git
cd interview-assistant\windows
npm install
powershell -ExecutionPolicy Bypass -File scripts\fetch-whisper.ps1
npm run dist
```

Установщик появится в `windows/dist`. На Linux и macOS вместо PowerShell используйте `bash scripts/fetch-whisper.sh`. На компьютере пользователя нужен Microsoft Visual C++ Redistributable, а модели распознавания скачиваются при первом использовании.

</details>

### 🔑 Как включить подсказки

1. Получите API-ключ на [platform.deepseek.com](https://platform.deepseek.com/api_keys) или [openrouter.ai](https://openrouter.ai/keys).
2. На вкладке «Настройки» выберите сервис, вставьте ключ и нажмите «Проверить».
3. Начните запись: вопросы, подсказки и оценки появятся на вкладке «Интервью».

Если читаете вопросы вслух сами, выберите в настройках «Собеседник и я».

## 📁 Что сохраняется

| Файл | Содержимое |
| --- | --- |
| 🎬 `screen.mov` или `screen.mp4` | Видео с курсором и звуком |
| 🎙️ `mic.m4a` или `mic.wav` | Только ваш голос |
| 🔊 `system.m4a` или `system.wav` | Только собеседник |
| 📝 `transcript.md`, `transcript.json` | Диалог с метками времени |
| 📊 `interview-report.md`, `interview-report.json` | Итоги, вопросы, подсказки и ответы |

## 🔒 Приватность

- 🖥️ Запись и распознавание речи работают на вашем компьютере.
- 📤 В выбранный сервис LLM отправляется только текст распознанной речи. Аудио и видео не отправляются.
- 🔑 API-ключ хранится в Связке ключей на Mac и в зашифрованном файле на Windows. В репозитории ключей нет.

## 🧩 Устройство проекта

| Папка | Содержимое |
| --- | --- |
| 🍎 [`mac/`](mac) | Swift: ScreenCaptureKit, Speech, WKWebView |
| 🪟 [`windows/`](windows) | Electron и whisper.cpp |
| 🖼️ [`docs/`](docs) | Скриншоты и скрипт для их создания |

Файлы `coach.js` и `coach-ui.js` одинаковы в `mac/UI` и `windows/ui`. Меняйте их в обеих папках.

```bash
cd windows && npm test
```

Сквозные тесты `test/e2e.js` и `test/e2e-live.js` используют Playwright и имитацию речи и LLM.

## 🚧 Статус проекта

Проект на ранней стадии.

| Что | Статус |
| --- | --- |
| Запись и расшифровка на Mac | ✅ Работает на macOS 26.1 |
| Логика подсказок, оценок и статистики | ✅ Покрыта автотестами на имитации |
| Живые подсказки на Mac | 🟡 Собираются, в реальных условиях ещё проверяются |
| Версия для Windows | 🟡 Проверялась на Linux и в Wine, на настоящей Windows ещё нет |
| Настоящий Whisper на Windows | 🟡 Ещё не запускался |
| Подпись приложений | ⚪ Подписи нет, при первом запуске система покажет предупреждение |

## 🙏 Сторонние компоненты

Версия для Windows использует [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (лицензия MIT) и модели, которые скачиваются при сборке или использовании. Лицензия whisper.cpp сохраняется в `windows/resources/whisper/WHISPER-LICENSE.txt`.
