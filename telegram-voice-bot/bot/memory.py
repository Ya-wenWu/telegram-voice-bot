"""Bounded in-memory multi-turn conversation history (Zero-OOM safe)."""

import time
from collections import OrderedDict
from dataclasses import dataclass, field

MAX_STORED_MSG_CHARS = 2000


@dataclass
class _ChatHistory:
    messages: list[dict[str, str]] = field(default_factory=list)
    updated_at: float = field(default_factory=time.monotonic)


ChatKey = int | str


class ConversationStore:
    """LRU + TTL bounded per-chat conversation history (supports single and multi-bot keys)."""

    def __init__(
        self,
        *,
        max_turns: int = 6,
        max_chats: int = 100,
        ttl_sec: float = 3600.0,
    ) -> None:
        self._max_turns = max(0, max_turns)
        self._max_chats = max(1, max_chats)
        self._ttl_sec = max(1.0, ttl_sec)
        self._chats: OrderedDict[ChatKey, _ChatHistory] = OrderedDict()

    def configure(
        self, *, max_turns: int | None = None, ttl_sec: float | None = None
    ) -> None:
        if max_turns is not None:
            self._max_turns = max(0, max_turns)
            if self._max_turns == 0:
                self._chats.clear()
            else:
                limit = self._max_turns * 2
                for entry in self._chats.values():
                    if len(entry.messages) > limit:
                        entry.messages = entry.messages[-limit:]
        if ttl_sec is not None:
            self._ttl_sec = max(1.0, ttl_sec)

    def _evict_expired(self, now: float) -> None:
        expired = [
            cid
            for cid, entry in self._chats.items()
            if now - entry.updated_at > self._ttl_sec
        ]
        for cid in expired:
            del self._chats[cid]

    def get_history(self, chat_id: ChatKey) -> list[dict[str, str]]:
        if self._max_turns <= 0:
            return []
        now = time.monotonic()
        self._evict_expired(now)
        entry = self._chats.get(chat_id)
        if entry is None:
            return []
        self._chats.move_to_end(chat_id)
        return list(entry.messages)

    def append_turn(self, chat_id: ChatKey, user_text: str, assistant_text: str) -> None:
        if self._max_turns <= 0:
            return
        now = time.monotonic()
        self._evict_expired(now)
        entry = self._chats.get(chat_id)
        if entry is None:
            entry = _ChatHistory()
            self._chats[chat_id] = entry
        entry.messages.append(
            {"role": "user", "content": (user_text or "")[:MAX_STORED_MSG_CHARS]}
        )
        entry.messages.append(
            {
                "role": "assistant",
                "content": (assistant_text or "")[:MAX_STORED_MSG_CHARS],
            }
        )
        limit = self._max_turns * 2
        if len(entry.messages) > limit:
            entry.messages = entry.messages[-limit:]
        entry.updated_at = now
        self._chats.move_to_end(chat_id)
        while len(self._chats) > self._max_chats:
            self._chats.popitem(last=False)

    def clear(self, chat_id: ChatKey) -> bool:
        return self._chats.pop(chat_id, None) is not None

    def clear_all(self) -> None:
        self._chats.clear()

    def stats(self) -> dict[str, int]:
        self._evict_expired(time.monotonic())
        return {
            "active_chats": len(self._chats),
            "total_messages": sum(len(e.messages) for e in self._chats.values()),
            "max_turns": self._max_turns,
        }
