# telegram-voice-bot

A low-resource Telegram voice bot with text chat, remote speech-to-text
transcription, TTS replies, and daily quota enforcement via Redis.

## Features

- **Text chat** — replies via an OpenAI-compatible LLM endpoint
- **Voice messages** — transcribed via a configurable Whisper-compatible STT endpoint,
  then the LLM response is synthesized with a configurable async TTS engine and sent back as MP3 audio
- **Short sentences spoken** — replies such as "好。" are not dropped by TTS
- **Daily quotas** — Redis Lua atomic counter with TTL, fail-open, `Asia/Taipei` timezone
- **Single-worker mode** — `BOT_WORKERS=1`, `CONCURRENT_UPDATES=1` for low-memory hosts
- **Voice file cap** — `MAX_VOICE_BYTES=10 MB`, downloaded to disk temp dir (not `BytesIO`)
- **TTS concurrency cap** — max 3 simultaneous TTS requests
- **ffmpeg concat** — re-encodes with `libmp3lame -q:a 4` for reliable MP3 output
- **Retry/backoff** — 429/5xx retry with `Retry-After` honouring for LLM and transcription
- **Generic user errors** — internal details never leaked to users

## Requirements

- Python 3.11+
- `ffmpeg` and `ffprobe` (≥ 5 recommended)
- Redis (for daily quotas only)
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
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `ALLOWED_USER_IDS` — comma-separated Telegram user IDs (empty = deny all)
- `ZEN_API_KEY` — LLM API key
- `WHISPER_API_KEY` — STT API key (or set `WHISPER_URL` for self-hosted)

Run:

```bash
./start.sh
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | (required) | Telegram bot token |
| `ALLOWED_USER_IDS` | (empty) | Comma-separated allowed user IDs; empty = deny all |
| `TTS_VOICE` | (see `.env.example`) | TTS voice ID |
| `ZEN_API_BASE` | (see `.env.example`) | LLM API base URL |
| `ZEN_MODEL` | (see `.env.example`) | LLM model name |
| `ZEN_API_KEY` | (required) | LLM API key |
| `WHISPER_API_BASE` | (see `.env.example`) | STT API base URL |
| `WHISPER_API_KEY` | (required) | STT API key |
| `WHISPER_MODEL` | (see `.env.example`) | STT model |
| `WHISPER_LANGUAGE` | `zh` | Transcription language hint |
| `WHISPER_URL` | (empty) | Self-hosted STT URL (overrides remote STT) |
| `REDIS_URL` | `redis://127.0.0.1:6379/0` | Redis for daily quotas |
| `DAILY_REQUEST_LIMIT` | `50` | Requests per user per day |
| `TIMEZONE` | `Asia/Taipei` | Timezone for daily quota reset |
| `MAX_VOICE_BYTES` | `10485760` | Max voice message size (10 MB) |
| `TMP_DIR` | `~/.cache/telegram-voice-bot/tmp` | Temp directory for voice/TTS files |
| `BOT_WORKERS` | `1` | Worker pool size (keep 1 on low RAM) |
| `CONCURRENT_UPDATES` | `1` | PTB concurrent updates (keep 1 on low RAM) |

## Architecture

```
main.py
  ├── post_init → WorkerPool (1 worker, TTS semaphore=3)
  ├── post_stop → close clients + release lock
  └── run_polling (concurrent_updates=1)

bot/handlers.py
  ├── start          — /command handler
  ├── handle_text    — text messages → WorkerPool
  └── handle_voice   — voice → download → Whisper → WorkerPool

bot/worker.py
  ├── Phase 1: LLM stream (SSE) → partial text + TTS sentence queueing
  ├── Phase 2: fallback to non-streaming chat() on stream failure
  └── Phase 3/4: TTS concat (ffmpeg) + final text delivery

bot/opencode_client.py
  ├── chat()         — non-streaming LLM with retry
  ├── chat_stream()  — SSE streaming, propagates transport errors
  └── tts()          — TTS synthesis

bot/whisper.py
  └── transcribe()   — Whisper-compatible STT with file streaming + retry

bot/redis_client.py
  └── check_daily_quota() — Lua INCR + EXPIRE, fail-open

bot/retry.py
  └── request_with_retry() — 429/5xx backoff, Retry-After support
```

## Security

- `.env` is never committed; keep permissions `600`
- API keys are redacted from logs via `TokenRedactingFormatter`
- Allowlist defaults to deny-all
- Voice files capped at 10 MB to prevent abuse
- Redis quota failures fail-open (bot stays up, but no quota enforcement during outage)

## Development

```bash
# Run tests
source .venv/bin/activate
pytest

# Lint
ruff check .

# Format check
ruff format --check .
```

## Deployment

For production on a 1 vCPU / 1.4 GiB host, consider:
- `systemd --user` unit with `MemoryMax=700M`
- Log rotation via `logrotate`
- Redis with memory limit (64 MB recommended)

## Pending Changes

- `.github/workflows/ai-code-review.yml` hardcodes the AI review model ID.
  Once the `OPENCODE_REVIEW_MODEL` repository variable exists
  (**Settings → Secrets and variables → Actions → Variables**), switch the
  workflow to `${{ vars.OPENCODE_REVIEW_MODEL }}` so no model ID stays in a
  public file.

## License

MIT
