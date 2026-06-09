# Version Update Log

## v1.5.0 — Async Worker Pool (2026-06-09)

### 問題
Bot 順序處理每個訊息：LLM (30-60s) + TTS (5-10s) 完全 blocking handler，
下一個訊息只能排隊等待，導致回應極慢。

### 解法
Producer-Consumer 架構：handler 秒回「⏳ Processing...」後立即把任務放進 queue，
背景 workers 負責 LLM → TTS → 回覆，可並行處理多個請求。

```
User → Telegram → Handler（ack 後立即返回）
                      │
                      ▼
              asyncio.Queue ──→ Worker 1 (LLM + TTS + send reply)
                      │        Worker 2 (LLM + TTS + send reply)
                      │        Worker 3 (LLM + TTS + send reply)
```

### 改動

| 檔案 | 狀態 | 說明 |
|------|------|------|
| `bot/worker.py` | 🆕 新增 | WorkerPool — asyncio.Queue + N workers（預設 3） |
| `bot/handlers.py` | 📝 重寫 | handler 只做 acknowledge + enqueue，不 blocking |
| `bot/opencode_client.py` | 📝 優化 | 共用 httpx 連線池取代每次 new client |
| `main.py` | 📝 改寫 | post_init/post_stop 管理 worker pool 生命週期 |
| `tests/conftest.py` | 🆕 新增 | 自動 set PYTHONPATH |
| `tests/test_worker.py` | 🆕 新增 | 5 個測試（start/stop、並行、錯誤隔離、並發限制） |
| `.env` | 📝 新增 | `BOT_WORKERS=3` |
| `.gitignore` | 📝 新增 | `.pytest_cache/` `tests/__pycache__/` |

### 測試
```bash
cd telegram-voice-bot && .venv/bin/pytest tests/ -v
# 5 passed
```

---

## v1.4.0 — Connection Pool (2026-06-09)

### 改動
- `bot/opencode_client.py`: 共用 httpx.AsyncClient 連線池（max 50 connections, keepalive 30s）
- 避免每次 LLM/TTS 呼叫都建立新 TCP 連線
- 新增 `close_client()` 供優雅關閉

---

## v1.3.0 — Session Timeout Fix (2026-06-09)

### 問題
OpenCode 首次 session 建立需要較長時間，舊 timeout (30s) 不足。

### 改動
- `bot/opencode_client.py`: httpx timeout 提高至 120s

---

## v1.2.0 — OpenCode Serve API (2026-06-08)

### 問題
舊架構直接呼叫 NVIDIA NIM API，無法使用 OpenCode 的 AGENTS.md + 工具 + MCP。

### 解法
改用 `opencode serve` HTTP API（`POST /session` + `POST /session/{id}/message`），
Telegram Bot 與 CLI 擁有相同的 agent、config、記憶。

### 改動

| 檔案 | 狀態 | 說明 |
|------|------|------|
| `bot/opencode_client.py` | 🆕 新增 | OpenCode serve API client（session 管理、chat、TTS） |
| `bot/openrouter.py` | 📝 保留 | 舊直接 LLM 呼叫保留作為 fallback |
| `main.py` | 📝 簡化 | 移除 direct LLM 邏輯 |
| `.env` | 📝 更新 | 移除 LLM 相關變數 |

### 架構變更
```
舊: User → Bot → NVIDIA NIM API → TTS
新: User → Bot → OpenCode Serve API → NVIDIA NIM + Agent + Tools → TTS
```

---

## v1.1.0 — DeepSeek + Rate Limit (2026-06-08)

### 問題
Nemotron 3 Super 回應太慢，system prompt 過長導致 timeout。

### 改動
- 切換模型至 `deepseek-ai/deepseek-v4-flash`
- 精簡 system prompt（只保留核心身份）
- 讀取 AGENTS.md + memory_compact.md 作為系統提示
- `bot/config.py`: `build_system_prompt()` 改為讀取檔案

---

## v1.0.0 — 初始版本 (2026-06-08)

### 首次發布
功能完整的 Telegram 語音/文字對話 Bot。

### 功能
- 文字訊息 → LLM 回應 + TTS 語音回覆
- 語音訊息 → Whisper STT → LLM 回應 → TTS 語音回覆
- NVIDIA NIM API 直連
- edge-tts 中文 TTS（zh-CN-XiaoxiaoNeural）
- 白名單使用者控制（ALLOWED_USER_IDS）
- systemd 服務自動啟動
- `.env` 環境變數配置

### 檔案結構

```
telegram-voice-bot/
├── main.py              # 入口點
├── bot/
│   ├── config.py        # 環境變數 + 設定
│   ├── handlers.py      # Telegram handler
│   ├── openrouter.py    # NVIDIA NIM LLM client
│   ├── whisper.py       # Whisper STT client
│   └── opencode_client.py  # OpenCode API client (v1.2.0+)
├── .env                 # 環境變數（gitignored）
├── .env.example         # 環境變數範本
├── requirements.txt     # Python 依賴
└── VERSION_UPDATE.md    # 本檔案
```

### 依賴
- python-telegram-bot >= 21.0
- httpx >= 0.27
- python-dotenv >= 1.0
- edge-tts（執行期動態 import）
