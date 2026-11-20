# Web Voice Bot — Windows 11 / Linux 雙平台完整專案

本專案整合 React + Express 前端與強化版 Python `telegram-voice-bot` 核心，**同一套程式碼同時支援 Windows 11 與 Linux**，且已移除所有個人信箱與本地 Firebase 金鑰設定，可直接推上 GitHub（`.github/workflows/ci.yml` 路徑已同步修正）。

---

## 資料夾結構

```text
web-voice-bot-complete/
├── .github/                # GitHub Actions CI（已指向 telegram-voice-bot/）
├── package.json            # Node.js / Vite / Express（跨平台 clean 指令）
├── server.ts               # Express + Gemini STT/AI + ffmpeg（支援 .env 自訂 GEMINI_MODEL）
├── bot_bridge.py           # 跨平台 Python 核心橋接（UTF-8 / Windows+Linux）
├── .env.example            # 環境變數範本（零真實金鑰）
├── start-win11.ps1         # Windows 11 一鍵啟動腳本
├── start-linux.sh          # Linux / macOS 一鍵啟動腳本
├── src/                    # Web Voice Bot 網頁前端（內建 Windows / Linux 執行環境切換）
└── telegram-voice-bot/     # Python 核心與 136 項自動化測試
```

---

## 方式 A：Windows 11 執行步驟（PowerShell）

1. 安裝必備工具：Node.js 20+、Python 3.11+（勾選 Add to PATH），以及 ffmpeg：
   ```powershell
   winget install Gyan.FFmpeg
   ```
   （安裝後請重開一個新的 PowerShell 視窗）
2. 進到解壓縮後的 `web-voice-bot-complete` 資料夾，執行一鍵啟動腳本：
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\start-win11.ps1
   ```
3. 首次執行會自動建立 `.env` 並開啟記事本，填入你的 `GEMINI_API_KEY` 存檔後再跑一次即可。
4. 瀏覽器開啟 **http://localhost:3000**。

---

## 方式 B：Linux 執行步驟（Bash）

1. 安裝必備工具（Ubuntu / Debian 範例）：
   ```bash
   sudo apt update && sudo apt install -y ffmpeg python3-venv
   ```
2. 進到解壓縮後的 `web-voice-bot-complete` 資料夾，執行一鍵啟動腳本：
   ```bash
   chmod +x ./start-linux.sh && ./start-linux.sh
   ```
3. 首次執行會自動建立 `.env`，編輯填入 `GEMINI_API_KEY` 後再執行 `./start-linux.sh`。
4. 本機瀏覽器開啟 **http://localhost:3000**（若部署於遠端 Linux IP，請掛載 HTTPS 以啟用麥克風權限）。
