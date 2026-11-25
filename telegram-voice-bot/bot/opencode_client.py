import json
import logging
import re

import httpx

import bot.http_client
from bot.config import (
    ZEN_API_BASE,
    ZEN_API_KEY,
    ZEN_MAX_TOKENS,
    ZEN_MODEL,
    build_system_prompt,
)
from bot.retry import request_with_retry
from bot.tts_provider import get_tts_provider

logger = logging.getLogger(__name__)

MAX_TEXT_LEN = 8000

_INVISIBLE_CHARS_RE = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]")
_PROMPT_INJECTION_RE = re.compile(
    r"(?i)"
    r"\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+)?"
    r"(?:previous|prior|above|earlier|original|system|safety)\s+"
    r"(?:instructions?|prompts?|rules?|directives?|constraints?)\b"
    r"|\b(?:reveal|show|print|dump|leak|output|repeat)\s+(?:me\s+)?(?:your\s+|the\s+)?"
    r"(?:exact\s+|full\s+|original\s+|hidden\s+)?(?:system\s+prompt|system\s+instructions?)\b"
    r"|(?:<\|im_start\|>|<\|system\|>|<<SYS>>|\[SYSTEM(?:\s+OVERRIDE|\s+PROMPT)?\])"
    r"|(?:忽略|無視|无视|忘記|忘记|覆蓋|覆盖)(?:以上|先前|之前|所有|全部)(?:的)?(?:所有|全部)?(?:系統|系统)?(?:指令|規則|规则|設定|设定|提示詞|提示词|限制)"
    r"|(?:進入|进入|開啟|开启)(?:開發者模式|开发者模式|越獄模式|越狱模式|無限制模式|无限制模式)"
    r"|(?:顯示|显示|輸出|输出|告訴我|告诉我|印出|打印|揭露)(?:你|系統|系统)?(?:的)?(?:完整|原始)?(?:系統提示詞|系统提示词|系統指令|系统指令|system\s*prompt)"
)


def sanitize_user_text(text: str, max_len: int = MAX_TEXT_LEN) -> str:
    """Strip invisible zero-width/bidi smuggling characters and enforce length cap."""
    cleaned = _INVISIBLE_CHARS_RE.sub("", text or "").strip()
    return cleaned[:max_len]


def is_prompt_injection(text: str) -> bool:
    """Detect high-confidence prompt-injection or system-prompt extraction attempts."""
    return bool(_PROMPT_INJECTION_RE.search(sanitize_user_text(text)))


def _endpoint() -> str:
    return f"{ZEN_API_BASE.rstrip('/')}/chat/completions"


def _headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if ZEN_API_KEY:
        headers["Authorization"] = f"Bearer {ZEN_API_KEY}"
    return headers


def _messages(
    text: str,
    history: list[dict[str, str]] | None = None,
) -> list[dict[str, str]]:
    msgs: list[dict[str, str]] = [{"role": "system", "content": build_system_prompt()}]
    if history:
        msgs.extend(history)
    msgs.append({"role": "user", "content": sanitize_user_text(text)})
    return msgs


async def chat(
    chat_id: int,
    text: str,
    *,
    history: list[dict[str, str]] | None = None,
) -> str:
    body: dict[str, object] = {
        "model": ZEN_MODEL,
        "messages": _messages(text, history),
    }
    if ZEN_MAX_TOKENS > 0:
        body["max_tokens"] = ZEN_MAX_TOKENS

    async def _send() -> httpx.Response:
        return await bot.http_client.get_client().post(
            _endpoint(),
            json=body,
            headers=_headers(),
        )

    resp = await request_with_retry(_send, label="LLM request")
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


async def chat_stream(
    chat_id: int,
    text: str,
    *,
    history: list[dict[str, str]] | None = None,
):
    """Stream LLM response token by token via SSE."""
    body: dict[str, object] = {
        "model": ZEN_MODEL,
        "messages": _messages(text, history),
        "stream": True,
    }
    if ZEN_MAX_TOKENS > 0:
        body["max_tokens"] = ZEN_MAX_TOKENS

    client = bot.http_client.get_client()
    async with client.stream(
        "POST",
        _endpoint(),
        json=body,
        headers=_headers(),
    ) as resp:
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if not line.startswith("data:"):
                continue
            payload = line[5:].lstrip()
            if payload == "[DONE]":
                break
            try:
                chunk = json.loads(payload)
            except json.JSONDecodeError:
                continue
            # Some providers emit a final usage-only chunk with "choices": [].
            choices = chunk.get("choices") or [{}]
            delta = choices[0].get("delta") or {}
            content = delta.get("content")
            if content:
                yield content


async def tts(text: str) -> bytes:
    """Synthesize speech via the configured TTSProvider."""
    return await get_tts_provider().synthesize(text)
