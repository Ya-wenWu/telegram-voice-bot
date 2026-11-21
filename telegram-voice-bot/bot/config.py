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


def get_positive_int(key: str, default: int) -> int:
    """Parse an integer env var, falling back to *default* when missing, invalid, or <= 0."""
    value = get_int(key, default)
    return value if value >= 1 else default


load_dotenv()

HOME = Path.home()
TIMEZONE = get("TIMEZONE", "Asia/Taipei")

TELEGRAM_BOT_TOKEN = get("TELEGRAM_BOT_TOKEN")

# Pluggable TTS configuration (Issue #25: edge | openai | piper)
TTS_PROVIDER = get("TTS_PROVIDER", "edge")
TTS_VOICE = get("TTS_VOICE", "zh-CN-XiaoxiaoNeural")
TTS_API_BASE = get("TTS_API_BASE", "https://api.openai.com/v1")
TTS_API_KEY = get("TTS_API_KEY", "")
TTS_MODEL = get("TTS_MODEL", "tts-1")
PIPER_BIN = get("PIPER_BIN", "piper")
PIPER_MODEL_PATH = get("PIPER_MODEL_PATH", "")

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
MAX_VOICE_BYTES = get_positive_int("MAX_VOICE_BYTES", 10 * 1024 * 1024)
TMP_DIR = Path(
    get("TMP_DIR", str(HOME / ".cache" / "telegram-voice-bot" / "tmp"))
    or str(HOME / ".cache" / "telegram-voice-bot" / "tmp")
).expanduser()
STATE_DIR = Path(
    get("STATE_DIR", str(HOME / ".local" / "state" / "telegram-voice-bot"))
    or str(HOME / ".local" / "state" / "telegram-voice-bot")
).expanduser()

BOT_WORKERS = get_positive_int("BOT_WORKERS", 1)
CONCURRENT_UPDATES = get_positive_int("CONCURRENT_UPDATES", 1)
BOT_QUEUE_MAXSIZE = get_positive_int("BOT_QUEUE_MAXSIZE", 10)
TTS_TIMEOUT_SEC = get_positive_int("TTS_TIMEOUT_SEC", 15)
FFMPEG_TIMEOUT_SEC = get_positive_int("FFMPEG_TIMEOUT_SEC", 30)

# Conversation memory bounds (Issue #26; 0 disables multi-turn memory)
CONVERSATION_MAX_TURNS = max(0, get_int("CONVERSATION_MAX_TURNS", 6))
CONVERSATION_TTL_SEC = get_positive_int("CONVERSATION_TTL_SEC", 3600)

# Redis is used only for durable daily quotas; failures fail open.
REDIS_URL = get("REDIS_URL", "redis://127.0.0.1:6379/0")
DAILY_REQUEST_LIMIT = get_int("DAILY_REQUEST_LIMIT", 50)

ZEN_API_BASE = get("ZEN_API_BASE", "https://opencode.ai/inference/openai/v1")
ZEN_MODEL = get("ZEN_MODEL", "deepseek-v4.1-flash-free")
ZEN_MAX_TOKENS = max(0, get_int("ZEN_MAX_TOKENS", 1024))
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
