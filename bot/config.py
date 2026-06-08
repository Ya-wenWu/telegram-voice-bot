from os import getenv
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def get(key: str, default: str = "") -> str:
    return getenv(key, default)


HOME = Path.home()
AGENTS_MD = HOME / "AGENTS.md"
MEMORY_MD = HOME / "memory_compact.md"

TELEGRAM_BOT_TOKEN = get("TELEGRAM_BOT_TOKEN")
NVIDIA_API_KEY = get("NVIDIA_API_KEY")
LLM_MODEL = get("LLM_MODEL", "nvidia/nemotron-3-super-120b-a12b")
LLM_BASE = get("LLM_BASE", "https://integrate.api.nvidia.com/v1")
TTS_VOICE = get("TTS_VOICE", "zh-CN-XiaoxiaoNeural")
WHISPER_URL = get("WHISPER_URL", "http://127.0.0.1:12017")
ALLOWED_USER_IDS: list[int] = [
    int(x.strip()) for x in get("ALLOWED_USER_IDS", "").split(",") if x.strip()
]


def build_system_prompt() -> str:
    parts = [
        "You are the OpenCode AI assistant having a conversation via Telegram.",
        "You are an AI coding assistant helping a C# .NET learner.",
        "Respond in Traditional Chinese (zh-TW) unless the user speaks otherwise.",
        "Be concise and helpful.",
    ]
    return "\n".join(parts)
