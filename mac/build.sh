#!/bin/bash
# Собирает Interview Assistant.app, заменяет версию в ~/Applications, сбрасывает устаревшее
# разрешение на запись экрана и запускает новую версию.
# С флагом --package только собирает установочный build/InterviewAssistant.dmg.
set -euo pipefail
cd "$(dirname "$0")"

if ! xcrun --find swiftc >/dev/null 2>&1; then
    echo "Нужны Xcode Command Line Tools. Сейчас откроется установщик."
    echo "После установки запустите этот скрипт ещё раз."
    xcode-select --install || true
    exit 1
fi

APP="build/Interview Assistant.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp Info.plist "$APP/Contents/Info.plist"
cp UI/* "$APP/Contents/Resources/"

echo "Компилирую..."
xcrun swiftc \
    -O \
    -swift-version 5 \
    -parse-as-library \
    -target "$(uname -m)-apple-macos26.0" \
    -sdk "$(xcrun --show-sdk-path --sdk macosx)" \
    Sources/*.swift \
    -o "$APP/Contents/MacOS/InterviewAssistant"

xattr -cr "$APP"
codesign --force --sign - "$APP"

if [ "${1:-}" = "--package" ]; then
    STAGE="build/dmg"
    rm -rf "$STAGE" build/InterviewAssistant.dmg
    mkdir -p "$STAGE"
    cp -R "$APP" "$STAGE/"
    ln -s /Applications "$STAGE/Applications"
    hdiutil create -volname "Interview Assistant" -srcfolder "$STAGE" -ov -format UDZO build/InterviewAssistant.dmg
    echo "Готово: build/InterviewAssistant.dmg"
    exit 0
fi

# Завершаем запущенную версию. Если идёт запись, новая версия приложения сначала сохранит файлы.
# InterviewRecorder: так приложение называлось в прежних версиях.
for NAME in InterviewAssistant InterviewRecorder; do
    if pgrep -x "$NAME" >/dev/null; then
        echo "Закрываю запущенную версию..."
        pkill -x "$NAME" || true
        for _ in {1..30}; do
            pgrep -x "$NAME" >/dev/null || break
            sleep 1
        done
    fi
done

DEST="$HOME/Applications"
mkdir -p "$DEST"
rm -rf "$DEST/Interview Assistant.app" "$DEST/Interview Recorder.app"
cp -R "$APP" "$DEST/"

# Локальная подпись меняется при каждой сборке, и macOS перестаёт считать старое разрешение действующим.
tccutil reset ScreenCapture local.ivan.interviewassistant || true
tccutil reset ScreenCapture local.ivan.interviewrecorder || true

echo "Готово: $DEST/Interview Assistant.app"
open "$DEST/Interview Assistant.app"
