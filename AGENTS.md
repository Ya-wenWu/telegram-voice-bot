# AGENTS.md — telegram-voice-bot

## Commands

```bash
.venv/bin/python -m pytest -q                              # tests
.venv/bin/ruff check .                                     # lint
.venv/bin/ruff format --check .                            # format check
.venv/bin/mypy bot/ main.py --ignore-missing-imports       # types
./start.sh                                                 # run (needs .env)
```

Never run `./start.sh` with the production bot token while the deployed
instance is polling — Telegram allows a single `getUpdates` consumer, so the
second process causes a 409 conflict and the deployed bot stops receiving.

## Structure

| Path | Responsibility |
|---|---|
| `main.py` | Entrypoint: logging/secret redaction, PID lock, PTB app, `post_init`/`post_stop` |
| `bot/config.py` | Environment configuration — **source of truth for defaults** |
| `bot/handlers.py` | `/start`, text and voice handlers (whitelist, quota, download) |
| `bot/worker.py` | Worker pool, streaming pipeline, `_scan_sentences`, TTS caps |
| `bot/opencode_client.py` | LLM chat/stream and TTS |
| `bot/whisper.py` | Speech-to-text (remote OpenAI-compatible endpoint, or `WHISPER_URL`) |
| `bot/http_client.py` | Shared `httpx.AsyncClient` lifecycle |
| `bot/retry.py` | 429/5xx exponential backoff with `Retry-After` |
| `bot/redis_client.py` | Daily quota counter (fails open) |

## Conventions

- Defaults live in `bot/config.py`; `.env` overrides them. `.env.example` is a
  template only — no real keys or model IDs.
- README must not hardcode provider or model names (see issue #27).
- `VERSION_UPDATE.md` is append-only: never rewrite past rows, add a new one.
- Secrets must never be logged raw; masking happens in the output formatter.
- Tests must not hit the network — keep HTTP mocked.
- Never commit `.env*`.

## Known debt (see issue #24)

- `bot/worker.py::_scan_sentences` is O(n²) on the event loop.
- `main.py::TokenFilter` is dead code kept only for tests.
- CI actions are not all pinned to commit SHAs.
