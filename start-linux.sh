#!/usr/bin/env bash
set -euo pipefail

echo "=== Web Voice Bot (Linux / macOS) 啟動檢查 ==="

if ! command -v node >/dev/null 2>&1; then
  echo "錯誤：找不到 node，請先安裝 Node.js 20+ (https://nodejs.org/)" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "錯誤：找不到 python3，請先安裝 Python 3.11+" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "警告：找不到 ffmpeg！Ubuntu/Debian 請執行：sudo apt update && sudo apt install -y ffmpeg python3-venv" >&2
fi

if [ ! -d "node_modules" ]; then
  echo "正在安裝 Node.js 依賴 (npm install)..."
  npm install
fi

VENV_PY="./telegram-voice-bot/.venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  echo "正在建立 Python 虛擬環境並安裝依賴..."
  python3 -m venv telegram-voice-bot/.venv
  "$VENV_PY" -m pip install --upgrade pip
  "$VENV_PY" -m pip install -r telegram-voice-bot/requirements-dev.txt
fi

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "已建立 .env 檔案！請先編輯 .env 填入你的 GEMINI_API_KEY 後再重新執行 ./start-linux.sh"
  exit 1
fi

echo "啟動 Web Voice Bot 伺服器 -> http://localhost:3000"
npm run dev
