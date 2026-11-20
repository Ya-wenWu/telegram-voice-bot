# Web Voice Bot — 完整本地執行專案（支援 Windows 11 / macOS / Linux）

本壓縮檔已將目前線上運行的完整前後端專案與強化後的 `telegram-voice-bot` 核心全部整合在單一資料夾 `web-voice-bot-complete/` 中，並已完成 **Windows 11 專屬相容性修復**（`fcntl` / `msvcrt` 鎖定、UTF-8 管線編碼、`ffmpeg` Windows 路徑正規化、`python -m ruff`）。

---

## 資料夾結構說明（請勿將根目錄檔案塞進 `telegram-voice-bot/` 裡面）

```
web-voice-bot-complete/
├── package.json            # Node.js / Vite / Express 依賴設定
├── server.ts               # Express + Gemini STT/AI + ffmpeg 音訊正規化伺服器
├── bot_bridge.py           # 連接 Python 核心的橋接程式
├── .env.example            # 環境變數範本（複製為 .env 並填入 GEMINI_API_KEY）
├── start-win11.ps1         # Windows 11 一鍵檢查與啟動腳本
├── index.html              # 前端入口
├── src/                    # React + Tailwind 前端網頁（Web Voice Bot 介面）
└── telegram-voice-bot/     # Python 語音機器人核心（ConversationStore / Edge-TTS / pytest）
```

> ⚠️ **注意**：如果你先前把檔案直接覆蓋進舊的 `telegram-voice-bot` 資料夾，建議改將此 ZIP **解壓縮到一個乾淨的新資料夾**（例如 `C:\Projects\web-voice-bot-complete`），並在 `web-voice-bot-complete` **最外層** 執行以下指令。

---

## Windows 11 快速啟動步驟（PowerShell）

### 1. 事前準備（確認已安裝）
- **Node.js 20+**（`node -v`）
- **Python 3.11+**（`python --version`）
- **ffmpeg**（語音錄音轉檔與多句 MP3 拼接必備）：
  ```powershell
  winget install Gyan.FFmpeg
  ```
  > 安裝完 `ffmpeg` 後，請**重新開啟一個新的 PowerShell 視窗**，確認 `ffmpeg -version` 有輸出。

### 2. 安裝前端與後端依賴（在 `web-voice-bot-complete` 根目錄執行）
```powershell
# 1) 安裝 Node.js 套件
npm install

# 2) 建立 Python 虛擬環境並安裝核心與測試套件
python -m venv telegram-voice-bot\.venv
.\telegram-voice-bot\.venv\Scripts\python.exe -m pip install --upgrade pip
.\telegram-voice-bot\.venv\Scripts\python.exe -m pip install -r telegram-voice-bot\requirements-dev.txt
```

### 3. 設定 Gemini API 金鑰
```powershell
Copy-Item .env.example .env
notepad .env
```
將 `.env` 裡的 `GEMINI_API_KEY` 改為你的 Google AI Studio API Key（免費申請：https://aistudio.google.com/apikey ）並存檔。

### 4. 啟動 Web Voice Bot
```powershell
npm run dev
```
（或直接執行內附腳本：`powershell -ExecutionPolicy Bypass -File .\start-win11.ps1`）

啟動成功後，在 Chrome / Edge 瀏覽器開啟：
👉 **http://localhost:3000**

> ℹ️ `localhost` 屬於瀏覽器安全來源（Secure Context），Chrome / Edge 會直接開放麥克風錄音權限。

---

## macOS / Linux 快速啟動步驟

```bash
npm install
python3 -m venv telegram-voice-bot/.venv
telegram-voice-bot/.venv/bin/pip install -r telegram-voice-bot/requirements-dev.txt
cp .env.example .env   # 填入 GEMINI_API_KEY
npm run dev
```
瀏覽器開啟 `http://localhost:3000`。
