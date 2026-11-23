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

## 🛠️ 開發環境與資安防護一鍵建置（DeveloperSetting）

專案內建跨平台自動化配置腳本，可一鍵安裝 **Gitleaks**、**Node.js v24 LTS**、**SonarQube for IDE**，並自動掛載 **Git Pre-commit Hook** 防止敏感資料外洩。

### 1. 執行方式（Windows 請先關閉 Visual Studio 再執行）
* **Windows 10 / 11（Visual Studio 2022 / 2026）**：
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\DeveloperSetting\setup-dev-win10orabove-visualstudio.ps1
  ```
* **Linux（Ubuntu / Debian / Fedora / Arch）**：
  ```bash
  chmod +x ./DeveloperSetting/setup-dev-linux.sh && ./DeveloperSetting/setup-dev-linux.sh
  ```
* **macOS（Apple Silicon & Intel）**：
  ```bash
  chmod +x ./DeveloperSetting/setup-dev-mac.sh && ./DeveloperSetting/setup-dev-mac.sh
  ```

### 2. 執行前完整性驗證（SHA-256）
執行腳本前，建議先計算本機檔案的 SHA-256 指紋並核對是否與下列基準一致：
* `setup-dev-win10orabove-visualstudio.ps1`：`<貼上對應的 64 位元 Hash>`
* `setup-dev-linux.sh`：`<貼上對應的 64 位元 Hash>`
* `setup-dev-mac.sh`：`<貼上對應的 64 位元 Hash>`

驗證指令：
* **Windows**：`Get-FileHash .\DeveloperSetting\* -Algorithm SHA256 | Format-List`
* **Linux**：`sha256sum ./DeveloperSetting/*.sh`
* **macOS**：`shasum -a 256 ./DeveloperSetting/*.sh`

# 自動ruff check format
## 1. 確保虛擬環境已安裝 ruff
```
.\.venv-win\Scripts\pip.exe install ruff -q
```

## 2. 執行語法與風格檢查（對應 CI 的 ruff check）
```
.\.venv-win\Scripts\ruff.exe check telegram-voice-bot
```

## 3. 自動修正排版並驗證（對應 CI 的 ruff format --check）
```
.\.venv-win\Scripts\ruff.exe format .
.\.venv-win\Scripts\ruff.exe format --check .
```