"""Tests for bounded multi-turn conversation memory (Issue #26)."""

import time
from unittest.mock import patch

from bot.memory import ConversationStore


def test_appends_and_truncates_by_max_turns():
    store = ConversationStore(max_turns=2)
    store.append_turn(1, "q1", "a1")
    store.append_turn(1, "q2", "a2")
    store.append_turn(1, "q3", "a3")

    history = store.get_history(1)
    assert [m["content"] for m in history] == ["q2", "a2", "q3", "a3"]


def test_evicts_least_recently_used_chat():
    store = ConversationStore(max_turns=2, max_chats=2)
    store.append_turn(1, "u1", "b1")
    store.append_turn(2, "u2", "b2")
    store.get_history(1)  # refresh chat 1
    store.append_turn(3, "u3", "b3")

    assert store.get_history(2) == []
    assert len(store.get_history(1)) == 2
    assert len(store.get_history(3)) == 2


def test_ttl_expiration_and_clear():
    store = ConversationStore(max_turns=3, ttl_sec=10.0)
    base = time.monotonic()
    with patch("bot.memory.time.monotonic", return_value=base):
        store.append_turn(10, "hi", "hello")
    with patch("bot.memory.time.monotonic", return_value=base + 15.0):
        assert store.get_history(10) == []

    store.append_turn(10, "again", "ok")
    assert store.clear(10) is True
    assert store.get_history(10) == []
