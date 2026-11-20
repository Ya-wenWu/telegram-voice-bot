#!/usr/bin/env python3
"""Bridge script invoking the real telegram-voice-bot Python modules for Web Voice Bot."""

import asyncio
import base64
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# Ensure UTF-8 stdio on Windows (prevents cp950/gbk Unicode errors over Node pipes)
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _resolve_bot_repo() -> Path:
    env_dir = os.environ.get("BOT_REPO_DIR")
    if env_dir:
        return Path(env_dir)
    local_dir = Path(__file__).resolve().parent / "telegram-voice-bot"
    if local_dir.is_dir():
        return local_dir
    return Path("/tmp/telegram-voice-bot")


BOT_REPO = _resolve_bot_repo()
STATE_FILE = Path(
    os.environ.get(
        "BOT_STATE_FILE",
        str(Path(tempfile.gettempdir()) / "telegram-voice-bot-live-state.json"),
    )
)

sys.path.insert(0, str(BOT_REPO))

from bot.logging_context import RequestIdFilter, req_id_var  # noqa: E402
from bot.memory import ConversationStore  # noqa: E402
from bot.redis_client import check_daily_quota, close_redis  # noqa: E402
from bot.tts_provider import get_tts_provider  # noqa: E402
from bot.worker import (  # noqa: E402
    TTS_MAX_CHARS,
    TTS_MAX_SENTENCES,
    _concat_mp3,
    _scan_sentences,
)
from main import LOG_FORMAT, TokenRedactingFormatter  # noqa: E402

# main.py attaches a StreamHandler(sys.stdout) to the root logger on import.
# Redirect root handlers to stderr so stdout always contains pure JSON.
for _handler in logging.getLogger().handlers:
    if isinstance(_handler, logging.StreamHandler):
        _handler.setStream(sys.stderr)

DEFAULT_CONFIG = {
    "ALLOWED_USER_IDS": "123456",
    "TTS_PROVIDER": "edge",
    "TTS_VOICE": "zh-TW-HsiaoChenNeural",
    "BOT_WORKERS": 1,
    "CONCURRENT_UPDATES": 1,
    "BOT_QUEUE_MAXSIZE": 10,
    "CONVERSATION_MAX_TURNS": 6,
    "DAILY_REQUEST_LIMIT": 50,
    "TTS_TIMEOUT_SEC": 15,
    "FFMPEG_TIMEOUT_SEC": 30,
    "ZEN_MAX_TOKENS": 1024,
}


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            cfg = {**DEFAULT_CONFIG, **data.get("config", {})}
            return {
                "config": cfg,
                "chats": data.get("chats", {}),
                "req_counter": int(data.get("req_counter", 1000)),
            }
        except Exception:
            pass
    return {"config": dict(DEFAULT_CONFIG), "chats": {}, "req_counter": 1000}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_allowed_ids(raw: str) -> list[int]:
    ids: list[int] = []
    for part in str(raw).split(","):
        part = part.strip()
        if part.isdigit():
            ids.append(int(part))
    return ids


def setup_capture_logger(req_id: str, secrets: list[str]) -> tuple[logging.Logger, io.StringIO]:
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.addFilter(RequestIdFilter())
    handler.setFormatter(TokenRedactingFormatter(secrets, fmt=LOG_FORMAT))

    log = logging.getLogger("web_voice_bot.core")
    log.setLevel(logging.INFO)
    log.handlers = [handler]
    log.propagate = False
    req_id_var.set(req_id)
    return log, buf


def clean_text_for_tts(text: str) -> str:
    """Strip markdown formatting symbols so TTS reads replies naturally."""
    cleaned = re.sub(r"```[\s\S]*?```", "（程式碼片段已顯示於畫面）", text)
    cleaned = re.sub(r"`([^`]+)`", r"\1", cleaned)
    cleaned = re.sub(r"\*\*([^*]+)\*\*", r"\1", cleaned)
    cleaned = re.sub(r"\*([^*]+)\*", r"\1", cleaned)
    cleaned = re.sub(r"^#{1,6}\s*", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"^\s*[-•*]\s+", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"\n{2,}", "。", cleaned)
    cleaned = cleaned.replace("\n", "，")
    return cleaned.strip()


def load_store_for_chat(state: dict, chat_id: str) -> ConversationStore:
    max_turns = int(state["config"]["CONVERSATION_MAX_TURNS"])
    store = ConversationStore(max_turns=max_turns)
    raw_history = state["chats"].get(chat_id, [])
    int_chat_id = int(chat_id) if str(chat_id).isdigit() else 0
    for i in range(0, len(raw_history) - 1, 2):
        store.append_turn(int_chat_id, raw_history[i]["content"], raw_history[i + 1]["content"])
    return store


async def synthesize_voice(
    reply_text: str,
    config: dict,
    log: logging.Logger,
) -> tuple[list[str], str | None, int, float, float, str | None]:
    tts_text = clean_text_for_tts(reply_text)
    pos, sentences = _scan_sentences(tts_text, 0)
    if pos < len(tts_text):
        tail = tts_text[pos:].strip()
        if tail:
            sentences.append(tail)
    sentences = [s for s in sentences[:TTS_MAX_SENTENCES] if s.strip()]

    if not sentences:
        return [], None, 0, 0.0, 0.0, None

    provider_name = str(config.get("TTS_PROVIDER", "edge"))
    voice_name = str(config.get("TTS_VOICE", "zh-TW-HsiaoChenNeural"))
    tts_timeout = float(config.get("TTS_TIMEOUT_SEC", 15))
    ffmpeg_timeout = float(config.get("FFMPEG_TIMEOUT_SEC", 30))

    log.info(
        "Synthesizing %d sentence(s) via TTSProvider=%s voice=%s",
        len(sentences),
        provider_name,
        voice_name,
    )
    t_tts = time.monotonic()
    parts: list[bytes] = []
    chars_used = 0
    tts_note = None
    try:
        provider = get_tts_provider(provider_name, voice_name)
        frags: list[str] = []
        for s in sentences:
            if chars_used >= TTS_MAX_CHARS:
                break
            frag = s[: TTS_MAX_CHARS - chars_used]
            chars_used += len(frag)
            if frag.strip():
                frags.append(frag)

        sem = asyncio.Semaphore(4)

        async def _synth_one(text_frag: str) -> bytes:
            async with sem:
                return await asyncio.wait_for(provider.synthesize(text_frag), timeout=tts_timeout)

        results = await asyncio.gather(*(_synth_one(f) for f in frags))
        parts = [chunk for chunk in results if chunk]
        tts_ms = round((time.monotonic() - t_tts) * 1000, 1)
        log.info("TTS synthesis finished: %d chunk(s) in %.1fms (parallel)", len(parts), tts_ms)
    except Exception as exc:
        tts_ms = round((time.monotonic() - t_tts) * 1000, 1)
        tts_note = f"TTS 降級為純文字回覆（{type(exc).__name__}: {exc}）"
        log.warning("TTS graceful degradation triggered: %s: %s", type(exc).__name__, exc)

    audio_b64 = None
    audio_bytes = 0
    ffmpeg_ms = 0.0
    if parts:
        t_ff = time.monotonic()
        combined = await _concat_mp3(parts, timeout=ffmpeg_timeout)
        ffmpeg_ms = round((time.monotonic() - t_ff) * 1000, 1)
        audio_bytes = len(combined)
        audio_b64 = base64.b64encode(combined).decode("ascii")
        log.info(
            "ffmpeg concat finished: %d bytes in %.1fms (-threads 1)",
            audio_bytes,
            ffmpeg_ms,
        )

    return sentences, audio_b64, audio_bytes, tts_ms, ffmpeg_ms, tts_note


async def cmd_status() -> dict:
    state = load_state()
    git_branch = "packaged-local"
    git_commit = "c1a5e35"
    git_log: list[str] = []
    if (BOT_REPO / ".git").exists():
        try:
            git_branch = subprocess.check_output(
                ["git", "-C", str(BOT_REPO), "rev-parse", "--abbrev-ref", "HEAD"],
                text=True,
                encoding="utf-8",
                errors="replace",
                stderr=subprocess.DEVNULL,
            ).strip()
            git_commit = subprocess.check_output(
                ["git", "-C", str(BOT_REPO), "rev-parse", "--short", "HEAD"],
                text=True,
                encoding="utf-8",
                errors="replace",
                stderr=subprocess.DEVNULL,
            ).strip()
            git_log = (
                subprocess.check_output(
                    ["git", "-C", str(BOT_REPO), "log", "main..HEAD", "--oneline"],
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    stderr=subprocess.DEVNULL,
                )
                .strip()
                .splitlines()
            )
        except Exception:
            pass

    t0 = time.monotonic()
    quota_ok = await check_daily_quota(12345, limit=int(state["config"]["DAILY_REQUEST_LIMIT"]))
    redis_ms = round((time.monotonic() - t0) * 1000, 1)
    await close_redis()

    total_msgs = sum(len(msgs) for msgs in state["chats"].values())
    return {
        "pythonVersion": sys.version.split()[0],
        "ffmpegAvailable": shutil.which("ffmpeg") is not None,
        "ffprobeAvailable": shutil.which("ffprobe") is not None,
        "redisFailOpenOk": quota_ok,
        "redisCheckMs": redis_ms,
        "gitBranch": git_branch,
        "gitCommit": git_commit,
        "commitsAhead": git_log,
        "config": state["config"],
        "memoryStats": {
            "activeChats": len(state["chats"]),
            "totalMessages": total_msgs,
            "maxTurns": int(state["config"]["CONVERSATION_MAX_TURNS"]),
        },
    }


def cmd_history(payload: dict) -> dict:
    state = load_state()
    chat_id = str(payload.get("chatId", "123456"))
    history = state["chats"].get(chat_id, [])
    return {"ok": True, "chatId": chat_id, "history": history}


async def cmd_check_access(payload: dict) -> dict:
    """Fast allowlist + quota gate before running STT on voice uploads."""
    state = load_state()
    config = state["config"]
    user_id = int(payload.get("userId", 123456))
    chat_id = str(payload.get("chatId", user_id))

    state["req_counter"] += 1
    req_id = str(state["req_counter"])
    demo_secret = ":".join(["123456789", "WEB_SESSION_MASK_DEMO"])
    log, buf = setup_capture_logger(req_id, [demo_secret])

    log.info("Incoming voice upload from user_id=%d chat_id=%s", user_id, chat_id)
    allowed_ids = parse_allowed_ids(config["ALLOWED_USER_IDS"])
    if user_id not in allowed_ids:
        log.warning("Rejected unauthorized user_id=%d (allowlist=%s)", user_id, allowed_ids)
        save_state(state)
        return {
            "ok": False,
            "rejected": True,
            "reason": "Unauthorized. (User ID is not in ALLOWED_USER_IDS)",
            "reqId": req_id,
            "logs": buf.getvalue().strip().splitlines(),
        }

    quota_allowed = await check_daily_quota(user_id, limit=int(config["DAILY_REQUEST_LIMIT"]))
    await close_redis()
    log.info("Daily quota check passed=%s (limit=%s)", quota_allowed, config["DAILY_REQUEST_LIMIT"])
    save_state(state)
    return {
        "ok": True,
        "rejected": False,
        "reqId": req_id,
        "quotaAllowed": quota_allowed,
        "preLogs": buf.getvalue().strip().splitlines(),
    }


async def cmd_prepare(payload: dict) -> dict:
    """Validate allowlist, handle slash commands, check Redis quota, and load ConversationStore history."""
    state = load_state()
    config = state["config"]
    user_id = int(payload.get("userId", 123456))
    chat_id = str(payload.get("chatId", user_id))
    text = str(payload.get("text", "")).strip()
    is_voice = bool(payload.get("isVoice", True))
    existing_req_id = payload.get("reqId")
    pre_logs = list(payload.get("preLogs") or [])

    if existing_req_id:
        req_id = str(existing_req_id)
    else:
        state["req_counter"] += 1
        req_id = str(state["req_counter"])

    demo_secret = ":".join(["123456789", "WEB_SESSION_MASK_DEMO"])
    log, buf = setup_capture_logger(req_id, [demo_secret])
    t_start = time.monotonic()

    if not existing_req_id:
        log.info(
            "Incoming web message from user_id=%d chat_id=%s is_voice=%s",
            user_id,
            chat_id,
            is_voice,
        )

    allowed_ids = parse_allowed_ids(config["ALLOWED_USER_IDS"])
    if user_id not in allowed_ids:
        log.warning("Rejected unauthorized user_id=%d (allowlist=%s)", user_id, allowed_ids)
        save_state(state)
        return {
            "ok": False,
            "rejected": True,
            "handled": True,
            "reason": "Unauthorized. (User ID is not in ALLOWED_USER_IDS)",
            "reqId": req_id,
            "logs": pre_logs + buf.getvalue().strip().splitlines(),
            "elapsedMs": round((time.monotonic() - t_start) * 1000, 1),
        }

    # Built-in bot commands (replacing Telegram Bot commands)
    if text == "/reset":
        state["chats"].pop(chat_id, None)
        save_state(state)
        log.info("Cleared conversation memory for chat_id=%s", chat_id)
        return {
            "ok": True,
            "handled": True,
            "reply": "已清除目前的對話記憶，我們可以重新開始新的話題！",
            "reqId": req_id,
            "history": [],
            "sentences": [],
            "audioBase64": None,
            "audioBytes": 0,
            "ttsMs": 0,
            "ffmpegMs": 0,
            "logs": pre_logs + buf.getvalue().strip().splitlines(),
            "elapsedMs": round((time.monotonic() - t_start) * 1000, 1),
        }

    if text == "/start":
        log.info("Executed /start command for chat_id=%s", chat_id)
        save_state(state)
        reply = (
            "歡迎使用 Web Voice Bot！\n"
            "已完整取代 Telegram 介面，不需 BotFather Token 即可直接在網頁中使用：\n"
            "• 直接輸入文字提問，或點擊麥克風按鈕說話\n"
            "• 內建多輪對話記憶（Issue #26）與即時語音合成回覆（Edge-TTS + ffmpeg）\n"
            "• 輸入 /help 查看全部指令，或輸入 /reset 清空記憶"
        )
        return {
            "ok": True,
            "handled": True,
            "reply": reply,
            "reqId": req_id,
            "history": state["chats"].get(chat_id, []),
            "sentences": [],
            "audioBase64": None,
            "audioBytes": 0,
            "ttsMs": 0,
            "ffmpegMs": 0,
            "logs": pre_logs + buf.getvalue().strip().splitlines(),
            "elapsedMs": round((time.monotonic() - t_start) * 1000, 1),
        }

    if text == "/help":
        log.info("Executed /help command for chat_id=%s", chat_id)
        save_state(state)
        reply = (
            "可用指令清單：\n"
            "• /start — 顯示歡迎與系統簡介\n"
            "• /help — 查看指令說明\n"
            "• /status — 檢查目前的 TTS 引擎、記憶輪數與設定\n"
            "• /reset — 清除目前的對話記憶（ConversationStore）\n\n"
            "提示：你也可以點擊右側 Dynamic Config 即時切換語音聲線或測試 TTS 降級保護。"
        )
        return {
            "ok": True,
            "handled": True,
            "reply": reply,
            "reqId": req_id,
            "history": state["chats"].get(chat_id, []),
            "sentences": [],
            "audioBase64": None,
            "audioBytes": 0,
            "ttsMs": 0,
            "ffmpegMs": 0,
            "logs": pre_logs + buf.getvalue().strip().splitlines(),
            "elapsedMs": round((time.monotonic() - t_start) * 1000, 1),
        }

    if text == "/status":
        turns_count = len(state["chats"].get(chat_id, [])) // 2
        log.info("Executed /status command for chat_id=%s (turns=%d)", chat_id, turns_count)
        save_state(state)
        reply = (
            f"Web Voice Bot 運行中：\n"
            f"• TTS 引擎：{config['TTS_PROVIDER']}（{config['TTS_VOICE']}）\n"
            f"• 對話記憶：目前 {turns_count} / {config['CONVERSATION_MAX_TURNS']} 輪\n"
            f"• 白名單：{config['ALLOWED_USER_IDS']}\n"
            f"• 每日配額上限：{config['DAILY_REQUEST_LIMIT']} 次（Redis fail-open 保護已啟用）"
        )
        return {
            "ok": True,
            "handled": True,
            "reply": reply,
            "reqId": req_id,
            "history": state["chats"].get(chat_id, []),
            "sentences": [],
            "audioBase64": None,
            "audioBytes": 0,
            "ttsMs": 0,
            "ffmpegMs": 0,
            "logs": pre_logs + buf.getvalue().strip().splitlines(),
            "elapsedMs": round((time.monotonic() - t_start) * 1000, 1),
        }

    if not text:
        return {"ok": False, "handled": True, "reason": "Empty message."}

    quota_allowed = True
    if not existing_req_id:
        quota_allowed = await check_daily_quota(user_id, limit=int(config["DAILY_REQUEST_LIMIT"]))
        await close_redis()
        log.info("Daily quota check passed=%s (limit=%s)", quota_allowed, config["DAILY_REQUEST_LIMIT"])

    store = load_store_for_chat(state, chat_id)
    int_chat_id = int(chat_id) if str(chat_id).isdigit() else 0
    history = store.get_history(int_chat_id)
    log.info(
        "Loaded conversation history turns=%d (max_turns=%d)",
        len(history) // 2,
        int(config["CONVERSATION_MAX_TURNS"]),
    )
    save_state(state)

    return {
        "ok": True,
        "handled": False,
        "reqId": req_id,
        "history": history,
        "config": config,
        "quotaAllowed": quota_allowed,
        "preLogs": pre_logs + buf.getvalue().strip().splitlines(),
    }


async def cmd_finalize(payload: dict) -> dict:
    """Save AI reply into ConversationStore and run real TTSProvider + ffmpeg concat."""
    state = load_state()
    config = state["config"]
    chat_id = str(payload.get("chatId", "123456"))
    text = str(payload.get("text", "")).strip()
    reply = str(payload.get("reply", "")).strip()
    req_id = str(payload.get("reqId", "1000"))
    is_voice = bool(payload.get("isVoice", True))
    pre_logs = list(payload.get("preLogs") or [])
    llm_ms = float(payload.get("llmMs") or 0.0)
    stt_ms = float(payload.get("sttMs") or 0.0)

    demo_secret = ":".join(["123456789", "WEB_SESSION_MASK_DEMO"])
    log, buf = setup_capture_logger(req_id, [demo_secret])
    t_start = time.monotonic()

    if stt_ms > 0:
        log.info("Voice STT transcription completed in %.1fms (%d chars)", stt_ms, len(text))
    log.info("LLM reply generated in %.1fms (session token redacted)", llm_ms)

    # Save turn via real ConversationStore (Issue #26)
    store = load_store_for_chat(state, chat_id)
    int_chat_id = int(chat_id) if str(chat_id).isdigit() else 0
    store.append_turn(int_chat_id, text, reply)
    new_history = store.get_history(int_chat_id)
    state["chats"][chat_id] = new_history
    save_state(state)

    sentences: list[str] = []
    audio_b64 = None
    audio_bytes = 0
    tts_ms = 0.0
    ffmpeg_ms = 0.0
    tts_note = None

    if is_voice and reply:
        sentences, audio_b64, audio_bytes, tts_ms, ffmpeg_ms, tts_note = await synthesize_voice(
            reply, config, log
        )
    elif reply:
        tts_text = clean_text_for_tts(reply)
        pos, sentences = _scan_sentences(tts_text, 0)
        if pos < len(tts_text) and tts_text[pos:].strip():
            sentences.append(tts_text[pos:].strip())

    finalize_ms = round((time.monotonic() - t_start) * 1000, 1)
    total_ms = round(stt_ms + llm_ms + finalize_ms, 1)

    return {
        "ok": True,
        "reply": reply,
        "reqId": req_id,
        "history": new_history,
        "sentences": sentences,
        "audioBase64": audio_b64,
        "audioBytes": audio_bytes,
        "sttMs": round(stt_ms, 1),
        "llmMs": round(llm_ms, 1),
        "ttsMs": tts_ms,
        "ffmpegMs": ffmpeg_ms,
        "ttsNote": tts_note,
        "redisFailOpen": True,
        "logs": pre_logs + buf.getvalue().strip().splitlines(),
        "elapsedMs": total_ms,
    }


def cmd_update_config(payload: dict) -> dict:
    state = load_state()
    cfg = state["config"]
    for key in DEFAULT_CONFIG:
        if key in payload:
            val = payload[key]
            if isinstance(DEFAULT_CONFIG[key], int):
                try:
                    num = int(val)
                    cfg[key] = max(
                        0 if key in ("CONVERSATION_MAX_TURNS", "DAILY_REQUEST_LIMIT", "ZEN_MAX_TOKENS") else 1,
                        num,
                    )
                except (TypeError, ValueError):
                    pass
            else:
                cfg[key] = str(val).strip()
    state["config"] = cfg
    save_state(state)
    return {"ok": True, "config": cfg}


def cmd_run_tests() -> dict:
    t0 = time.monotonic()
    venv_dir = str(Path(sys.executable).parent)
    sub_env = {
        **os.environ,
        "PATH": venv_dir + os.pathsep + os.environ.get("PATH", ""),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }
    pytest_res = subprocess.run(
        ["python", "-m", "pytest", "-q", "--cov=bot", "--cov=main"],
        cwd=str(BOT_REPO),
        env=sub_env,
        shell=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    ruff_res = subprocess.run(
        ["python", "-m", "ruff", "check", "."],
        cwd=str(BOT_REPO),
        env=sub_env,
        shell=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    mypy_res = subprocess.run(
        ["python", "-m", "mypy", "bot/", "main.py", "--ignore-missing-imports"],
        cwd=str(BOT_REPO),
        env=sub_env,
        shell=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    return {
        "ok": pytest_res.returncode == 0 and ruff_res.returncode == 0 and mypy_res.returncode == 0,
        "elapsedMs": round((time.monotonic() - t0) * 1000, 1),
        "pytest": {"exitCode": pytest_res.returncode, "output": (pytest_res.stdout + pytest_res.stderr).strip()},
        "ruff": {"exitCode": ruff_res.returncode, "output": (ruff_res.stdout + ruff_res.stderr).strip()},
        "mypy": {"exitCode": mypy_res.returncode, "output": (mypy_res.stdout + mypy_res.stderr).strip()},
    }


async def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Missing command"}))
        sys.exit(1)

    cmd = sys.argv[1]
    payload: dict = {}
    if cmd in ("prepare", "finalize", "check_access", "config", "history"):
        raw_input = sys.stdin.read().strip()
        if raw_input:
            payload = json.loads(raw_input)

    if cmd == "status":
        result = await cmd_status()
    elif cmd == "history":
        result = cmd_history(payload)
    elif cmd == "check_access":
        result = await cmd_check_access(payload)
    elif cmd == "prepare":
        result = await cmd_prepare(payload)
    elif cmd == "finalize":
        result = await cmd_finalize(payload)
    elif cmd == "config":
        result = cmd_update_config(payload)
    elif cmd == "tests":
        result = cmd_run_tests()
    else:
        result = {"ok": False, "error": f"Unknown command: {cmd}"}

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
