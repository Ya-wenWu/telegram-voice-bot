"""Shared httpx.AsyncClient lifecycle for outbound HTTP calls.

Centralizes client creation and cleanup so that multiple modules
(opencode_client, whisper) don't each maintain their own duplicate client.
"""

import logging

import httpx

logger = logging.getLogger(__name__)

_client: httpx.AsyncClient | None = None


def get_client(timeout: float = 120.0) -> httpx.AsyncClient:
    """Return a shared httpx.AsyncClient, creating it lazily on first use."""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=timeout)
    return _client


async def close_client() -> None:
    """Close the shared httpx.AsyncClient if it exists."""
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None
