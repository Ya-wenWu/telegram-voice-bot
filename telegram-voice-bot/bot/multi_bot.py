"""Multi-bot registry and single-runtime ingress manager for high-concurrency voice processing.

Allows hosting 2 or more Telegram bots within one async runtime sharing a single
high-concurrency ``WorkerPool``, Redis ``DistributedLeaseSemaphore`` (FFmpeg/TTS),
and unified ``ObservabilityServer`` — while strictly enforcing ``max_bots=1`` in
``constrained_1c1g`` (<= 1 GB RAM) mode.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import signal
from dataclasses import dataclass
from typing import Any

from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters

from bot.config import (
    ACTIVE_DEPLOYMENT_PROFILE,
    ALLOWED_USER_IDS,
    BOT_QUEUE_MAXSIZE,
    BOT_WORKERS,
    CONCURRENT_UPDATES,
    DAILY_REQUEST_LIMIT,
    METRICS_HOST,
    METRICS_PORT,
    OTEL_ENABLED,
    OTEL_SERVICE_NAME,
    TELEGRAM_BOT_TOKEN,
    TTS_PROVIDER,
    TTS_VOICE,
    _parse_user_ids,
)
from bot.resource_profile import DeploymentProfile

logger = logging.getLogger(__name__)

_SAFE_BOT_ID_RE = re.compile(r"[^a-zA-Z0-9_-]+")


def sanitize_bot_id(raw: str, fallback: str = "default") -> str:
    cleaned = _SAFE_BOT_ID_RE.sub("-", (raw or "").strip()).strip("-").lower()
    return cleaned[:32] or fallback


@dataclass(frozen=True)
class BotSpec:
    """Configuration descriptor for a single Telegram bot managed by the runtime."""

    bot_id: str
    name: str
    token: str
    tts_provider: str = TTS_PROVIDER
    tts_voice: str = TTS_VOICE
    allowed_user_ids: tuple[int, ...] = ()
    daily_request_limit: int = DAILY_REQUEST_LIMIT
    weight: int = 1

    def to_public_dict(self) -> dict[str, Any]:
        """Return safe non-secret metadata for status APIs and Web UI."""
        return {
            "botId": self.bot_id,
            "name": self.name,
            "ttsProvider": self.tts_provider,
            "ttsVoice": self.tts_voice,
            "dailyRequestLimit": self.daily_request_limit,
            "weight": self.weight,
            "configured": bool(self.token and self.token != "your_token_here"),
        }


def load_bot_registry(
    profile: DeploymentProfile | None = None,
    *,
    registry_json: str | None = None,
    tokens_csv: str | None = None,
    default_token: str | None = None,
) -> list[BotSpec]:
    """Load configured Telegram bots and enforce ``profile.max_bots`` safety limits.

    Sources (in priority order):
    1. ``BOTS_REGISTRY_JSON``: JSON array of bot objects (supporting ``tokenEnv`` or ``token``).
    2. ``TELEGRAM_BOT_TOKENS``: Comma-separated ``botId=token`` or ``token1,token2``.
    3. Legacy ``TELEGRAM_BOT_TOKEN``: Single ``default`` bot.
    """
    active_profile = profile or ACTIVE_DEPLOYMENT_PROFILE
    raw_json = (
        registry_json
        if registry_json is not None
        else os.getenv("BOTS_REGISTRY_JSON", "")
    ).strip()
    raw_csv = (
        tokens_csv
        if tokens_csv is not None
        else os.getenv("TELEGRAM_BOT_TOKENS", "")
    ).strip()
    fallback_tok = (
        default_token if default_token is not None else TELEGRAM_BOT_TOKEN
    ).strip()

    specs: list[BotSpec] = []
    seen_ids: set[str] = set()

    if raw_json:
        try:
            parsed = json.loads(raw_json)
            if isinstance(parsed, list):
                for idx, entry in enumerate(parsed):
                    if not isinstance(entry, dict):
                        continue
                    tok = str(entry.get("token") or "").strip()
                    token_env = str(entry.get("tokenEnv") or "").strip()
                    if not tok and token_env:
                        tok = os.getenv(token_env, "").strip()
                    if not tok or tok == "your_token_here":
                        continue
                    bid = sanitize_bot_id(
                        str(entry.get("botId") or entry.get("id") or f"bot-{idx + 1}"),
                        fallback=f"bot-{idx + 1}",
                    )
                    if bid in seen_ids:
                        bid = f"{bid}-{idx + 1}"
                    seen_ids.add(bid)

                    raw_allow = entry.get("allowedUserIds")
                    if isinstance(raw_allow, list):
                        allow_tuple = tuple(int(x) for x in raw_allow if str(x).isdigit())
                    elif isinstance(raw_allow, str) and raw_allow.strip():
                        allow_tuple = tuple(_parse_user_ids(raw_allow))
                    else:
                        allow_tuple = tuple(ALLOWED_USER_IDS)

                    specs.append(
                        BotSpec(
                            bot_id=bid,
                            name=str(entry.get("name") or bid).strip()[:48],
                            token=tok,
                            tts_provider=str(entry.get("ttsProvider") or TTS_PROVIDER).strip(),
                            tts_voice=str(entry.get("ttsVoice") or TTS_VOICE).strip(),
                            allowed_user_ids=allow_tuple,
                            daily_request_limit=max(
                                0,
                                int(entry.get("dailyRequestLimit", DAILY_REQUEST_LIMIT)),
                            ),
                            weight=max(1, min(10, int(entry.get("weight", 1)))),
                        )
                    )
        except (ValueError, TypeError) as exc:
            logger.warning("Invalid BOTS_REGISTRY_JSON; falling back: %s", exc)

    if not specs and raw_csv:
        for idx, item in enumerate(raw_csv.split(",")):
            part = item.strip()
            if not part:
                continue
            if "=" in part:
                raw_id, raw_tok = part.split("=", 1)
                bid = sanitize_bot_id(raw_id, fallback=f"bot-{idx + 1}")
                tok = raw_tok.strip()
            else:
                bid = "default" if idx == 0 else f"bot-{idx + 1}"
                tok = part
            if not tok or tok == "your_token_here":
                continue
            if bid in seen_ids:
                bid = f"{bid}-{idx + 1}"
            seen_ids.add(bid)
            specs.append(
                BotSpec(
                    bot_id=bid,
                    name=f"Telegram Bot ({bid})",
                    token=tok,
                    allowed_user_ids=tuple(ALLOWED_USER_IDS),
                )
            )

    if not specs and fallback_tok and fallback_tok != "your_token_here":
        specs.append(
            BotSpec(
                bot_id="default",
                name="主語音助手",
                token=fallback_tok,
                allowed_user_ids=tuple(ALLOWED_USER_IDS),
            )
        )

    if len(specs) > active_profile.max_bots:
        logger.warning(
            "Configured %d bot(s), but deployment profile '%s' (%d MB RAM) limits max_bots=%d; "
            "truncating to first %d bot(s) to protect server stability.",
            len(specs),
            active_profile.mode,
            active_profile.resources.effective_available_ram_mb,
            active_profile.max_bots,
            active_profile.max_bots,
        )
        specs = specs[: active_profile.max_bots]

    return specs


class MultiBotManager:
    """Hosts 2+ Telegram Bot Applications in one event loop sharing one high-concurrency WorkerPool."""

    def __init__(
        self,
        bots: list[BotSpec],
        *,
        profile: DeploymentProfile | None = None,
        num_workers: int | None = None,
        max_queue_size: int | None = None,
        concurrent_updates: int | None = None,
    ) -> None:
        if not bots:
            raise ValueError("MultiBotManager requires at least one BotSpec")
        self._profile = profile or ACTIVE_DEPLOYMENT_PROFILE
        self._bots = list(bots[: self._profile.max_bots])
        self._num_workers = max(1, num_workers or BOT_WORKERS)
        self._max_queue_size = max(1, max_queue_size or BOT_QUEUE_MAXSIZE)
        self._concurrent_updates = max(1, concurrent_updates or CONCURRENT_UPDATES)
        self._apps: dict[str, Application] = {}
        self._pool: Any = None
        self._obs_server: Any = None

    @property
    def bot_ids(self) -> list[str]:
        return [b.bot_id for b in self._bots]

    def _build_applications(self) -> dict[str, Application]:
        from bot.handlers import create_bound_handlers

        apps: dict[str, Application] = {}
        for spec in self._bots:
            bound = create_bound_handlers(
                bot_id=spec.bot_id,
                bot_weight=spec.weight,
                allowed_user_ids=spec.allowed_user_ids,
                daily_request_limit=spec.daily_request_limit,
                tts_voice=spec.tts_voice,
            )
            app = (
                Application.builder()
                .token(spec.token)
                .concurrent_updates(self._concurrent_updates)
                .build()
            )
            app.add_handler(CommandHandler("start", bound["start"]))
            app.add_handler(CommandHandler("reset", bound["reset_memory"]))
            app.add_handler(CommandHandler("verify", bound["verify_human"]))
            app.add_handler(
                MessageHandler(filters.TEXT & ~filters.COMMAND, bound["handle_text"])
            )
            app.add_handler(
                MessageHandler(filters.VOICE & ~filters.COMMAND, bound["handle_voice"])
            )
            apps[spec.bot_id] = app
        return apps

    def check_readiness(self) -> tuple[bool, dict[str, Any]]:
        if self._pool is None:
            return False, {"worker_pool": "uninitialized", "active_bots": len(self._apps)}
        pool_ready, details = self._pool.is_ready()
        return pool_ready, {
            "deployment_profile": self._profile.mode,
            "active_bots": self.bot_ids,
            "worker_pool": details,
        }

    async def handle_webhook_update(
        self, bot_id: str, payload: dict[str, Any]
    ) -> bool:
        """Process an incoming Telegram webhook update for *bot_id* on a shared HTTP port."""
        app = self._apps.get(bot_id)
        if app is None:
            return False
        update = Update.de_json(payload, app.bot)
        if update is None:
            return False
        await app.process_update(update)
        return True

    async def run_polling(self, drain_timeout: float = 15.0) -> None:
        """Start shared WorkerPool, ObservabilityServer, and concurrent polling for all bots."""
        from bot import handlers
        from bot.http_client import close_client
        from bot.observability import ObservabilityServer, configure_otel_tracing
        from bot.redis_client import close_redis
        from bot.worker import WorkerPool

        configure_otel_tracing(OTEL_SERVICE_NAME, OTEL_ENABLED)
        pool = WorkerPool(
            num_workers=self._num_workers,
            max_queue_size=self._max_queue_size,
        )
        await pool.start()
        self._pool = pool
        handlers.worker_pool = pool

        if METRICS_PORT > 0:
            self._obs_server = ObservabilityServer(
                host=METRICS_HOST,
                port=METRICS_PORT,
                readiness_check=self.check_readiness,
                service_name=OTEL_SERVICE_NAME,
            )
            await self._obs_server.start()

        self._apps = self._build_applications()
        stop_event = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop_event.set)
            except (NotImplementedError, RuntimeError):
                pass

        started_apps: list[Application] = []
        try:
            for bot_id, app in self._apps.items():
                await app.initialize()
                await app.start()
                if app.updater is not None:
                    await app.updater.start_polling(allowed_updates=Update.ALL_TYPES)
                started_apps.append(app)
                logger.info(
                    "MultiBotManager started bot_id=%s (profile=%s, shared_workers=%d)",
                    bot_id,
                    self._profile.mode,
                    self._num_workers,
                )

            await stop_event.wait()
        finally:
            for app in reversed(started_apps):
                try:
                    if app.updater is not None and app.updater.running:
                        await app.updater.stop()
                    await app.stop()
                    await app.shutdown()
                except Exception:  # noqa: BLE001
                    logger.debug("Error shutting down bot app", exc_info=True)
            if self._obs_server is not None:
                await self._obs_server.stop()
                self._obs_server = None
            await pool.stop(drain_timeout=drain_timeout)
            await close_client()
            await close_redis()
