#!/bin/bash
# Скачивает whisper.cpp для Windows и модель определения речи в resources/whisper.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="v1.9.2"
TARGET="resources/whisper"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
mkdir -p "$TARGET"
curl -fsSL -o "$TEMP/whisper.zip" "https://github.com/ggml-org/whisper.cpp/releases/download/$VERSION/whisper-bin-x64.zip"
unzip -q "$TEMP/whisper.zip" -d "$TEMP/unpacked"
RELEASE="$TEMP/unpacked/Release"
cp "$RELEASE"/whisper-cli.exe "$RELEASE"/whisper-server.exe "$RELEASE"/whisper.dll "$RELEASE"/ggml.dll "$RELEASE"/ggml-base.dll "$RELEASE"/ggml-cpu-*.dll "$TARGET/"
curl -fsSL -o "$TARGET/ggml-silero-v5.1.2.bin" "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
curl -fsSL -o "$TARGET/WHISPER-LICENSE.txt" "https://raw.githubusercontent.com/ggml-org/whisper.cpp/$VERSION/LICENSE"
echo "Готово: $TARGET"
