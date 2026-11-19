import logging
from os import getenv
from pathlib import Path

from dotenv import load_dotenv


def get(key: str, default: str = "") -> str:
    return getenv(key, default)


def get_int(key: str, default: int) -> int:
    try:
        return int(getenv(key, str(default)))
    except ValueError:
        return default


load_dotenv()


HOME = Path.home()
TIMEZONE = get("TIMEZONE", "Asia/Taipei")

TELEGRAM_BOT_TOKEN = get("TELEGRAM_BOT_TOKEN")
TTS_VOICE = get("TTS_VOICE", "zh-CN-XiaoxiaoNeural")
# Remote transcription (OpenAI-compatible). Groq free tier by default.
# Set WHISPER_URL to use a self-hosted server instead (no API key required).
WHISPER_URL = get("WHISPER_URL", "")
WHISPER_API_BASE = get("WHISPER_API_BASE", "https://api.groq.com/openai/v1")
WHISPER_API_KEY = get("WHISPER_API_KEY", "")
WHISPER_MODEL = get("WHISPER_MODEL", "whisper-large-v3-turbo")
# Empty means auto-detect; set e.g. "zh" to force a language.
WHISPER_LANGUAGE = get("WHISPER_LANGUAGE", "zh")


def _parse_user_ids(raw: str) -> list[int]:
    """Parse a comma-separated list of Telegram user IDs.

    Non-numeric entries are skipped instead of crashing the bot at import time;
    a skipped entry can only reduce access (default-deny stays intact).
    """
    ids: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ids.append(int(part))
        except ValueError:
            logging.getLogger(__name__).warning(
                "Ignoring invalid ALLOWED_USER_IDS entry: %r", part
            )
    return ids


ALLOWED_USER_IDS: list[int] = _parse_user_ids(get("ALLOWED_USER_IDS", ""))

# Resource guards (tuned for a 1 vCPU / 1.4 GiB host)
MAX_VOICE_BYTES = get_int("MAX_VOICE_BYTES", 10 * 1024 * 1024)
TMP_DIR = Path(get("TMP_DIR", str(HOME / ".cache" / "telegram-voice-bot" / "tmp")))

# Redis is used only for durable daily quotas; failures fail open.
REDIS_URL = get("REDIS_URL", "redis://127.0.0.1:6379/0")
DAILY_REQUEST_LIMIT = get_int("DAILY_REQUEST_LIMIT", 50)

ZEN_API_BASE = get("ZEN_API_BASE", "https://opencode.ai/inference/openai/v1")
ZEN_MODEL = get("ZEN_MODEL", "deepseek-v4.1-flash-free")
# Require explicit configuration; do not read other apps' credential stores.
ZEN_API_KEY: str = get("ZEN_API_KEY", "")


def build_system_prompt() -> str:
    parts = [
        "You are the OpenCode AI assistant having a conversation via Telegram.",
        "You are an AI coding assistant helping a C# .NET learner.",
        "Respond in Traditional Chinese (zh-TW) unless the user speaks otherwise.",
        "Be concise and helpful.",
    ]
    return "\n".join(parts)
