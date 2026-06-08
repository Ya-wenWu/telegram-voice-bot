import logging
import sys

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters

from bot.config import TELEGRAM_BOT_TOKEN
from bot.handlers import handle_text, handle_voice, start

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)

logger = logging.getLogger(__name__)


def main() -> None:
    if not TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN == "your_token_here":
        logger.error("TELEGRAM_BOT_TOKEN is not set!")
        sys.exit(1)

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    app.add_handler(MessageHandler(filters.VOICE & ~filters.COMMAND, handle_voice))

    logger.info("Starting bot polling...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
