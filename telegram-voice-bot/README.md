# telegram-voice-bot

A low-resource Telegram voice bot with text chat, remote speech-to-text
transcription, TTS replies, and daily quota enforcement via Redis.

## Features

- **Text chat** — replies via an OpenAI-compatible LLM endpoint
- **Voice messages** — downloaded to disk temp dir and streamed directly to a
  configurable Whisper-compatible STT endpoint; the LLM response is synthesized
  with an async TTS engine (voice selectable via `TTS_VOICE`) and sent back as
  MP3 audio
- **Short sentences spoken** — replies such as "好。" are not dropped by TTS
- **Daily quotas** — Redis Lua atomic counter with TTL, fail-open, `Asia/Taipei` timezone
- **Single-worker & bounded queue** — `BOT_WORKERS=1`, `CONCURRENT_UPDATES=1`,
  `BOT_QUEUE_MAXSIZE=10` for predictable memory usage and load shedding on low-RAM hosts
- **Voice file cap** — `MAX_VOICE_BYTES=10 MB`, downloaded to disk temp dir (not `BytesIO`)
- **TTS concurrency & timeout guards** — max 3 simultaneous TTS requests, per-sentence
  timeout (`TTS_TIMEOUT_SEC`) with graceful fallback to text-only replies
- **ffmpeg concat hardening** — single-threaded (`-threads 1`) re-encoding with
  `libmp3lame -q:a 4`, serialized via `Semaphore(1)`, and hard timeout (`FFMPEG_TIMEOUT_SEC`)
  with subprocess kill on hang
- **Retry/backoff** — 429/5xx retry with `Retry-After` honouring for LLM and transcription
- **Generic user errors & redacted logs** — internal details never leaked to users,
  and startup/polling errors (such as `InvalidToken`) never print raw secrets to `stderr`

## Requirements

- Python 3.11+ (on minimal Debian/Ubuntu hosts, install `python3-venv` first)
- `ffmpeg` and `ffprobe` (≥ 5 recommended)
- Redis (optional; used for daily quotas only)
- A Telegram bot token from [@BotFather](https://t.me/botfather)

## Installation

```bash
git clone https://github.com/Ya-wenWu/telegram-voice-bot.git
cd telegram-voice-bot
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env` with at minimum:

- `TELEGRAM_BOT_TOKEN` — from @BotFather (required; the bot exits without it)
- `ALLOWED_USER_IDS` — comma-separated Telegram user IDs (empty = deny all)
- `ZEN_API_KEY` — LLM API key (required; the bot exits without it)
- `WHISPER_API_KEY` — STT API key (or set `WHISPER_URL` for self-hosted);
  without either, text chat works but voice transcription fails

Redis is optional at runtime: if it is unreachable, quotas are simply not
enforced (fail-open).

Validate configuration and local dependencies before launching:

```bash
./start.sh --check
```

Run:

```bash
./start.sh
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | (required) | Telegram bot token |
| `ALLOWED_USER_IDS` | (empty) | Comma-separated allowed user IDs; empty = deny all |
| `TTS_VOICE` | (see `bot/config.py`) | TTS voice ID |
| `ZEN_API_BASE` | (see `bot/config.py`) | LLM API base URL (trailing slashes normalized) |
| `ZEN_MODEL` | (see `bot/config.py`) | LLM model name |
| `ZEN_API_KEY` | (required) | LLM API key |
| `WHISPER_API_BASE` | (see `bot/config.py`) | STT API base URL |
| `WHISPER_API_KEY` | (required) | STT API key |
| `WHISPER_MODEL` | (see `bot/config.py`) | STT model |
| `WHISPER_LANGUAGE` | (see `bot/config.py`) | Transcription language hint |
| `WHISPER_URL` | (empty) | Self-hosted STT URL (overrides the remote endpoint) |
| `REDIS_URL` | `redis://127.0.0.1:6379/0` | Redis for daily quotas |
| `DAILY_REQUEST_LIMIT` | `50` | Requests per user per day |
| `TIMEZONE` | `Asia/Taipei` | Timezone for daily quota reset |
| `MAX_VOICE_BYTES` | `10485760` | Max voice message size (10 MB) |
| `TMP_DIR` | (see `bot/config.py`) | Temp directory for voice/TTS files |
| `STATE_DIR` | (see `bot/config.py`) | Directory for `bot.lock` (override under `ProtectHome=true`) |
| `BOT_WORKERS` | (see `bot/config.py`) | Worker pool size (keep 1 on low RAM) |
| `CONCURRENT_UPDATES` | (see `bot/config.py`) | PTB concurrent updates (keep 1 on low RAM) |
| `BOT_QUEUE_MAXSIZE` | (see `bot/config.py`) | Max queued tasks before load shedding |
| `TTS_TIMEOUT_SEC` | (see `bot/config.py`) | Per-sentence TTS timeout in seconds |
| `FFMPEG_TIMEOUT_SEC` | (see `bot/config.py`) | `ffmpeg` concat timeout in seconds |

## Architecture

```
main.py
  ├── --check    → preflight validation (env vars, dirs, ffmpeg)
  ├── post_init  → clean stale TMP_DIR files + start WorkerPool
  ├── post_stop  → drain WorkerPool (15s) + close clients + release lock
  └── run_polling (concurrent_updates=1, catches InvalidToken/TelegramError safely)

bot/handlers.py
  ├── start          — /start command handler
  ├── handle_text    — text messages → bounded WorkerPool (load shedding on QueueFull)
  └── handle_voice   — voice → disk temp file → streamed Whisper STT → WorkerPool

bot/worker.py
  ├── Phase 1: LLM stream (SSE) → throttled partial text (1.0s) + TTS queueing
  ├── Phase 2: fallback to non-streaming chat() on stream failure
  └── Phase 3/4: timed TTS + single-threaded ffmpeg concat + final text delivery

bot/opencode_client.py
  ├── chat()         — non-streaming LLM with retry
  ├── chat_stream()  — SSE streaming, propagates transport errors
  └── tts()          — async TTS synthesis

bot/whisper.py
  └── transcribe()   — Whisper-compatible STT with file streaming + retry

bot/redis_client.py
  └── check_daily_quota() — Lua INCR + EXPIRE, fail-open

bot/retry.py
  └── request_with_retry() — 429/5xx backoff, Retry-After support
```

## Security

- `.env` is never committed; keep permissions `600`
- API keys are redacted from logs via `TokenRedactingFormatter`, and startup
  `InvalidToken` errors are caught before Python prints unredacted tracebacks
- Allowlist defaults to deny-all
- Voice files capped at 10 MB to prevent abuse
- Redis quota failures fail-open (bot stays up, but no quota enforcement during outage)

## Development

```bash
# Install dev tools (pytest, ruff, mypy)
source .venv/bin/activate
pip install -r requirements-dev.txt

# Run tests
pytest

# Lint
ruff check .

# Format check
ruff format --check .

# Type check
mypy bot/ main.py --ignore-missing-imports
```

## Runtime Verification Status

Verified on Linux (Python 3.11.2, `ffmpeg`/`ffprobe` installed, Redis stopped to exercise fail-open):

- **Initial test baseline**: `pytest` 115 passed (70% coverage), `ruff check`, `ruff format --check`, and `mypy` passed; live smoke tests confirmed Redis fail-open, async TTS synthesis, and `ffmpeg` MP3 concatenation.
- **Runtime defects found & fixed**:
  - `main.py`: Unhandled `InvalidToken` printed the raw `TELEGRAM_BOT_TOKEN` to `stderr` via Python traceback and bypassed lock release; now caught, logged cleanly, and always releases the lock.
  - `main.py` / `bot/config.py`: Import-time `int()` parsing of `BOT_WORKERS` / `CONCURRENT_UPDATES` and import-time `Path.home()` directory creation could crash on empty env vars or systemd `ProtectHome=true`; now parsed via `get_positive_int`, configurable via `STATE_DIR`, created lazily at startup, and verified with `--check`.
  - `bot/handlers.py`: Voice files were read fully into RAM before transcription; now streamed by file path directly into `transcribe()`.
  - `bot/worker.py`: Added bounded queue (`BOT_QUEUE_MAXSIZE`) with `QueueFull` load shedding, per-sentence TTS timeout (`TTS_TIMEOUT_SEC`), `ffmpeg -threads 1` + timeout kill (`FFMPEG_TIMEOUT_SEC`) + `Semaphore(1)`, `1.0s` edit throttle, and graceful shutdown drain (`15s`).
  - `bot/opencode_client.py`: Normalized trailing slashes in `ZEN_API_BASE` and built request headers dynamically.

## Deployment

For production on a 1 vCPU / 1.4 GiB host:

- Run as a system-level `systemd` unit (`/etc/systemd/system/telegram-voice-bot.service`)
  under a dedicated non-login user with `Restart=on-failure`, `TimeoutStopSec=20`,
  `MemoryHigh=256M`, and `MemoryMax=384M`.
- When enabling `ProtectHome=true`, set `STATE_DIR` and `TMP_DIR` to writable
  service paths (for example `/var/lib/telegram-voice-bot` and `/tmp/telegram-voice-bot`).
- Emit logs to `stdout`/`stderr` and manage retention via `systemd-journald`
  (`Storage=persistent`, `SystemMaxUse=100M`) instead of `logrotate`.
- Configure Redis with `maxmemory 64mb`, `maxmemory-policy allkeys-lru`, and
  disable RDB/AOF persistence (`save ""`, `appendonly no`) to eliminate `fork()`
  copy-on-write memory spikes (trade-off: daily quota counters reset if Redis restarts).

## Pending Changes

- `.github/workflows/ai-code-review.yml` hardcodes the AI review model ID.
  Once the `OPENCODE_REVIEW_MODEL` repository variable exists
  (**Settings → Secrets and variables → Actions → Variables**), switch the
  workflow to `${{ vars.OPENCODE_REVIEW_MODEL }}` so no model ID is hardcoded
  in the AI-review workflow or its documentation.

## License

MIT
