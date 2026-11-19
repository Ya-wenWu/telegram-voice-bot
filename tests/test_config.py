import logging

from bot.config import _parse_user_ids


def test_parses_comma_separated_ids():
    assert _parse_user_ids("123, 456,789") == [123, 456, 789]


def test_empty_string_means_nobody():
    assert _parse_user_ids("") == []
    assert _parse_user_ids(" , ,") == []


def test_invalid_entries_are_skipped_not_fatal(caplog):
    with caplog.at_level(logging.WARNING, logger="bot.config"):
        assert _parse_user_ids("123,abc,456") == [123, 456]
    assert "abc" in caplog.text
