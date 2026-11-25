#!/usr/bin/env python3
"""Bridge script invoking the real telegram-voice-bot Python modules for Web Voice Bot."""

import asyncio
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
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
from typing import Iterator

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore[assignment]

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore[assignment]

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


def _resolve_state_file() -> Path:
    """Resolve a crash/restart-durable state file outside the workspace directory.

    Never writes inside /app/applet so workspace snapshots stay clean and small.
    Prefers XDG_STATE_HOME / ~/.local/state (or LOCALAPPDATA on Windows) over volatile /tmp.
    """
    explicit = os.environ.get("BOT_STATE_FILE", "").strip()
    if explicit:
        return Path(explicit).expanduser()

    candidates: list[Path] = []
    if sys.platform.startswith("win"):
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            candidates.append(Path(local_app_data) / "web-voice-bot" / "live-state.json")
    else:
        xdg_state = os.environ.get("XDG_STATE_HOME")
        if xdg_state:
            candidates.append(Path(xdg_state) / "web-voice-bot" / "live-state.json")
        candidates.append(Path.home() / ".local" / "state" / "web-voice-bot" / "live-state.json")

    candidates.append(Path(tempfile.gettempdir()) / "telegram-voice-bot-live-state.json")

    for candidate in candidates:
        try:
            candidate.parent.mkdir(parents=True, exist_ok=True)
            if os.access(candidate.parent, os.W_OK):
                return candidate
        except OSError:
            continue
    return Path(tempfile.gettempdir()) / "telegram-voice-bot-live-state.json"


BOT_REPO = _resolve_bot_repo()
STATE_FILE = _resolve_state_file()
MAX_DAILY_ROUND_TRIPS = 5
STATE_SCHEMA_VERSION = 2

sys.path.insert(0, str(BOT_REPO))

from bot.logging_context import RequestIdFilter, req_id_var  # noqa: E402
from bot.memory import ConversationStore  # noqa: E402
from bot.redis_client import (  # noqa: E402
    check_daily_quota,
    close_redis,
    create_ffmpeg_semaphore,
    create_tts_semaphore,
)
from bot.resource_profile import resolve_deployment_profile  # noqa: E402

try:
    from bot.tts_provider import get_tts_provider  # noqa: E402
except ImportError:  # pragma: no cover - bare Python fallback

    def get_tts_provider(provider_name: str, voice_name: str):  # type: ignore[misc]
        raise RuntimeError(
            f"TTS provider '{provider_name}' ({voice_name}) requires /opt/bot-venv packages (edge-tts/httpx)"
        )


try:
    from bot.worker import (  # noqa: E402
        TTS_MAX_CHARS,
        TTS_MAX_SENTENCES,
        _concat_mp3,
        _scan_sentences,
    )
except ImportError:  # pragma: no cover - bare Python fallback
    TTS_MAX_CHARS = 1500
    TTS_MAX_SENTENCES = 40
    _FALLBACK_SENTENCE_ENDS = frozenset("。！？；.!?\n")

    def _scan_sentences(text: str, start: int = 0) -> tuple[int, list[str]]:  # type: ignore[misc]
        sentences: list[str] = []
        pos = start
        for idx in range(start, len(text)):
            if text[idx] in _FALLBACK_SENTENCE_ENDS:
                seg = text[pos : idx + 1].strip()
                if seg and any(ch.isalnum() or "\u4e00" <= ch <= "\u9fff" for ch in seg):
                    sentences.append(seg)
                pos = idx + 1
        return pos, sentences

    async def _concat_mp3(parts: list[bytes], timeout: float = 30.0) -> bytes:  # type: ignore[misc]
        if len(parts) == 1:
            return parts[0]
        return b"".join(parts)


try:
    from main import LOG_FORMAT, TokenRedactingFormatter  # noqa: E402
except ImportError:  # pragma: no cover - bare Python fallback
    LOG_FORMAT = "%(asctime)s [%(levelname)s] [req=%(req_id)s] %(name)s: %(message)s"

    class TokenRedactingFormatter(logging.Formatter):  # type: ignore[no-redef]
        def __init__(self, secrets: list[str], fmt: str = LOG_FORMAT) -> None:
            super().__init__(fmt)
            self._secrets = [s for s in secrets if s]

        def format(self, record: logging.LogRecord) -> str:
            rendered = super().format(record)
            for secret in self._secrets:
                rendered = rendered.replace(secret, "[REDACTED]")
            return rendered


# main.py attaches a StreamHandler(sys.stdout) to the root logger on import.
# Redirect root handlers to stderr so stdout always contains pure JSON.
for _handler in logging.getLogger().handlers:
    if isinstance(_handler, logging.StreamHandler):
        _handler.setStream(sys.stderr)

ACTIVE_PROFILE = resolve_deployment_profile()

DEFAULT_CONFIG = {
    "ALLOWED_USER_IDS": "123456",
    "TTS_PROVIDER": "edge",
    "TTS_VOICE": "zh-TW-HsiaoChenNeural",
    "BOT_WORKERS": ACTIVE_PROFILE.bot_workers,
    "CONCURRENT_UPDATES": ACTIVE_PROFILE.concurrent_updates,
    "BOT_QUEUE_MAXSIZE": ACTIVE_PROFILE.bot_queue_maxsize,
    "CONVERSATION_MAX_TURNS": MAX_DAILY_ROUND_TRIPS,
    "DAILY_REQUEST_LIMIT": 50,
    "TTS_TIMEOUT_SEC": 15,
    "FFMPEG_TIMEOUT_SEC": 30,
    "ZEN_MAX_TOKENS": 1024,
}

DEFAULT_BOT_ENTRY = {
    "botId": "default",
    "name": "主語音助手",
    "ttsVoice": "zh-TW-HsiaoChenNeural",
    "weight": 1,
    "enabled": True,
}

_SAFE_BOT_ID_RE = re.compile(r"[^a-zA-Z0-9_-]+")


def sanitize_bot_id(raw: object) -> str:
    cleaned = _SAFE_BOT_ID_RE.sub("-", str(raw or "").strip()).strip("-").lower()
    return cleaned[:32] or "default"


def _storage_chat_key(bot_id: str, chat_id: str) -> str:
    """Keep legacy raw chat_id key for 'default' bot so existing same-day turns stay intact."""
    safe_bot = sanitize_bot_id(bot_id)
    return chat_id if safe_bot == "default" else f"{safe_bot}:{chat_id}"


def _normalize_bots(raw_bots: object, default_voice: str) -> list[dict]:
    entries: list[dict] = []
    seen: set[str] = set()
    if isinstance(raw_bots, list):
        for item in raw_bots:
            if not isinstance(item, dict):
                continue
            bid = sanitize_bot_id(item.get("botId"))
            if bid in seen:
                continue
            seen.add(bid)
            entries.append(
                {
                    "botId": bid,
                    "name": str(item.get("name") or bid).strip()[:48] or bid,
                    "ttsVoice": str(item.get("ttsVoice") or default_voice).strip()
                    or default_voice,
                    "weight": max(1, min(10, int(item.get("weight", 1) or 1))),
                    "enabled": bool(item.get("enabled", True)),
                }
            )
    if not any(e["botId"] == "default" for e in entries):
        entries.insert(
            0,
            {
                **DEFAULT_BOT_ENTRY,
                "ttsVoice": default_voice,
            },
        )
    # Strictly enforce 1C/1G single-bot ceiling when effective RAM <= 1 GB
    if ACTIVE_PROFILE.mode == "constrained_1c1g":
        return [entries[0]]
    return entries[: ACTIVE_PROFILE.max_bots]


def _resolve_bot_config(state: dict, bot_id: str) -> tuple[str, dict]:
    safe_bot = sanitize_bot_id(bot_id)
    cfg = dict(state["config"])
    for b in state.get("bots", []):
        if b.get("botId") == safe_bot:
            if b.get("ttsVoice"):
                cfg["TTS_VOICE"] = str(b["ttsVoice"])
            return safe_bot, cfg
    return "default", cfg


def current_day_key(override: str | None = None) -> str:
    """Return YYYY-MM-DD in configured timezone (default Asia/Taipei), honoring a valid client dayKey."""
    if override and re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(override).strip()):
        return str(override).strip()
    tz_name = os.environ.get("TIMEZONE", "Asia/Taipei").strip() or "Asia/Taipei"
    if ZoneInfo is not None:
        try:
            return datetime.now(ZoneInfo(tz_name)).strftime("%Y-%m-%d")
        except Exception:
            pass
    return datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d")


@contextmanager
def _state_lock() -> Iterator[None]:
    """Advisory file lock around state reads/writes to prevent torn JSON under concurrency."""
    lock_path = STATE_FILE.with_suffix(".lock")
    lock_fd = None
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
        if fcntl is not None:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
        yield
    except OSError:
        yield
    finally:
        if lock_fd is not None:
            try:
                if fcntl is not None:
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                os.close(lock_fd)
            except OSError:
                pass


def _enforce_daily_retention(state: dict, today_key: str) -> bool:
    """Purge prior-day chats and enforce MAX_DAILY_ROUND_TRIPS (<= 5 turns) FIFO cap."""
    changed = False
    chat_days: dict[str, str] = state.setdefault("chat_days", {})
    chats: dict[str, list[dict]] = state.setdefault("chats", {})
    turns_map: dict[str, list[dict]] = state.setdefault("turns", {})

    stale_chat_ids = [
        cid for cid in set(list(chats.keys()) + list(turns_map.keys()))
        if chat_days.get(cid) and chat_days.get(cid) != today_key
    ]
    for cid in stale_chat_ids:
        chats.pop(cid, None)
        turns_map.pop(cid, None)
        chat_days.pop(cid, None)
        changed = True

    max_pairs = MAX_DAILY_ROUND_TRIPS * 2
    for cid, msgs in list(chats.items()):
        if len(msgs) > max_pairs:
            chats[cid] = msgs[-max_pairs:]
            changed = True
        if cid not in chat_days and msgs:
            chat_days[cid] = today_key
            changed = True

    for cid, turn_list in list(turns_map.items()):
        same_day = [
            t for t in turn_list
            if not t.get("dayKey") or t.get("dayKey") == today_key
        ]
        if len(same_day) > MAX_DAILY_ROUND_TRIPS:
            same_day = same_day[-MAX_DAILY_ROUND_TRIPS:]
        if len(same_day) != len(turn_list):
            turns_map[cid] = same_day
            changed = True

    return changed


def load_state(day_key: str | None = None) -> dict:
    today = current_day_key(day_key)
    with _state_lock():
        if STATE_FILE.exists():
            try:
                data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
                cfg = {**DEFAULT_CONFIG, **data.get("config", {})}
                state = {
                    "schema_version": STATE_SCHEMA_VERSION,
                    "config": cfg,
                    "bots": _normalize_bots(data.get("bots"), str(cfg["TTS_VOICE"])),
                    "chats": data.get("chats", {}),
                    "turns": data.get("turns", {}),
                    "chat_days": data.get("chat_days", {}),
                    "req_counter": int(data.get("req_counter", 1000)),
                }
                if _enforce_daily_retention(state, today):
                    _write_state_atomic(state)
                return state
            except Exception:
                pass
    return {
        "schema_version": STATE_SCHEMA_VERSION,
        "config": dict(DEFAULT_CONFIG),
        "bots": _normalize_bots([], str(DEFAULT_CONFIG["TTS_VOICE"])),
        "chats": {},
        "turns": {},
        "chat_days": {},
        "req_counter": 1000,
    }


def _write_state_atomic(state: dict) -> None:
    """Write JSON atomically (temp sibling + fsync + os.replace) so restarts never corrupt state."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(state, ensure_ascii=False, indent=2)
    tmp_path = STATE_FILE.with_name(f".{STATE_FILE.name}.{os.getpid()}.tmp")
    with open(tmp_path, "w", encoding="utf-8") as fh:
        fh.write(serialized)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp_path, STATE_FILE)


def save_state(state: dict) -> None:
    with _state_lock():
        _write_state_atomic(state)


def parse_allowed_ids(raw: str) -> list[int]:
    ids: list[int] = []
    for part in str(raw).split(","):
        part = part.strip()
        if part.isdigit():
            ids.append(int(part))
    return ids


def setup_capture_logger(
    req_id: str, secrets: list[str]
) -> tuple[logging.Logger, io.StringIO]:
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


def load_store_for_chat(state: dict, storage_key: str) -> ConversationStore:
    max_turns = int(state["config"]["CONVERSATION_MAX_TURNS"])
    store = ConversationStore(max_turns=max_turns)
    raw_history = state["chats"].get(storage_key, [])
    for i in range(0, len(raw_history) - 1, 2):
        store.append_turn(
            storage_key, raw_history[i]["content"], raw_history[i + 1]["content"]
        )
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

        tts_sem = create_tts_semaphore(
            provider_name,
            max_permits=max(1, ACTIVE_PROFILE.tts_concurrency),
            acquire_timeout_sec=tts_timeout,
        )

        async def _synth_one(text_frag: str) -> bytes:
            started = time.monotonic()
            async with tts_sem.acquire(timeout_sec=tts_timeout):
                remaining = max(0.5, tts_timeout - (time.monotonic() - started))
                return await asyncio.wait_for(
                    provider.synthesize(text_frag), timeout=remaining
                )

        results = await asyncio.gather(*(_synth_one(f) for f in frags))
        parts = [chunk for chunk in results if chunk]
        tts_ms = round((time.monotonic() - t_tts) * 1000, 1)
        log.info(
            "TTS synthesis finished: %d chunk(s) in %.1fms (parallel, max_permits=%d)",
            len(parts),
            tts_ms,
            ACTIVE_PROFILE.tts_concurrency,
        )
    except Exception as exc:
        tts_ms = round((time.monotonic() - t_tts) * 1000, 1)
        tts_note = f"TTS 降級為純文字回覆（{type(exc).__name__}: {exc}）"
        log.warning(
            "TTS graceful degradation triggered: %s: %s", type(exc).__name__, exc
        )

    audio_b64 = None
    audio_bytes = 0
    ffmpeg_ms = 0.0
    if parts:
        t_ff = time.monotonic()
        ffmpeg_sem = create_ffmpeg_semaphore(
            max_permits=max(1, ACTIVE_PROFILE.ffmpeg_concurrency),
            acquire_timeout_sec=ffmpeg_timeout,
        )
        try:
            async with ffmpeg_sem.acquire(timeout_sec=ffmpeg_timeout):
                ff_remaining = max(0.5, ffmpeg_timeout - (time.monotonic() - t_ff))
                combined = await _concat_mp3(parts, timeout=ff_remaining)
        except Exception as exc:
            log.warning(
                "FFmpeg concat semaphore/execution failed (%s: %s); falling back to first TTS chunk",
                type(exc).__name__,
                exc,
            )
            combined = parts[0]
        ffmpeg_ms = round((time.monotonic() - t_ff) * 1000, 1)
        audio_bytes = len(combined)
        audio_b64 = base64.b64encode(combined).decode("ascii")
        log.info(
            "ffmpeg concat finished: %d bytes in %.1fms (-threads 1)",
            audio_bytes,
            ffmpeg_ms,
        )

    await close_redis()
    return sentences, audio_b64, audio_bytes, tts_ms, ffmpeg_ms, tts_note


async def cmd_status() -> dict:
    state = load_state()
    git_branch = "packaged-local"
    git_commit = "ready"
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
    quota_ok = await check_daily_quota(
        12345, limit=int(state["config"]["DAILY_REQUEST_LIMIT"])
    )
    redis_ms = round((time.monotonic() - t0) * 1000, 1)
    await close_redis()

    total_msgs = sum(len(msgs) for msgs in state["chats"].values())
    return {
        "hostOs": "windows" if sys.platform.startswith("win") else "linux",
        "pythonVersion": sys.version.split()[0],
        "ffmpegAvailable": shutil.which("ffmpeg") is not None,
        "ffprobeAvailable": shutil.which("ffprobe") is not None,
        "redisFailOpenOk": quota_ok,
        "redisCheckMs": redis_ms,
        "gitBranch": git_branch,
        "gitCommit": git_commit,
        "commitsAhead": git_log,
        "config": state["config"],
        "deploymentProfile": ACTIVE_PROFILE.to_dict(),
        "activeBots": state["bots"],
        "memoryStats": {
            "activeChats": len(state["chats"]),
            "totalMessages": total_msgs,
            "maxTurns": int(state["config"]["CONVERSATION_MAX_TURNS"]),
        },
    }


def cmd_manage_bots(payload: dict) -> dict:
    """List, add, or remove bots on the unified single-website runtime.

    Strictly refuses adding a 2nd bot when running in 1C/1G constrained mode (<= 1 GB RAM).
    """
    state = load_state()
    action = str(payload.get("action") or "list").strip().lower()
    bots: list[dict] = list(state["bots"])

    if action == "list":
        return {
            "ok": True,
            "deploymentProfile": ACTIVE_PROFILE.to_dict(),
            "activeBots": bots,
        }

    if action == "add":
        if ACTIVE_PROFILE.mode == "constrained_1c1g" or len(bots) >= ACTIVE_PROFILE.max_bots:
            return {
                "ok": False,
                "error": (
                    f"目前為 {ACTIVE_PROFILE.tier}（有效可用記憶體 {ACTIVE_PROFILE.resources.effective_available_ram_mb} MB），"
                    f"最多僅允許 {ACTIVE_PROFILE.max_bots} 個 Bot，無法再新增更多 Bot。"
                ),
                "deploymentProfile": ACTIVE_PROFILE.to_dict(),
                "activeBots": bots,
            }
        raw_id = str(payload.get("botId") or f"bot-{len(bots) + 1}")
        bid = sanitize_bot_id(raw_id)
        if any(b["botId"] == bid for b in bots):
            bid = f"{bid}-{len(bots) + 1}"
        name = str(payload.get("name") or f"語音助手 {len(bots) + 1}").strip()[:48]
        voice = str(payload.get("ttsVoice") or state["config"]["TTS_VOICE"]).strip()
        weight = max(1, min(10, int(payload.get("weight", 1) or 1)))
        bots.append(
            {
                "botId": bid,
                "name": name,
                "ttsVoice": voice,
                "weight": weight,
                "enabled": True,
            }
        )
        state["bots"] = bots
        save_state(state)
        return {
            "ok": True,
            "botId": bid,
            "deploymentProfile": ACTIVE_PROFILE.to_dict(),
            "activeBots": bots,
        }

    if action == "remove":
        bid = sanitize_bot_id(payload.get("botId"))
        if bid == "default":
            return {
                "ok": False,
                "error": "預設主 Bot (default) 不可移除。",
                "activeBots": bots,
            }
        filtered = [b for b in bots if b["botId"] != bid]
        state["bots"] = filtered
        # Clean up isolated chat histories for the removed bot
        prefix = f"{bid}:"
        for bucket in ("chats", "turns", "chat_days"):
            for k in list(state[bucket].keys()):
                if k.startswith(prefix):
                    state[bucket].pop(k, None)
        save_state(state)
        return {
            "ok": True,
            "removedBotId": bid,
            "deploymentProfile": ACTIVE_PROFILE.to_dict(),
            "activeBots": filtered,
        }

    return {"ok": False, "error": f"Unsupported action: {action}"}


def cmd_history(payload: dict) -> dict:
    day_key = current_day_key(payload.get("dayKey"))
    state = load_state(day_key)
    bot_id = sanitize_bot_id(payload.get("botId", "default"))
    chat_id = str(payload.get("chatId", "123456"))
    storage_key = _storage_chat_key(bot_id, chat_id)
    history = state["chats"].get(storage_key, [])
    turns = state["turns"].get(storage_key, [])
    return {
        "ok": True,
        "botId": bot_id,
        "chatId": chat_id,
        "dayKey": day_key,
        "maxDailyTurns": MAX_DAILY_ROUND_TRIPS,
        "history": history,
        "turns": turns,
    }


def cmd_sync_history(payload: dict) -> dict:
    """Re-hydrate backend ConversationStore from client same-day turns after container restart."""
    day_key = current_day_key(payload.get("dayKey"))
    state = load_state(day_key)
    bot_id = sanitize_bot_id(payload.get("botId", "default"))
    chat_id = str(payload.get("chatId", "123456"))
    storage_key = _storage_chat_key(bot_id, chat_id)
    raw_turns = payload.get("turns")
    if not isinstance(raw_turns, list):
        return {"ok": False, "error": "turns must be a list"}

    same_day_turns: list[dict] = []
    for item in raw_turns:
        if not isinstance(item, dict):
            continue
        item_day = str(item.get("dayKey") or day_key)
        if item_day != day_key:
            continue
        user_text = str(item.get("userText") or "").strip()
        reply_text = str(item.get("reply") or "").strip()
        if not user_text:
            continue
        same_day_turns.append(
            {
                "id": str(item.get("id") or f"synced-{len(same_day_turns)}"),
                "userId": int(item.get("userId") or 123456),
                "userText": user_text[:2000],
                "inputMode": "voice" if item.get("inputMode") == "voice" else "text",
                "isVoiceReply": bool(item.get("isVoiceReply", False)),
                "rejected": bool(item.get("rejected", False)),
                "blocked": bool(item.get("blocked", False)),
                "reply": reply_text[:4000] if reply_text else None,
                "reason": str(item.get("reason")) if item.get("reason") else None,
                "reqId": str(item.get("reqId") or "restored"),
                "elapsedMs": float(item.get("elapsedMs") or 0),
                "dayKey": day_key,
                "createdAt": str(item.get("createdAt") or datetime.now(timezone.utc).isoformat()),
            }
        )

    bounded_turns = same_day_turns[-MAX_DAILY_ROUND_TRIPS:]
    pairs: list[dict[str, str]] = []
    for t in bounded_turns:
        if t.get("reply") and not t.get("rejected") and not t.get("blocked"):
            pairs.append({"role": "user", "content": t["userText"]})
            pairs.append({"role": "assistant", "content": t["reply"]})

    state["turns"][storage_key] = bounded_turns
    state["chats"][storage_key] = pairs[-(MAX_DAILY_ROUND_TRIPS * 2) :]
    state["chat_days"][storage_key] = day_key
    save_state(state)
    return {
        "ok": True,
        "botId": bot_id,
        "chatId": chat_id,
        "dayKey": day_key,
        "syncedTurns": len(bounded_turns),
        "historyMessages": len(state["chats"][storage_key]),
    }


async def cmd_check_access(payload: dict) -> dict:
    """Fast allowlist + quota gate before running STT on voice uploads."""
    state = load_state()
    bot_id, config = _resolve_bot_config(state, str(payload.get("botId", "default")))
    user_id = int(payload.get("userId", 123456))
    chat_id = str(payload.get("chatId", user_id))

    state["req_counter"] += 1
    req_id = str(state["req_counter"])
    demo_secret = ":".join(["123456789", "WEB_SESSION_MASK_DEMO"])
    log, buf = setup_capture_logger(req_id, [demo_secret])

    log.info(
        "Incoming voice upload (bot=%s) from user_id=%d chat_id=%s",
        bot_id,
        user_id,
        chat_id,
    )
    allowed_ids = parse_allowed_ids(config["ALLOWED_USER_IDS"])
    if user_id not in allowed_ids:
        log.warning(
            "Rejected unauthorized user_id=%d (allowlist=%s)", user_id, allowed_ids
        )
        save_state(state)
        return {
            "ok": False,
            "rejected": True,
            "reason": "Unauthorized. (User ID is not in ALLOWED_USER_IDS)",
            "reqId": req_id,
            "logs": buf.getvalue().strip().splitlines(),
        }

    quota_allowed = await check_daily_quota(
        user_id, limit=int(config["DAILY_REQUEST_LIMIT"]), bot_id=bot_id
    )
    await close_redis()
    log.info(
        "Daily quota check (bot=%s) passed=%s (limit=%s)",
        bot_id,
        quota_allowed,
        config["DAILY_REQUEST_LIMIT"],
    )
    save_state(state)
    return {
        "ok": True,
        "rejected": False,
        "botId": bot_id,
        "reqId": req_id,
        "quotaAllowed": quota_allowed,
        "preLogs": buf.getvalue().strip().splitlines(),
    }


async def cmd_prepare(payload: dict) -> dict:
    """Validate allowlist, handle slash commands, check Redis quota, and load ConversationStore history."""
    state = load_state()
    bot_id, config = _resolve_bot_config(state, str(payload.get("botId", "default")))
    user_id = int(payload.get("userId", 123456))
    chat_id = str(payload.get("chatId", user_id))
    storage_key = _storage_chat_key(bot_id, chat_id)
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
            "Incoming web message (bot=%s) from user_id=%d chat_id=%s is_voice=%s",
            bot_id,
            user_id,
            chat_id,
            is_voice,
        )

    allowed_ids = parse_allowed_ids(config["ALLOWED_USER_IDS"])
    if user_id not in allowed_ids:
        log.warning(
            "Rejected unauthorized user_id=%d (allowlist=%s)", user_id, allowed_ids
        )
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
        state["chats"].pop(storage_key, None)
        state["turns"].pop(storage_key, None)
        state["chat_days"].pop(storage_key, None)
        save_state(state)
        log.info("Cleared conversation memory for bot=%s chat_id=%s", bot_id, chat_id)
        return {
            "ok": True,
            "handled": True,
            "botId": bot_id,
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
        log.info("Executed /start command for bot=%s chat_id=%s", bot_id, chat_id)
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
            "botId": bot_id,
            "reply": reply,
            "reqId": req_id,
            "history": state["chats"].get(storage_key, []),
            "sentences": [],
            "audioBase64": None,
            "audioBytes": 0,
            "ttsMs": 0,
            "ffmpegMs": 0,
            "logs": pre_logs + buf.getvalue().strip().splitlines(),
            "elapsedMs": round((time.monotonic() - t_start) * 1000, 1),
        }

    if text == "/help":
        log.info("Executed /help command for bot=%s chat_id=%s", bot_id, chat_id)
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
            "botId": bot_id,
            "reply": reply,
            "reqId": req_id,
            "history": state["chats"].get(storage_key, []),
            "sentences": [],
            "audioBase64": None,
            "audioBytes": 0,
            "ttsMs": 0,
            "ffmpegMs": 0,
            "logs": pre_logs + buf.getvalue().strip().splitlines(),
            "elapsedMs": round((time.monotonic() - t_start) * 1000, 1),
        }

    if text == "/status":
        turns_count = len(state["chats"].get(storage_key, [])) // 2
        log.info(
            "Executed /status command for bot=%s chat_id=%s (turns=%d)",
            bot_id,
            chat_id,
            turns_count,
        )
        save_state(state)
        reply = (
            f"Web Voice Bot ({bot_id}) 運行中：\n"
            f"• 部署模式：{ACTIVE_PROFILE.tier}（可用 RAM {ACTIVE_PROFILE.resources.effective_available_ram_mb} MB，上限 {ACTIVE_PROFILE.max_bots} 個 Bot）\n"
            f"• TTS 引擎：{config['TTS_PROVIDER']}（{config['TTS_VOICE']}）\n"
            f"• 對話記憶：目前 {turns_count} / {config['CONVERSATION_MAX_TURNS']} 輪\n"
            f"• 白名單：{config['ALLOWED_USER_IDS']}\n"
            f"• 每日配額上限：{config['DAILY_REQUEST_LIMIT']} 次（Redis fail-open 保護已啟用）"
        )
        return {
            "ok": True,
            "handled": True,
            "botId": bot_id,
            "reply": reply,
            "reqId": req_id,
            "history": state["chats"].get(storage_key, []),
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
        quota_allowed = await check_daily_quota(
            user_id, limit=int(config["DAILY_REQUEST_LIMIT"]), bot_id=bot_id
        )
        await close_redis()
        log.info(
            "Daily quota check (bot=%s) passed=%s (limit=%s)",
            bot_id,
            quota_allowed,
            config["DAILY_REQUEST_LIMIT"],
        )

    store = load_store_for_chat(state, storage_key)
    history = store.get_history(storage_key)
    log.info(
        "Loaded conversation history (bot=%s) turns=%d (max_turns=%d)",
        bot_id,
        len(history) // 2,
        int(config["CONVERSATION_MAX_TURNS"]),
    )
    save_state(state)

    return {
        "ok": True,
        "handled": False,
        "botId": bot_id,
        "reqId": req_id,
        "history": history,
        "config": config,
        "quotaAllowed": quota_allowed,
        "preLogs": pre_logs + buf.getvalue().strip().splitlines(),
    }


async def cmd_finalize(payload: dict) -> dict:
    """Save AI reply into ConversationStore and run real TTSProvider + ffmpeg concat."""
    state = load_state()
    bot_id, config = _resolve_bot_config(state, str(payload.get("botId", "default")))
    chat_id = str(payload.get("chatId", "123456"))
    storage_key = _storage_chat_key(bot_id, chat_id)
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
        log.info(
            "Voice STT transcription completed in %.1fms (%d chars)", stt_ms, len(text)
        )
    log.info("LLM reply generated in %.1fms (bot=%s, session token redacted)", llm_ms, bot_id)

    # Save turn via real ConversationStore (Issue #26) + Same-Day <= 5 round-trip retention
    today_key = current_day_key(payload.get("dayKey"))
    effective_max_turns = min(
        MAX_DAILY_ROUND_TRIPS,
        max(1, int(config.get("CONVERSATION_MAX_TURNS", MAX_DAILY_ROUND_TRIPS))),
    )
    store = load_store_for_chat(state, storage_key)
    store.configure(max_turns=effective_max_turns)
    store.append_turn(storage_key, text, reply)
    new_history = store.get_history(storage_key)
    state["chats"][storage_key] = new_history
    state["chat_days"][storage_key] = today_key

    int_chat_id = int(chat_id) if str(chat_id).isdigit() else 123456
    existing_turns = [
        t for t in state["turns"].get(storage_key, [])
        if not t.get("dayKey") or t.get("dayKey") == today_key
    ]
    existing_turns.append(
        {
            "id": f"srv-{req_id}-{int(time.time() * 1000)}",
            "botId": bot_id,
            "userId": int_chat_id,
            "userText": text[:2000],
            "inputMode": "voice" if stt_ms > 0 else "text",
            "isVoiceReply": is_voice,
            "reply": reply[:4000],
            "reqId": req_id,
            "sttMs": round(stt_ms, 1),
            "llmMs": round(llm_ms, 1),
            "elapsedMs": round(stt_ms + llm_ms, 1),
            "dayKey": today_key,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
    )
    evicted_count = max(0, len(existing_turns) - MAX_DAILY_ROUND_TRIPS)
    state["turns"][storage_key] = existing_turns[-MAX_DAILY_ROUND_TRIPS:]
    save_state(state)

    sentences: list[str] = []
    audio_b64 = None
    audio_bytes = 0
    tts_ms = 0.0
    ffmpeg_ms = 0.0
    tts_note = None

    skip_tts = bool(payload.get("skipTts", False))
    if is_voice and reply and not skip_tts:
        (
            sentences,
            audio_b64,
            audio_bytes,
            tts_ms,
            ffmpeg_ms,
            tts_note,
        ) = await synthesize_voice(reply, config, log)
    elif reply:
        tts_text = clean_text_for_tts(reply)
        pos, sentences = _scan_sentences(tts_text, 0)
        if pos < len(tts_text) and tts_text[pos:].strip():
            sentences.append(tts_text[pos:].strip())

    finalize_ms = round((time.monotonic() - t_start) * 1000, 1)
    total_ms = round(stt_ms + llm_ms + finalize_ms, 1)

    return {
        "ok": True,
        "botId": bot_id,
        "reply": reply,
        "reqId": req_id,
        "history": new_history,
        "sentences": sentences,
        "audioBase64": audio_b64,
        "audioMimeType": "audio/mpeg" if audio_b64 else None,
        "audioBytes": audio_bytes,
        "ttsVoice": str(config.get("TTS_VOICE", "zh-TW-HsiaoChenNeural")),
        "sttMs": round(stt_ms, 1),
        "llmMs": round(llm_ms, 1),
        "ttsMs": tts_ms,
        "ffmpegMs": ffmpeg_ms,
        "ttsNote": tts_note,
        "redisFailOpen": True,
        "dayKey": today_key,
        "evictedTurns": evicted_count,
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
                        0
                        if key
                        in (
                            "CONVERSATION_MAX_TURNS",
                            "DAILY_REQUEST_LIMIT",
                            "ZEN_MAX_TOKENS",
                        )
                        else 1,
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
        "ok": pytest_res.returncode == 0
        and ruff_res.returncode == 0
        and mypy_res.returncode == 0,
        "elapsedMs": round((time.monotonic() - t0) * 1000, 1),
        "pytest": {
            "exitCode": pytest_res.returncode,
            "output": (pytest_res.stdout + pytest_res.stderr).strip(),
        },
        "ruff": {
            "exitCode": ruff_res.returncode,
            "output": (ruff_res.stdout + ruff_res.stderr).strip(),
        },
        "mypy": {
            "exitCode": mypy_res.returncode,
            "output": (mypy_res.stdout + mypy_res.stderr).strip(),
        },
    }


async def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Missing command"}))
        sys.exit(1)

    cmd = sys.argv[1]
    payload: dict = {}
    if cmd in ("prepare", "finalize", "check_access", "config", "history", "sync_history", "bots"):
        raw_input = sys.stdin.read().strip()
        if raw_input:
            payload = json.loads(raw_input)

    if cmd == "status":
        result = await cmd_status()
    elif cmd == "bots":
        result = cmd_manage_bots(payload)
    elif cmd == "history":
        result = cmd_history(payload)
    elif cmd == "sync_history":
        result = cmd_sync_history(payload)
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
