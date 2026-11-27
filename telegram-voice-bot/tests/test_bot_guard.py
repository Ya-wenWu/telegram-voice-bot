"""Unit tests for anti-malicious-bot identification and human challenge guard."""

from __future__ import annotations

import asyncio
import re
from types import SimpleNamespace
from unittest.mock import AsyncMock

from bot import handlers
from bot.bot_guard import TelegramBotGuard


def _make_update(
    user_id: int,
    *,
    is_bot: bool = False,
    text: str = "hello",
    chat_id: int = 1001,
    message_id: int = 1,
):
    reply_text = AsyncMock()
    return SimpleNamespace(
        update_id=message_id,
        effective_user=SimpleNamespace(id=user_id, is_bot=is_bot),
        effective_chat=SimpleNamespace(id=chat_id),
        message=SimpleNamespace(
            message_id=message_id,
            text=text,
            voice=None,
            reply_text=reply_text,
        ),
    )


def _solve_math(question: str) -> int:
    m = re.match(r"^\s*(\d+)\s*([+-])\s*(\d+)\s*=\s*\?\s*$", question)
    assert m is not None, f"Unexpected challenge format: {question}"
    a, op, b = int(m.group(1)), m.group(2), int(m.group(3))
    return a + b if op == "+" else a - b


def test_rejects_telegram_bot_account_immediately():
    guard = TelegramBotGuard()
    bot_update = _make_update(777, is_bot=True, text="hi")
    verdict = guard.evaluate_update(bot_update, bot_id="default", text="hi", now=100.0)
    assert not verdict.allowed
    assert verdict.action == "block"
    assert "telegram_bot_account" in verdict.reasons
    assert guard.get_stats()["botAccountRejectedTotal"] == 1


def test_normal_human_messages_pass_without_friction():
    guard = TelegramBotGuard()
    for idx, msg in enumerate(["你好", "請問天氣如何？", "幫我解釋 async await"]):
        upd = _make_update(123456, is_bot=False, text=msg)
        verdict = guard.evaluate_update(
            upd, bot_id="default", text=msg, now=100.0 + idx * 5.2
        )
        assert verdict.allowed
        assert verdict.action == "allow"


def test_duplicate_flood_triggers_challenge_and_verify_unlocks():
    guard = TelegramBotGuard()
    upd = _make_update(123456, is_bot=False, text="buy cheap crypto now")

    v1 = guard.evaluate_update(
        upd, bot_id="default", text="buy cheap crypto now", now=10.0
    )
    v2 = guard.evaluate_update(
        upd, bot_id="default", text="buy cheap crypto now", now=14.0
    )
    v3 = guard.evaluate_update(
        upd, bot_id="default", text="buy cheap crypto now", now=18.0
    )

    assert v1.allowed
    assert v2.allowed
    assert not v3.allowed
    assert v3.action == "challenge"
    assert "duplicate_payload_flood" in v3.reasons
    assert v3.challenge_prompt is not None
    assert guard.has_pending_challenge("default", 123456, now=19.0)

    answer = _solve_math(v3.challenge_prompt)
    ok, msg = guard.verify_challenge("default", 123456, f"/verify {answer}", now=20.0)
    assert ok
    assert "通過" in msg
    assert not guard.has_pending_challenge("default", 123456, now=21.0)

    v_after = guard.evaluate_update(
        _make_update(123456, is_bot=False, text="正常提問"),
        bot_id="default",
        text="正常提問",
        now=25.0,
    )
    assert v_after.allowed


def test_wrong_challenge_attempts_escalate_to_quarantine():
    guard = TelegramBotGuard(quarantine_sec=120)
    upd = _make_update(2020, is_bot=False, text="spam")
    for idx in range(3):
        verdict = guard.evaluate_update(
            upd, bot_id="default", text="spam", now=50.0 + idx * 3.0
        )
    assert verdict.action == "challenge"
    assert verdict.challenge_prompt is not None
    wrong = _solve_math(verdict.challenge_prompt) + 99

    ok1, _ = guard.verify_challenge("default", 2020, str(wrong), now=60.0)
    ok2, _ = guard.verify_challenge("default", 2020, str(wrong), now=61.0)
    ok3, msg3 = guard.verify_challenge("default", 2020, str(wrong), now=62.0)
    assert not ok1 and not ok2 and not ok3
    assert "限制存取" in msg3

    blocked = guard.evaluate_update(upd, bot_id="default", text="hello", now=65.0)
    assert not blocked.allowed
    assert blocked.action == "block"
    assert "quarantined" in blocked.reasons


def test_robotic_burst_triggers_quarantine():
    guard = TelegramBotGuard(quarantine_sec=60)
    verdict = None
    # Constant 0.5s intervals (zero jitter) + burst velocity triggers on 5th hit
    for i in range(5):
        upd = _make_update(3030, is_bot=False, text=f"probe-{i}")
        verdict = guard.evaluate_update(
            upd, bot_id="default", text=f"probe-{i}", now=200.0 + i * 0.5
        )
    assert verdict is not None
    assert not verdict.allowed
    assert verdict.action == "block"
    assert "robotic_cadence" in verdict.reasons

    follow_up = guard.evaluate_update(
        _make_update(3030, is_bot=False, text="probe-5"),
        bot_id="default",
        text="probe-5",
        now=202.5,
    )
    assert not follow_up.allowed
    assert "quarantined" in follow_up.reasons


def test_bounded_lru_prevents_memory_exhaustion():
    guard = TelegramBotGuard(max_tracked_users=50)
    for uid in range(1, 200):
        upd = _make_update(uid, is_bot=False, text="hi")
        guard.evaluate_update(upd, bot_id="default", text="hi", now=10.0 + uid * 0.1)
    assert guard.get_stats()["trackedUsers"] <= 50


def test_handler_blocks_telegram_bot_account_before_allowlist():
    async def _run():
        original_guard = handlers.bot_guard
        handlers.bot_guard = TelegramBotGuard()
        try:
            bound = handlers.create_bound_handlers(
                bot_id="test-guard", allowed_user_ids=(123456,)
            )
            bot_upd = _make_update(123456, is_bot=True, text="hello")
            ctx = SimpleNamespace(bot=SimpleNamespace())
            await bound["handle_text"](bot_upd, ctx)
            bot_upd.message.reply_text.assert_awaited_once()
            replied = bot_upd.message.reply_text.await_args.args[0]
            assert "機器人帳號" in replied
        finally:
            handlers.bot_guard = original_guard

    asyncio.run(_run())
