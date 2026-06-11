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


def main() -> None:
    if not TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN == "your_token_here":
        logger.error("TELEGRAM_BOT_TOKEN is not set!")
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
