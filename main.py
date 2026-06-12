import logging
import os
import sys

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters

from bot import handlers
from bot.config import TELEGRAM_BOT_TOKEN
from bot.handlers import handle_text, handle_voice, start
from bot.opencode_client import close_client
from bot.worker import WorkerPool

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)

logger = logging.getLogger(__name__)

LOCK_FILE = "/tmp/telegram-voice-bot.lock"


def _aquire_lock() -> None:
    try:
        if os.path.exists(LOCK_FILE):
            with open(LOCK_FILE) as f:
                old_pid = int(f.read().strip())
            if os.path.exists(f"/proc/{old_pid}"):
                logger.error("Another instance (PID %d) is already running", old_pid)
                sys.exit(1)
            logger.warning("Stale lock file found (PID %d not running), overwriting", old_pid)
        with open(LOCK_FILE, "w") as f:
            f.write(str(os.getpid()))
    except (OSError, ValueError) as exc:
        logger.error("Failed to acquire lock: %s", exc)
        sys.exit(1)


def _release_lock() -> None:
    try:
        if os.path.exists(LOCK_FILE):
            with open(LOCK_FILE) as f:
                pid = int(f.read().strip())
            if pid == os.getpid():
                os.unlink(LOCK_FILE)
    except (OSError, ValueError):
        pass


class TokenFilter(logging.Filter):
    def __init__(self, token: str):
        super().__init__()
        self._token = token
        self._replacement = f"***{token[:4]}...{token[-4:]}***" if len(token) > 8 else "***"

    def filter(self, record):
        msg = record.msg if isinstance(record.msg, str) else str(record.msg)
        if self._token in msg:
            record.msg = msg.replace(self._token, self._replacement)
        if record.args:
            filtered = []
            for a in record.args:
                if isinstance(a, str):
                    filtered.append(a.replace(self._token, self._replacement))
                else:
                    s = str(a)
                    filtered.append(s.replace(self._token, self._replacement) if self._token in s else a)
            record.args = tuple(filtered)
        return True

NUM_WORKERS = int(os.getenv("BOT_WORKERS", "5"))
CONCURRENT_UPDATES = int(os.getenv("CONCURRENT_UPDATES", "8"))


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
    logger.info("HTTP client closed")
    _release_lock()


def main() -> None:
    _aquire_lock()

    for name in ("httpx", "httpcore", "telegram"):
        logging.getLogger(name).addFilter(TokenFilter(TELEGRAM_BOT_TOKEN))

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
