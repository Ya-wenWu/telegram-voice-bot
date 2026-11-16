import fcntl
import logging
import os
import sys
from pathlib import Path

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters

from bot import handlers
from bot.config import TELEGRAM_BOT_TOKEN, TMP_DIR, WHISPER_API_KEY, ZEN_API_KEY
from bot.handlers import handle_text, handle_voice, start
from bot.http_client import close_client
from bot.redis_client import close_redis
from bot.worker import WorkerPool

LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


class TokenRedactingFormatter(logging.Formatter):
    """Formatting layer that redacts secrets from all log output.

    Applied at the output handler/formatter level so that descendant logger
    records and formatted exception tracebacks are sanitized before being
    emitted to the stream.
    """

    def __init__(self, tokens: list[str], *args, **kwargs):
        kwargs.setdefault("fmt", LOG_FORMAT)
        super().__init__(*args, **kwargs)
        self._tokens = [t for t in tokens if t]

    def format(self, record: logging.LogRecord) -> str:
        msg = super().format(record)
        for token in self._tokens:
            if token and token in msg:
                replacement = (
                    f"***{token[:4]}...{token[-4:]}***" if len(token) > 20 else "***"
                )
                msg = msg.replace(token, replacement)
        return msg


logging.basicConfig(
    level=logging.INFO,
    format=LOG_FORMAT,
    stream=sys.stdout,
)

# Apply token redaction at the output handler/formatter level so that
# descendant logger records and formatted exception tracebacks are sanitized
# before being emitted.
_secrets = [s for s in (TELEGRAM_BOT_TOKEN, ZEN_API_KEY, WHISPER_API_KEY) if s]
if _secrets:
    _handler = logging.StreamHandler(sys.stdout)
    _handler.setFormatter(TokenRedactingFormatter(_secrets, fmt=LOG_FORMAT))
    _root = logging.getLogger()
    _root.handlers = [_handler]

logger = logging.getLogger(__name__)

_STATE_DIR = Path.home() / ".local" / "state" / "telegram-voice-bot"
_STATE_DIR.mkdir(parents=True, exist_ok=True)
TMP_DIR.mkdir(parents=True, exist_ok=True)
LOCK_FILE = str(_STATE_DIR / "bot.lock")
_LOCK_FD = None


def _acquire_lock() -> None:
    global _LOCK_FD
    try:
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


class TokenFilter(logging.Filter):
    def __init__(self, token: str):
        super().__init__()
        self._token = token
        self._replacement = (
            f"***{token[:4]}...{token[-4:]}***" if len(token) > 20 else "***"
        )

    def _mask(self, value: object) -> object:
        if isinstance(value, str):
            return (
                value.replace(self._token, self._replacement)
                if self._token in value
                else value
            )
        # Redact string representation of non-string args (e.g. HTTP URL objects)
        # so tokens embedded in request URLs cannot bypass masking.
        return (
            str(value).replace(self._token, self._replacement)
            if self._token in str(value)
            else str(value)
        )

    def filter(self, record):
        msg = record.msg if isinstance(record.msg, str) else str(record.msg)
        if self._token in msg:
            record.msg = msg.replace(self._token, self._replacement)
        if record.args:
            if isinstance(record.args, dict):
                # dict-style (mapping) args must stay a dict for % formatting.
                record.args = {k: self._mask(v) for k, v in record.args.items()}
            else:
                record.args = tuple(self._mask(a) for a in record.args)
        return True


NUM_WORKERS = int(os.getenv("BOT_WORKERS", "1"))
CONCURRENT_UPDATES = int(os.getenv("CONCURRENT_UPDATES", "1"))


async def post_init(application: Application) -> None:
    pool = WorkerPool(num_workers=NUM_WORKERS)
    await pool.start()
    handlers.worker_pool = pool
    logger.info(
        "Worker pool assigned (workers=%d, concurrent_updates=%d)",
        NUM_WORKERS,
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

    if not TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN == "your_token_here":
        logger.error("TELEGRAM_BOT_TOKEN is not set!")
        _release_lock()
        sys.exit(1)

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
        NUM_WORKERS,
        CONCURRENT_UPDATES,
    )
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
