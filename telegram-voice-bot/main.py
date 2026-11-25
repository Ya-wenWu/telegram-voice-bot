import argparse
import asyncio
import logging
import os
import shutil
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

fcntl: Any
msvcrt: Any
try:
    import fcntl as _fcntl

    fcntl = _fcntl
except ImportError:  # pragma: no cover - Windows compatibility
    fcntl = None

try:
    import msvcrt as _msvcrt

    msvcrt = _msvcrt
except ImportError:  # pragma: no cover - POSIX compatibility
    msvcrt = None

from telegram import Update
from telegram.error import InvalidToken, TelegramError
from telegram.ext import Application, CommandHandler, MessageHandler, filters

from bot import handlers
from bot.config import (
    ACTIVE_DEPLOYMENT_PROFILE,
    ALLOWED_USER_IDS,
    BOT_QUEUE_MAXSIZE,
    BOT_WORKERS,
    CONCURRENT_UPDATES,
    MAX_BOT_INSTANCES,
    METRICS_HOST,
    METRICS_PORT,
    OTEL_ENABLED,
    OTEL_SERVICE_NAME,
    REDIS_URL,
    STATE_DIR,
    TELEGRAM_BOT_TOKEN,
    TMP_DIR,
    TTS_API_KEY,
    WHISPER_API_KEY,
    WHISPER_URL,
    ZEN_API_KEY,
)
from bot.config import (
    LOG_FORMAT as CONFIG_LOG_FORMAT,
)
from bot.handlers import handle_text, handle_voice, reset_memory, start, verify_human
from bot.http_client import close_client
from bot.logging_context import RequestIdFilter
from bot.multi_bot import MultiBotManager, load_bot_registry
from bot.observability import (
    JsonTokenRedactingFormatter,
    ObservabilityServer,
    configure_otel_tracing,
)
from bot.redis_client import close_redis
from bot.worker import WorkerPool

LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: [req=%(req_id)s] %(message)s"
MIN_SECRET_LEN = 6


def _extract_url_secret(url: str | None) -> str | None:
    """Return embedded password from a URL, if any."""
    if not url:
        return None
    try:
        return urlsplit(url).password or None
    except ValueError:
        return None


class TokenRedactingFormatter(logging.Formatter):
    """Formatting layer that fully redacts secrets from all log output."""

    def __init__(self, tokens: list[str], *args, **kwargs):
        kwargs.setdefault("fmt", LOG_FORMAT)
        super().__init__(*args, **kwargs)
        self._tokens = sorted(
            {t for t in tokens if t and len(t) >= MIN_SECRET_LEN},
            key=len,
            reverse=True,
        )

    def format(self, record: logging.LogRecord) -> str:
        if not hasattr(record, "req_id"):
            record.req_id = "-"
        msg = super().format(record)
        for token in self._tokens:
            if token in msg:
                msg = msg.replace(token, "***REDACTED***")
        return msg


_req_id_filter = RequestIdFilter()
_configured_bots = load_bot_registry(ACTIVE_DEPLOYMENT_PROFILE)
_secrets = [
    s
    for s in (
        TELEGRAM_BOT_TOKEN,
        *(b.token for b in _configured_bots),
        ZEN_API_KEY,
        WHISPER_API_KEY,
        TTS_API_KEY,
        _extract_url_secret(REDIS_URL),
        _extract_url_secret(WHISPER_URL),
    )
    if s
]
_handler = logging.StreamHandler(sys.stdout)
_handler.addFilter(_req_id_filter)
if CONFIG_LOG_FORMAT == "text":
    if _secrets:
        _handler.setFormatter(TokenRedactingFormatter(_secrets, fmt=LOG_FORMAT))
    else:
        _handler.setFormatter(logging.Formatter(LOG_FORMAT))
else:
    _handler.setFormatter(JsonTokenRedactingFormatter(_secrets))

_root = logging.getLogger()
_root.setLevel(logging.INFO)
_root.handlers = [_handler]

logger = logging.getLogger(__name__)

_STATE_DIR = STATE_DIR
LOCK_FILE = str(_STATE_DIR / "bot.lock")
_LOCK_FD = None
DRAIN_TIMEOUT_SEC = 15.0


def _ensure_runtime_dirs() -> None:
    """Create state and temp directories when starting up (not at import time)."""
    Path(LOCK_FILE).parent.mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(parents=True, exist_ok=True)


def _cleanup_stale_tmp_files() -> int:
    """Remove leftover temp voice/concat artifacts from previous runs."""
    if not TMP_DIR.exists():
        return 0
    removed = 0
    for entry in TMP_DIR.iterdir():
        try:
            if entry.is_dir() and entry.name.startswith("tts_concat_"):
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
            elif entry.is_file() and entry.suffix == ".ogg":
                entry.unlink(missing_ok=True)
                removed += 1
        except OSError:
            logger.debug("Skipping cleanup of %s", entry, exc_info=True)
    return removed


def _acquire_lock() -> None:
    global _LOCK_FD
    fd: int | None = None
    try:
        _ensure_runtime_dirs()
        fd = os.open(LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o600)
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        elif msvcrt is not None:  # pragma: no cover - Windows compatibility
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        os.ftruncate(fd, 0)
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, str(os.getpid()).encode())
        _LOCK_FD = fd
    except (OSError, BlockingIOError) as exc:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        logger.error("Failed to acquire lock: %s", exc)
        sys.exit(1)


def _release_lock() -> None:
    global _LOCK_FD
    try:
        if _LOCK_FD is not None:
            if fcntl is not None:
                fcntl.flock(_LOCK_FD, fcntl.LOCK_UN)
            elif msvcrt is not None:  # pragma: no cover - Windows compatibility
                os.lseek(_LOCK_FD, 0, os.SEEK_SET)
                msvcrt.locking(_LOCK_FD, msvcrt.LK_UNLCK, 1)
            os.close(_LOCK_FD)
            _LOCK_FD = None
    except OSError:
        _LOCK_FD = None


NUM_WORKERS = BOT_WORKERS
_observability_server: ObservabilityServer | None = None


def check_readiness() -> tuple[bool, dict[str, Any]]:
    """Aggregate readiness checks for /ready probes."""
    pool = handlers.worker_pool
    if pool is None:
        return False, {"worker_pool": "uninitialized"}
    pool_ready, details = pool.is_ready()
    return pool_ready, {"worker_pool": details}


async def post_init(application: Application) -> None:
    global _observability_server
    configure_otel_tracing(OTEL_SERVICE_NAME, OTEL_ENABLED)
    cleaned = _cleanup_stale_tmp_files()
    if cleaned:
        logger.info("Cleaned %d stale temp item(s) in %s", cleaned, TMP_DIR)
    pool = WorkerPool(num_workers=NUM_WORKERS, max_queue_size=BOT_QUEUE_MAXSIZE)
    await pool.start()
    handlers.worker_pool = pool
    if METRICS_PORT > 0:
        _observability_server = ObservabilityServer(
            host=METRICS_HOST,
            port=METRICS_PORT,
            readiness_check=check_readiness,
            service_name=OTEL_SERVICE_NAME,
        )
        await _observability_server.start()
    logger.info(
        "Worker pool assigned (workers=%d, concurrent_updates=%d, queue_maxsize=%d)",
        NUM_WORKERS,
        CONCURRENT_UPDATES,
        BOT_QUEUE_MAXSIZE,
    )


async def post_stop(application: Application) -> None:
    global _observability_server
    if _observability_server is not None:
        await _observability_server.stop()
        _observability_server = None
    if handlers.worker_pool is not None:
        await handlers.worker_pool.stop(drain_timeout=DRAIN_TIMEOUT_SEC)
        logger.info("Worker pool stopped")
    await close_client()
    await close_redis()
    logger.info("HTTP client closed")
    _release_lock()


def run_preflight_check() -> int:
    """Validate runtime configuration and system dependencies without polling."""
    errors: list[str] = []
    warnings: list[str] = []
    bots = load_bot_registry(ACTIVE_DEPLOYMENT_PROFILE)

    if not bots and (not TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN == "your_token_here"):
        errors.append("TELEGRAM_BOT_TOKEN is missing or still set to the placeholder.")
    if not ZEN_API_KEY:
        errors.append("ZEN_API_KEY is missing; LLM replies cannot be generated.")
    if not ALLOWED_USER_IDS:
        warnings.append("ALLOWED_USER_IDS is empty (default-deny: all users rejected).")
    if not WHISPER_URL and not WHISPER_API_KEY:
        warnings.append(
            "Neither WHISPER_API_KEY nor WHISPER_URL is set (voice STT disabled)."
        )
    if shutil.which("ffmpeg") is None:
        warnings.append(
            "ffmpeg not found on PATH (multi-sentence MP3 concat disabled)."
        )

    try:
        _ensure_runtime_dirs()
    except OSError as exc:
        errors.append(f"Cannot create runtime directories: {exc}")

    for msg in warnings:
        logger.warning("Preflight warning: %s", msg)
    for msg in errors:
        logger.error("Preflight error: %s", msg)

    if errors:
        logger.error("Preflight check FAILED (%d error(s)).", len(errors))
        return 1

    logger.info(
        "Preflight check PASSED (profile=%s, ram_mb=%d, cpu=%d, bots=%d/%d, workers=%d, concurrent=%d, queue_maxsize=%d).",
        ACTIVE_DEPLOYMENT_PROFILE.mode,
        ACTIVE_DEPLOYMENT_PROFILE.resources.effective_available_ram_mb,
        ACTIVE_DEPLOYMENT_PROFILE.resources.effective_cpu_cores,
        len(bots),
        MAX_BOT_INSTANCES,
        NUM_WORKERS,
        CONCURRENT_UPDATES,
        BOT_QUEUE_MAXSIZE,
    )
    return 0


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="telegram-voice-bot")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate configuration and local dependencies without starting polling.",
    )
    args = parser.parse_args(argv)
    if args.check:
        sys.exit(run_preflight_check())

    _acquire_lock()
    try:
        bots = load_bot_registry(ACTIVE_DEPLOYMENT_PROFILE)
        if not bots and (
            not TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN == "your_token_here"
        ):
            logger.error("TELEGRAM_BOT_TOKEN is not set! Copy .env.example to .env.")
            sys.exit(1)

        if not ZEN_API_KEY:
            logger.error("ZEN_API_KEY is not set; the bot cannot generate replies.")
            sys.exit(1)

        if not ALLOWED_USER_IDS:
            logger.warning(
                "ALLOWED_USER_IDS is empty: every user will be rejected. "
                "Set it to your Telegram user ID(s) in .env."
            )

        if not WHISPER_URL and not WHISPER_API_KEY:
            logger.warning(
                "Neither WHISPER_API_KEY nor WHISPER_URL is set: voice messages "
                "will fail to transcribe (text chat still works)."
            )

        logger.info(
            "Adaptive deployment profile=%s (%s, effective_ram=%dMB, effective_cpu=%d, active_bots=%d/%d)",
            ACTIVE_DEPLOYMENT_PROFILE.mode,
            ACTIVE_DEPLOYMENT_PROFILE.tier,
            ACTIVE_DEPLOYMENT_PROFILE.resources.effective_available_ram_mb,
            ACTIVE_DEPLOYMENT_PROFILE.resources.effective_cpu_cores,
            len(bots) or 1,
            MAX_BOT_INSTANCES,
        )

        # Multi-bot high-concurrency path (only reachable when > 1 GB RAM and >= 2 bots configured)
        if (
            ACTIVE_DEPLOYMENT_PROFILE.mode == "high_concurrency"
            and len(bots) >= 2
        ):
            manager = MultiBotManager(
                bots,
                profile=ACTIVE_DEPLOYMENT_PROFILE,
                num_workers=NUM_WORKERS,
                max_queue_size=BOT_QUEUE_MAXSIZE,
                concurrent_updates=CONCURRENT_UPDATES,
            )
            logger.info(
                "Starting MultiBotManager for %d bots (%s) sharing %d high-concurrency workers...",
                len(bots),
                ", ".join(manager.bot_ids),
                NUM_WORKERS,
            )
            asyncio.run(manager.run_polling(drain_timeout=DRAIN_TIMEOUT_SEC))
            return

        single_token = bots[0].token if bots else TELEGRAM_BOT_TOKEN
        app = (
            Application.builder()
            .token(single_token)
            .post_init(post_init)
            .post_stop(post_stop)
            .concurrent_updates(CONCURRENT_UPDATES)
            .build()
        )
        app.add_handler(CommandHandler("start", start))
        app.add_handler(CommandHandler("reset", reset_memory))
        app.add_handler(CommandHandler("verify", verify_human))
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
        app.add_handler(MessageHandler(filters.VOICE & ~filters.COMMAND, handle_voice))

        logger.info(
            "Starting single-bot polling (profile=%s, workers=%d, concurrent=%d)...",
            ACTIVE_DEPLOYMENT_PROFILE.mode,
            NUM_WORKERS,
            CONCURRENT_UPDATES,
        )
        app.run_polling(allowed_updates=Update.ALL_TYPES)
    except InvalidToken:
        logger.error(
            "TELEGRAM_BOT_TOKEN was rejected by Telegram. Verify the token in .env."
        )
        sys.exit(1)
    except TelegramError as exc:
        logger.error("Telegram API error during polling: %s", exc)
        sys.exit(1)
    finally:
        _release_lock()


if __name__ == "__main__":
    main()
