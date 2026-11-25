#!/usr/bin/env bash
set -euo pipefail

echo ""
echo "=== Web Voice Bot (Linux / macOS) 啟動與防呆檢查 ==="

# 1. Node.js 20+ check
if ! command -v node >/dev/null 2>&1; then
  echo "錯誤：找不到 node，請先安裝 Node.js 20+ (https://nodejs.org/)" >&2
  exit 1
fi
NODE_VER="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VER%%.*}"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "錯誤：Node.js 版本過舊（目前 v$NODE_VER），請升級至 Node.js 20+。" >&2
  exit 1
fi
echo "[OK] Node.js v$NODE_VER"

# 2. Python 3.11+ check
if ! command -v python3 >/dev/null 2>&1; then
  echo "錯誤：找不到 python3，請先安裝 Python 3.11+" >&2
  exit 1
fi
PY_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")')"
PY_OK="$(python3 -c 'import sys; print(1 if sys.version_info >= (3, 11) else 0)')"
if [ "$PY_OK" != "1" ]; then
  echo "錯誤：Python 版本過舊（目前 $PY_VER），請安裝 Python 3.11+。" >&2
  exit 1
fi
echo "[OK] Python $PY_VER"

# 3. ffmpeg check
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "警告：找不到 ffmpeg！純文字對話仍可用，但麥克風語音辨識與 MP3 語音回覆會失敗。" >&2
  echo "    Ubuntu/Debian 安裝：sudo apt update && sudo apt install -y ffmpeg python3-venv" >&2
else
  echo "[OK] ffmpeg 已安裝"
fi

# 4. Auto-enable Git secret leak protection hook if inside a git repo
if [ -d ".git" ] && command -v git >/dev/null 2>&1; then
  CURRENT_HOOKS="$(git config --get core.hooksPath 2>/dev/null || true)"
  if [ -z "$CURRENT_HOOKS" ] && [ -f ".githooks/pre-commit" ]; then
    chmod +x .githooks/pre-commit 2>/dev/null || true
    git config core.hooksPath .githooks
    echo "[OK] 已自動啟用 Git 防金鑰外洩 Hook (.githooks/pre-commit)"
  fi
  if git ls-files --error-unmatch .env >/dev/null 2>&1; then
    echo "警告：.env 目前被 Git 追蹤中！請立刻執行 'git rm --cached .env' 以免把 API Key 推上 GitHub。" >&2
  fi
fi

# 5. Install Node.js dependencies
if [ ! -d "node_modules" ]; then
  echo "正在安裝 Node.js 依賴 (npm install)..."
  npm install
fi

# 6. Create Python venv & install dependencies
VENV_PY="./telegram-voice-bot/.venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  echo "正在建立 Python 虛擬環境並安裝依賴..."
  python3 -m venv telegram-voice-bot/.venv
  "$VENV_PY" -m pip install --upgrade pip
  "$VENV_PY" -m pip install -r telegram-voice-bot/requirements-dev.txt
fi

# 7. Foolproof .env & GEMINI_API_KEY setup (masked input + chmod 600)
if [ ! -f ".env" ]; then
  cp .env.example .env
  chmod 600 .env 2>/dev/null || true
  echo "[INFO] 已從 .env.example 建立本機 .env（權限 600，且已在 .gitignore 排除）"
fi

read_env_val() {
  local key="$1"
  local line
  line="$(grep -E "^[[:space:]]*${key}=" .env 2>/dev/null | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "$line"
}

is_invalid_key() {
  local k="$1"
  if [ -z "$k" ] || [ "${#k}" -lt 20 ]; then
    return 0
  fi
  # Strict allowlist: Gemini API keys only contain [A-Za-z0-9_-] (blocks quotes, $, backticks, spaces)
  if ! printf '%s' "$k" | grep -qE '^[A-Za-z0-9_-]{20,}$'; then
    return 0
  fi
  if printf '%s' "$k" | grep -qiE '^(MY_GEMINI_API_KEY|YOUR_API_KEY|YOUR_GEMINI_API_KEY|REPLACE_ME|CHANGEME|EXAMPLE|TEST|XXX+|TODO)$'; then
    return 0
  fi
  return 1
}

EXISTING_KEY="${GEMINI_API_KEY:-$(read_env_val GEMINI_API_KEY)}"
if is_invalid_key "$EXISTING_KEY"; then
  echo ""
  echo "尚未設定有效的 GEMINI_API_KEY（免費申請：https://aistudio.google.com/apikey）"
  echo "請直接貼上你的 Gemini API Key（輸入過程會自動隱藏，只寫入本機 .env）："
  read -rsp "GEMINI_API_KEY: " INPUT_KEY
  echo ""
  INPUT_KEY="$(printf '%s' "$INPUT_KEY" | tr -d '\r\n')"
  if is_invalid_key "$INPUT_KEY"; then
    echo "錯誤：金鑰為空或格式無效（Gemini API Key 不含空白且長度至少 20 字元）。請重新執行 ./start-linux.sh" >&2
    exit 1
  fi
  python3 - "$INPUT_KEY" <<'PYEOF'
import pathlib, re, sys
key = sys.argv[1]
env_file = pathlib.Path(".env")
lines = env_file.read_text(encoding="utf-8").splitlines()
updated = False
out = []
for line in lines:
    if re.match(r"^\s*GEMINI_API_KEY\s*=", line):
        out.append(f'GEMINI_API_KEY="{key}"')
        updated = True
    else:
        out.append(line)
if not updated:
    out.append(f'GEMINI_API_KEY="{key}"')
env_file.write_text("\n".join(out) + "\n", encoding="utf-8")
PYEOF
  chmod 600 .env 2>/dev/null || true
  echo "[OK] 已安全寫入本機 .env（權限 600，受 .gitignore 保護）"
else
  echo "[OK] GEMINI_API_KEY 已就緒"
fi

# 8. Adaptive Resource Detection (<= 1 GB RAM -> 1C/1G Single Telegram Bot; > 1 GB -> Unified High-Concurrency Single Website)
PROFILE_EVAL="$(PYTHONPATH=telegram-voice-bot PYTHONDONTWRITEBYTECODE=1 "$VENV_PY" telegram-voice-bot/bot/resource_profile.py --shell 2>/dev/null || PYTHONPATH=telegram-voice-bot PYTHONDONTWRITEBYTECODE=1 python3 telegram-voice-bot/bot/resource_profile.py --shell 2>/dev/null || true)"
if [ -n "$PROFILE_EVAL" ]; then
  eval "$PROFILE_EVAL"
fi
PROFILE_MODE="${PROFILE_MODE:-high_concurrency}"
EFFECTIVE_RAM_MB="${EFFECTIVE_RAM_MB:-2048}"
EFFECTIVE_CPU_CORES="${EFFECTIVE_CPU_CORES:-2}"
MAX_BOT_INSTANCES="${MAX_BOT_INSTANCES:-4}"

echo "[RESOURCE] 偵測到有效可用記憶體: ${EFFECTIVE_RAM_MB} MB / CPU: ${EFFECTIVE_CPU_CORES} 核心"
echo "[RESOURCE] 自動選定部署模式: ${PROFILE_MODE} (${PROFILE_TIER:-default}, max_bots=${MAX_BOT_INSTANCES})"

if [ "$PROFILE_MODE" = "constrained_1c1g" ]; then
  echo ""
  echo "=================================================================="
  echo " [1C/1G 保護模式] 伺服器可用記憶體 <= 1 GB (${EFFECTIVE_RAM_MB} MB)"
  echo " 僅啟用受限 1 核心 CPU / 1 GB RAM 單一 Telegram Bot，不啟動高併發多 Bot 與多餘服務"
  echo "=================================================================="
  export DEPLOYMENT_PROFILE="constrained"
  export MAX_BOT_INSTANCES="1"
  export BOT_WORKERS="1"
  export CONCURRENT_UPDATES="1"
  export BOT_QUEUE_MAXSIZE="10"
  export FFMPEG_CONCURRENCY="1"
  export TTS_CONCURRENCY="2"
  export REDIS_SEMAPHORE_ENABLED="false"
  export OMP_NUM_THREADS="1"
  if command -v taskset >/dev/null 2>&1; then
    exec taskset -c 0 "$VENV_PY" telegram-voice-bot/main.py
  else
    exec "$VENV_PY" telegram-voice-bot/main.py
  fi
fi

# 9. Port check (High-Concurrency Unified Single Website on Port 3000)
export DEPLOYMENT_PROFILE="${DEPLOYMENT_PROFILE:-auto}"
export MAX_BOT_INSTANCES
export BOT_WORKERS="${BOT_WORKERS:-4}"
export CONCURRENT_UPDATES="${CONCURRENT_UPDATES:-4}"
export BOT_QUEUE_MAXSIZE="${BOT_QUEUE_MAXSIZE:-32}"
export FFMPEG_CONCURRENCY="${FFMPEG_CONCURRENCY:-2}"
export TTS_CONCURRENCY="${TTS_CONCURRENCY:-8}"
export REDIS_SEMAPHORE_ENABLED="${REDIS_SEMAPHORE_ENABLED:-true}"

PORT_NUM="${PORT:-$(read_env_val PORT)}"
PORT_NUM="${PORT_NUM:-3000}"
if command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :$PORT_NUM )" 2>/dev/null | grep -q ":$PORT_NUM"; then
  echo "警告：Port $PORT_NUM 已被其他程式佔用！若無法啟動，請在 .env 設定 PORT=$((PORT_NUM + 1))" >&2
fi

echo ""
echo "啟動高併發統一單一網站伺服器 (支援最多 ${MAX_BOT_INSTANCES} 個 Bot 共用高併發語音池) -> http://localhost:${PORT_NUM}"
npm run dev
