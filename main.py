import fcntl
import logging
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters

from bot import handlers
from bot.config import (
    ALLOWED_USER_IDS,
    BOT_WORKERS,
    CONCURRENT_UPDATES,
    REDIS_URL,
    TELEGRAM_BOT_TOKEN,
    TMP_DIR,
    WHISPER_API_KEY,
    WHISPER_URL,
    ZEN_API_KEY,
)
from bot.handlers import handle_text, handle_voice, start
from bot.http_client import close_client
from bot.redis_client import close_redis
from bot.worker import WorkerPool

LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


def _extract_url_secret(url: str) -> str | None:
    """Return embedded password from a URL, if any."""
    if not url:
        return None
    try:
        return urlsplit(url).password or None
    except ValueError:
        return None


class TokenRedactingFormatter(logging.Formatter):
    """Formatting layer that fully redacts secrets from all log output.

    Applied at the output handler/formatter level so that descendant logger
    records, mapping/non-string args, and formatted exception tracebacks are
    sanitized before being emitted to the stream.
    """

    def __init__(self, tokens: list[str], *args, **kwargs):
        kwargs.setdefault("fmt", LOG_FORMAT)
        super().__init__(*args, **kwargs)
        # Sort longest first so a shorter secret cannot partially corrupt a
        # longer secret containing it as a substring.
        self._tokens = sorted({t for t in tokens if t}, key=len, reverse=True)

    def format(self, record: logging.LogRecord) -> str:
        msg = super().format(record)
        for token in self._tokens:
            if token in msg:
                msg = msg.replace(token, "***REDACTED***")
        return msg


logging.basicConfig(
    level=logging.INFO,
    format=LOG_FORMAT,
    stream=sys.stdout,
)

# Apply token redaction at the output handler/formatter level so that
# descendant logger records and formatted exception tracebacks are sanitized
# before being emitted.
_secrets = [
    s
    for s in (
        TELEGRAM_BOT_TOKEN,
        ZEN_API_KEY,
        WHISPER_API_KEY,
        _extract_url_secret(REDIS_URL),
        _extract_url_secret(WHISPER_URL),
    )
    if s
]
if _secrets:
    _handler = logging.StreamHandler(sys.stdout)
    _handler.setFormatter(TokenRedactingFormatter(_secrets, fmt=LOG_FORMAT))
    _root = logging.getLogger()
    _root.handlers = [_handler]

logger = logging.getLogger(__name__)

_STATE_DIR = Path.home() / ".local" / "state" / "telegram-voice-bot"
LOCK_FILE = str(_STATE_DIR / "bot.lock")
_LOCK_FD: int | None = None


def _acquire_lock() -> None:
    global _LOCK_FD
    try:
        _STATE_DIR.mkdir(parents=True, exist_ok=True)
        fd = os.open(LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.ftruncate(fd, 0)
        os.write(fd, str(os.getpid()).encode())
        _LOCK_FD = fd
    except (OSError, BlockingIOError) as exc:
        logger.error("Failed to acquire lock: %s", exc)
        sys.exit(1)


def _release_lock() -> None:
    global _LOCK_FD
    try:
        if _LOCK_FD is not None:
            fcntl.flock(_LOCK_FD, fcntl.LOCK_UN)
            os.close(_LOCK_FD)
            _LOCK_FD = None
    except OSError:
        pass


async def post_init(application: Application) -> None:
    pool = WorkerPool(num_workers=BOT_WORKERS)
    await pool.start()
    handlers.worker_pool = pool
    logger.info(
        "Worker pool assigned (workers=%d, concurrent_updates=%d)",
        BOT_WORKERS,
        CONCURRENT_UPDATES,
    )


async def post_stop(application: Application) -> None:
    if handlers.worker_pool is not None:
        await handlers.worker_pool.stop()
        logger.info("Worker pool stopped")
    await close_client()
    await close_redis()
    logger.info("HTTP client closed")
    _release_lock()


def main() -> None:
    _acquire_lock()
    TMP_DIR.mkdir(parents=True, exist_ok=True)

    if not TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN == "your_token_here":
        logger.error("TELEGRAM_BOT_TOKEN is not set! Copy .env.example to .env.")
        _release_lock()
        sys.exit(1)

    if not ZEN_API_KEY:
        logger.error("ZEN_API_KEY is not set; the bot cannot generate replies.")
        _release_lock()
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

    app = (
        Application.builder()
        .token(TELEGRAM_BOT_TOKEN)
        .post_init(post_init)
        .post_stop(post_stop)
        .concurrent_updates(CONCURRENT_UPDATES)
        .build()
    )
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    app.add_handler(MessageHandler(filters.VOICE & ~filters.COMMAND, handle_voice))

    logger.info(
        "Starting bot polling (workers=%d, concurrent=%d)...",
        BOT_WORKERS,
        CONCURRENT_UPDATES,
    )
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
