"""Anti-malicious-bot identification and behavioral defense for Telegram Bot runtimes.

Detects and mitigates:
1. Telegram bot accounts (``effective_user.is_bot is True``) attempting bot-to-bot loops.
2. High-frequency burst floods and machine-like low-jitter request cadences.
3. Identical duplicate message / voice-attachment spam floods.
4. Automated link-spam or unauthorized probing bursts.
5. Suspicious accounts via a lightweight single-use arithmetic human verification challenge
   (``/verify <answer>`` or direct numeric reply), escalating repeat failures into
   time-bounded quarantine.

All in-memory state is strictly bounded via LRU eviction so 1 vCPU / 1 GB RAM hosts
cannot suffer memory exhaustion from attacker user-ID rotation.
"""

from __future__ import annotations

import hashlib
import logging
import re
import secrets
import statistics
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Any

from bot.observability import metrics

logger = logging.getLogger(__name__)

_URL_RE = re.compile(r"https?://[^\s]+|t\.me/[^\s]+", re.IGNORECASE)
_VERIFY_CMD_RE = re.compile(r"^\s*(?:/verify(?:@[A-Za-z0-9_]+)?\s+)?(-?\d{1,4})\s*$")


@dataclass(frozen=True)
class BotGuardVerdict:
    """Outcome of evaluating an incoming Telegram update."""

    allowed: bool
    action: str  # "allow" | "challenge" | "block"
    risk_score: int
    reasons: tuple[str, ...] = ()
    message: str | None = None
    retry_after_sec: int = 0
    challenge_prompt: str | None = None


@dataclass
class _ChallengeState:
    expected_answer: int
    question: str
    expires_at: float
    attempts: int = 0


@dataclass
class _UserBehaviorState:
    timestamps: deque[float] = field(default_factory=lambda: deque(maxlen=20))
    payload_hashes: deque[tuple[float, str]] = field(default_factory=lambda: deque(maxlen=16))
    strikes: int = 0
    quarantine_until: float = 0.0
    verified_until: float = 0.0
    challenge: _ChallengeState | None = None
    last_seen: float = 0.0


class TelegramBotGuard:
    """Bounded in-memory anti-malicious-bot classifier & challenge manager."""

    def __init__(
        self,
        *,
        enabled: bool = True,
        challenge_threshold: int = 50,
        block_threshold: int = 80,
        quarantine_sec: int = 180,
        challenge_ttl_sec: int = 180,
        verified_ttl_sec: int = 1800,
        burst_window_sec: float = 12.0,
        burst_max_hits: int = 5,
        duplicate_window_sec: float = 30.0,
        duplicate_max_hits: int = 3,
        max_tracked_users: int = 1000,
    ) -> None:
        self.enabled = enabled
        self.challenge_threshold = max(10, challenge_threshold)
        self.block_threshold = max(self.challenge_threshold + 10, block_threshold)
        self.quarantine_sec = max(15, quarantine_sec)
        self.challenge_ttl_sec = max(30, challenge_ttl_sec)
        self.verified_ttl_sec = max(60, verified_ttl_sec)
        self.burst_window_sec = max(2.0, burst_window_sec)
        self.burst_max_hits = max(2, burst_max_hits)
        self.duplicate_window_sec = max(5.0, duplicate_window_sec)
        self.duplicate_max_hits = max(2, duplicate_max_hits)
        self.max_tracked_users = max(50, max_tracked_users)

        self._states: OrderedDict[tuple[str, int], _UserBehaviorState] = OrderedDict()
        self._blocked_total = 0
        self._challenged_total = 0
        self._verified_total = 0
        self._bot_account_rejected_total = 0

    def reset(self) -> None:
        """Clear all tracked state and local counters (useful for unit tests)."""
        self._states.clear()
        self._blocked_total = 0
        self._challenged_total = 0
        self._verified_total = 0
        self._bot_account_rejected_total = 0

    def _get_or_create_state(
        self, bot_id: str, user_id: int, now: float
    ) -> _UserBehaviorState:
        key = (bot_id, user_id)
        state = self._states.get(key)
        if state is not None:
            self._states.move_to_end(key)
            state.last_seen = now
            return state

        while len(self._states) >= self.max_tracked_users:
            self._states.popitem(last=False)

        state = _UserBehaviorState(last_seen=now)
        self._states[key] = state
        return state

    @staticmethod
    def _hash_payload(text: str, voice_fingerprint: str | None) -> str | None:
        if voice_fingerprint:
            raw = f"voice:{voice_fingerprint}"
        else:
            normalized = " ".join((text or "").strip().lower().split())
            if not normalized or normalized.startswith("/"):
                return None
            raw = f"text:{normalized[:512]}"
        return hashlib.sha256(raw.encode("utf-8", errors="ignore")).hexdigest()[:16]

    def _issue_challenge(self, state: _UserBehaviorState, now: float) -> str:
        a = secrets.randbelow(18) + 4  # 4..21
        b = secrets.randbelow(14) + 3  # 3..16
        use_add = secrets.randbelow(2) == 0
        if use_add:
            answer = a + b
            question = f"{a} + {b} = ?"
        else:
            hi, lo = max(a, b) + 2, min(a, b)
            answer = hi - lo
            question = f"{hi} - {lo} = ?"
        state.challenge = _ChallengeState(
            expected_answer=answer,
            question=question,
            expires_at=now + self.challenge_ttl_sec,
            attempts=0,
        )
        return question

    def has_pending_challenge(
        self, bot_id: str, user_id: int, *, now: float | None = None
    ) -> bool:
        t = time.monotonic() if now is None else now
        state = self._states.get((bot_id, user_id))
        if state is None or state.challenge is None:
            return False
        if t >= state.challenge.expires_at:
            state.challenge = None
            return False
        return True

    def verify_challenge(
        self,
        bot_id: str,
        user_id: int,
        raw_text: str,
        *,
        now: float | None = None,
    ) -> tuple[bool, str]:
        """Validate a user's answer to an active human-verification challenge."""
        t = time.monotonic() if now is None else now
        state = self._states.get((bot_id, user_id))
        if state is None or state.challenge is None:
            return False, "目前沒有待完成的人機驗證題目，可以直接發送訊息。"

        if t >= state.challenge.expires_at:
            question = self._issue_challenge(state, t)
            return (
                False,
                f"驗證題目已過期，請重新回答新題目：{question}（直接回覆數字或輸入 /verify 答案）",
            )

        match = _VERIFY_CMD_RE.match(raw_text or "")
        if not match:
            return (
                False,
                f"請先完成人機驗證：{state.challenge.question}（直接回覆數字或輸入 /verify 答案）",
            )

        try:
            submitted = int(match.group(1))
        except ValueError:
            return False, f"請輸入整數答案：{state.challenge.question}"

        if submitted == state.challenge.expected_answer:
            state.challenge = None
            state.strikes = 0
            state.timestamps.clear()
            state.payload_hashes.clear()
            state.verified_until = t + self.verified_ttl_sec
            self._verified_total += 1
            return True, "人機驗證通過！你可以繼續正常使用語音與文字對話。"

        state.challenge.attempts += 1
        if state.challenge.attempts >= 3:
            state.challenge = None
            state.strikes += 1
            quarantine = min(self.quarantine_sec * max(1, state.strikes), 3600)
            state.quarantine_until = t + quarantine
            self._blocked_total += 1
            metrics.bot_guard_blocked_total.inc()
            return (
                False,
                f"驗證連續錯誤次數過多，系統已暫時限制存取 {quarantine} 秒以防範惡意機器人。",
            )

        remaining = 3 - state.challenge.attempts
        return (
            False,
            f"驗證答案不正確（剩餘 {remaining} 次機會），請再試一次：{state.challenge.question}",
        )

    def record_unauthorized_hit(
        self, bot_id: str, user_id: int, *, now: float | None = None
    ) -> None:
        """Track repeated unauthorized probing so scanners get quarantined cleanly."""
        if not self.enabled:
            return
        t = time.monotonic() if now is None else now
        state = self._get_or_create_state(bot_id, user_id, t)
        state.timestamps.append(t)
        recent = [ts for ts in state.timestamps if t - ts <= self.burst_window_sec]
        if len(recent) >= self.burst_max_hits:
            state.strikes += 1
            quarantine = min(self.quarantine_sec * state.strikes, 3600)
            state.quarantine_until = t + quarantine
            self._blocked_total += 1
            metrics.bot_guard_blocked_total.inc()

    def evaluate_update(
        self,
        update: Any,
        *,
        bot_id: str = "default",
        text: str = "",
        voice_fingerprint: str | None = None,
        now: float | None = None,
    ) -> BotGuardVerdict:
        """Evaluate an incoming Telegram update for malicious-bot signals."""
        if not self.enabled:
            return BotGuardVerdict(allowed=True, action="allow", risk_score=0)

        t = time.monotonic() if now is None else now
        user = getattr(update, "effective_user", None)
        if user is None:
            return BotGuardVerdict(allowed=True, action="allow", risk_score=0)

        # 1. Hard reject automated Telegram bot accounts (prevents bot-to-bot amplification)
        if getattr(user, "is_bot", False) is True:
            self._blocked_total += 1
            self._bot_account_rejected_total += 1
            metrics.bot_guard_blocked_total.inc()
            logger.warning(
                "BotGuard blocked Telegram bot account (bot_id=%s, sender_id=%s)",
                bot_id,
                getattr(user, "id", "unknown"),
            )
            return BotGuardVerdict(
                allowed=False,
                action="block",
                risk_score=100,
                reasons=("telegram_bot_account",),
                message="系統已攔截自動化機器人帳號的存取請求。",
            )

        user_id = getattr(user, "id", None)
        if not isinstance(user_id, int):
            return BotGuardVerdict(allowed=True, action="allow", risk_score=0)

        state = self._get_or_create_state(bot_id, user_id, t)

        # 2. Active quarantine check
        if state.quarantine_until > t:
            retry_after = max(1, int(state.quarantine_until - t))
            self._blocked_total += 1
            metrics.bot_guard_blocked_total.inc()
            return BotGuardVerdict(
                allowed=False,
                action="block",
                risk_score=100,
                reasons=("quarantined",),
                retry_after_sec=retry_after,
                message=f"偵測到異常高頻自動化行為，已暫時封鎖請求，請於 {retry_after} 秒後再試。",
            )

        # 3. Pending human verification challenge gate
        if state.challenge is not None:
            if t < state.challenge.expires_at:
                return BotGuardVerdict(
                    allowed=False,
                    action="challenge",
                    risk_score=self.challenge_threshold,
                    reasons=("pending_challenge",),
                    challenge_prompt=state.challenge.question,
                    message=(
                        f"請先完成人機驗證以確認非惡意機器人：{state.challenge.question}\n"
                        "請直接回覆答案數字，或輸入 /verify 答案。"
                    ),
                )
            state.challenge = None

        # 4. Record arrival timestamp & payload fingerprint
        state.timestamps.append(t)
        payload_hash = self._hash_payload(text, voice_fingerprint)
        if payload_hash is not None:
            state.payload_hashes.append((t, payload_hash))

        risk_score = 0
        reasons: list[str] = []

        # 4a. Burst velocity scoring
        recent_hits = [ts for ts in state.timestamps if t - ts <= self.burst_window_sec]
        if len(recent_hits) >= self.burst_max_hits + 3:
            risk_score += 80
            reasons.append("severe_burst_flood")
        elif len(recent_hits) >= self.burst_max_hits:
            risk_score += 50
            reasons.append("burst_velocity")

        # 4b. Low-jitter robotic cadence detection (constant inter-arrival intervals)
        if len(recent_hits) >= 5:
            intervals = [
                recent_hits[i] - recent_hits[i - 1]
                for i in range(1, len(recent_hits))
                if recent_hits[i] >= recent_hits[i - 1]
            ]
            if len(intervals) >= 4:
                mean_iv = statistics.fmean(intervals)
                stdev_iv = statistics.pstdev(intervals)
                if mean_iv <= 3.0 and stdev_iv < 0.08:
                    risk_score += 45
                    reasons.append("robotic_cadence")

        # 4c. Duplicate payload flood detection
        if payload_hash is not None:
            same_count = sum(
                1
                for ts, digest in state.payload_hashes
                if (t - ts) <= self.duplicate_window_sec and digest == payload_hash
            )
            if same_count >= self.duplicate_max_hits + 2:
                risk_score += 80
                reasons.append("severe_duplicate_flood")
            elif same_count >= self.duplicate_max_hits:
                risk_score += 50
                reasons.append("duplicate_payload_flood")

        # 4d. Multi-URL spam heuristic
        if text and len(_URL_RE.findall(text)) >= 3:
            risk_score += 40
            reasons.append("multi_url_spam")

        # 4e. Escalate repeat offenders slightly faster
        if state.strikes > 0 and risk_score > 0:
            risk_score += min(30, state.strikes * 15)
            reasons.append("repeat_offender")

        # Recently verified humans get a modest grace discount unless severely flooding
        if state.verified_until > t and risk_score < self.block_threshold:
            risk_score = max(0, risk_score - 25)

        if risk_score >= self.block_threshold:
            state.strikes += 1
            quarantine = min(self.quarantine_sec * state.strikes, 3600)
            state.quarantine_until = t + quarantine
            state.challenge = None
            self._blocked_total += 1
            metrics.bot_guard_blocked_total.inc()
            logger.warning(
                "BotGuard quarantined user (bot_id=%s, user_id=%d, score=%d, reasons=%s, quarantine_sec=%d)",
                bot_id,
                user_id,
                risk_score,
                ",".join(reasons),
                quarantine,
            )
            return BotGuardVerdict(
                allowed=False,
                action="block",
                risk_score=risk_score,
                reasons=tuple(reasons),
                retry_after_sec=quarantine,
                message=f"偵測到異常自動化或洗版行為，系統已暫時限制存取 {quarantine} 秒。",
            )

        if risk_score >= self.challenge_threshold:
            question = self._issue_challenge(state, t)
            self._challenged_total += 1
            metrics.bot_guard_challenged_total.inc()
            logger.info(
                "BotGuard issued human challenge (bot_id=%s, user_id=%d, score=%d, reasons=%s)",
                bot_id,
                user_id,
                risk_score,
                ",".join(reasons),
            )
            return BotGuardVerdict(
                allowed=False,
                action="challenge",
                risk_score=risk_score,
                reasons=tuple(reasons),
                challenge_prompt=question,
                message=(
                    f"系統偵測到疑似機器人行為，請先完成人機驗證：{question}\n"
                    "請直接回覆答案數字，或輸入 /verify 答案。"
                ),
            )

        return BotGuardVerdict(
            allowed=True,
            action="allow",
            risk_score=risk_score,
            reasons=tuple(reasons),
        )

    def get_stats(self) -> dict[str, Any]:
        now = time.monotonic()
        active_quarantines = sum(
            1 for s in self._states.values() if s.quarantine_until > now
        )
        pending_challenges = sum(
            1
            for s in self._states.values()
            if s.challenge is not None and s.challenge.expires_at > now
        )
        return {
            "enabled": self.enabled,
            "trackedUsers": len(self._states),
            "maxTrackedUsers": self.max_tracked_users,
            "blockedTotal": self._blocked_total,
            "challengedTotal": self._challenged_total,
            "verifiedTotal": self._verified_total,
            "botAccountRejectedTotal": self._bot_account_rejected_total,
            "activeQuarantines": active_quarantines,
            "pendingChallenges": pending_challenges,
        }


def _create_default_guard() -> TelegramBotGuard:
    from bot.config import (
        BOT_GUARD_BLOCK_THRESHOLD,
        BOT_GUARD_CHALLENGE_THRESHOLD,
        BOT_GUARD_ENABLED,
        BOT_GUARD_QUARANTINE_SEC,
    )

    return TelegramBotGuard(
        enabled=BOT_GUARD_ENABLED,
        challenge_threshold=BOT_GUARD_CHALLENGE_THRESHOLD,
        block_threshold=BOT_GUARD_BLOCK_THRESHOLD,
        quarantine_sec=BOT_GUARD_QUARANTINE_SEC,
    )


default_bot_guard = _create_default_guard()
