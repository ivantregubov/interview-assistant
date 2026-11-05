# Скачивает whisper.cpp для Windows и модель определения речи в resources\whisper.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$Version = "v1.9.2"
$Target = "resources\whisper"
$Temp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $Temp, $Target | Out-Null
try {
    $Zip = Join-Path $Temp "whisper.zip"
    Invoke-WebRequest -Uri "https://github.com/ggml-org/whisper.cpp/releases/download/$Version/whisper-bin-x64.zip" -OutFile $Zip
    Expand-Archive -Path $Zip -DestinationPath (Join-Path $Temp "unpacked")
    $Release = Join-Path $Temp "unpacked\Release"
    foreach ($Name in "whisper-cli.exe", "whisper-server.exe", "whisper.dll", "ggml.dll", "ggml-base.dll") {
        Copy-Item (Join-Path $Release $Name) $Target
    }
    Copy-Item (Join-Path $Release "ggml-cpu-*.dll") $Target
    Invoke-WebRequest -Uri "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" -OutFile (Join-Path $Target "ggml-silero-v5.1.2.bin")
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/ggml-org/whisper.cpp/$Version/LICENSE" -OutFile (Join-Path $Target "WHISPER-LICENSE.txt")
    Write-Host "Готово: $Target"
} finally {
    Remove-Item -Recurse -Force $Temp
}
