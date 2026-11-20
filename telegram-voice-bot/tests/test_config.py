import logging

from bot.config import _parse_user_ids, get_positive_int


def test_parses_comma_separated_ids():
    assert _parse_user_ids("123, 456,789") == [123, 456, 789]


def test_empty_string_means_nobody():
    assert _parse_user_ids("") == []
    assert _parse_user_ids(" , ,") == []


def test_invalid_entries_are_skipped_not_fatal(caplog):
    with caplog.at_level(logging.WARNING, logger="bot.config"):
        assert _parse_user_ids("123,abc,456") == [123, 456]
    assert "abc" in caplog.text


def test_get_positive_int_handles_empty_invalid_and_non_positive(monkeypatch):
    monkeypatch.setenv("TEST_POS_INT", "")
    assert get_positive_int("TEST_POS_INT", 3) == 3

    monkeypatch.setenv("TEST_POS_INT", "not-a-number")
    assert get_positive_int("TEST_POS_INT", 3) == 3

    monkeypatch.setenv("TEST_POS_INT", "0")
    assert get_positive_int("TEST_POS_INT", 3) == 3

    monkeypatch.setenv("TEST_POS_INT", "-5")
    assert get_positive_int("TEST_POS_INT", 3) == 3

    monkeypatch.setenv("TEST_POS_INT", "4")
    assert get_positive_int("TEST_POS_INT", 3) == 4
