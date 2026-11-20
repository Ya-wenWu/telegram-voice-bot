$ErrorActionPreference = "Stop"
Write-Host "=== Web Voice Bot (Windows 11) 啟動檢查 ===" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "找不到 node，請先安裝 Node.js 20+ (https://nodejs.org/)"
}
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "找不到 python，請先安裝 Python 3.11+ 並勾選 Add python.exe to PATH"
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Warning "找不到 ffmpeg！請先執行: winget install Gyan.FFmpeg 並重開終端機，否則語音錄音與 MP3 合併會失敗。"
}

if (-not (Test-Path "node_modules")) {
    Write-Host "正在安裝 Node.js 依賴 (npm install)..." -ForegroundColor Yellow
    npm install
}

$venvPy = ".\telegram-voice-bot\.venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
    Write-Host "正在建立 Python 虛擬環境並安裝依賴..." -ForegroundColor Yellow
    python -m venv telegram-voice-bot\.venv
    & $venvPy -m pip install --upgrade pip
    & $venvPy -m pip install -r telegram-voice-bot\requirements-dev.txt
}

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Warning "已建立 .env 檔案！請先在 .env 填入你的 GEMINI_API_KEY 後存檔，再重新執行本腳本。"
    notepad .env
    exit 1
}

Write-Host "啟動 Web Voice Bot 伺服器 -> http://localhost:3000" -ForegroundColor Green
npm run dev
