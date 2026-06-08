from os import getenv
from dotenv import load_dotenv

load_dotenv()


def get(key: str, default: str = "") -> str:
    return getenv(key, default)


TELEGRAM_BOT_TOKEN = get("TELEGRAM_BOT_TOKEN")
NVIDIA_API_KEY = get("NVIDIA_API_KEY")
LLM_MODEL = get("LLM_MODEL", "nvidia/nemotron-3-super-120b-a12b")
LLM_BASE = get("LLM_BASE", "https://integrate.api.nvidia.com/v1")
TTS_VOICE = get("TTS_VOICE", "zh-CN-XiaoxiaoNeural")
WHISPER_URL = get("WHISPER_URL", "http://127.0.0.1:12017")
SYSTEM_PROMPT = get(
    "SYSTEM_PROMPT",
    "You are a helpful AI assistant. Respond concisely in Traditional Chinese (zh-TW).",
)
ALLOWED_USER_IDS: list[int] = [
    int(x.strip()) for x in get("ALLOWED_USER_IDS", "").split(",") if x.strip()
]
