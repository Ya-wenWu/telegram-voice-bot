"""Observability primitives: Prometheus metrics, health/readiness server, JSON logging, and tracing.

Zero-dependency standard-library implementation with optional OpenTelemetry SDK bridging
when ``opentelemetry-api`` is installed and ``OTEL_ENABLED=true``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import secrets
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from bot.logging_context import req_id_var, span_id_var, trace_id_var

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Prometheus Metrics (text exposition format v0.0.4)
# ---------------------------------------------------------------------------

DEFAULT_TTS_BUCKETS: tuple[float, ...] = (
    0.01,
    0.05,
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
    30.0,
)
DEFAULT_REQUEST_BUCKETS: tuple[float, ...] = (
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
    20.0,
    30.0,
    60.0,
)


class Counter:
    """Thread-safe Prometheus counter."""

    def __init__(self, name: str, help_text: str) -> None:
        self.name = name
        self.help_text = help_text
        self._lock = threading.Lock()
        self._value = 0.0

    def inc(self, amount: float = 1.0) -> None:
        if amount < 0:
            raise ValueError("Counter increment must be non-negative")
        with self._lock:
            self._value += amount

    def get(self) -> float:
        with self._lock:
            return self._value

    def reset(self) -> None:
        with self._lock:
            self._value = 0.0

    def render(self) -> list[str]:
        val = self.get()
        formatted = str(int(val)) if val.is_integer() else f"{val:.6g}"
        return [
            f"# HELP {self.name} {self.help_text}",
            f"# TYPE {self.name} counter",
            f"{self.name} {formatted}",
        ]


class Gauge:
    """Thread-safe Prometheus gauge."""

    def __init__(self, name: str, help_text: str) -> None:
        self.name = name
        self.help_text = help_text
        self._lock = threading.Lock()
        self._value = 0.0

    def set(self, value: float) -> None:
        with self._lock:
            self._value = float(value)

    def inc(self, amount: float = 1.0) -> None:
        with self._lock:
            self._value += amount

    def dec(self, amount: float = 1.0) -> None:
        with self._lock:
            self._value = max(0.0, self._value - amount)

    def get(self) -> float:
        with self._lock:
            return self._value

    def reset(self) -> None:
        with self._lock:
            self._value = 0.0

    def render(self) -> list[str]:
        val = self.get()
        formatted = str(int(val)) if val.is_integer() else f"{val:.6g}"
        return [
            f"# HELP {self.name} {self.help_text}",
            f"# TYPE {self.name} gauge",
            f"{self.name} {formatted}",
        ]


class Histogram:
    """Thread-safe Prometheus histogram."""

    def __init__(
        self,
        name: str,
        help_text: str,
        buckets: tuple[float, ...] = DEFAULT_TTS_BUCKETS,
    ) -> None:
        self.name = name
        self.help_text = help_text
        self._bounds = tuple(sorted(buckets))
        self._lock = threading.Lock()
        self._bucket_counts = [0 for _ in self._bounds]
        self._count = 0
        self._sum = 0.0

    def observe(self, value: float) -> None:
        if math.isnan(value) or value < 0:
            return
        with self._lock:
            self._count += 1
            self._sum += value
            for idx, bound in enumerate(self._bounds):
                if value <= bound:
                    self._bucket_counts[idx] += 1

    def snapshot(self) -> tuple[list[tuple[float, int]], int, float]:
        with self._lock:
            pairs = list(zip(self._bounds, self._bucket_counts, strict=True))
            return pairs, self._count, self._sum

    def reset(self) -> None:
        with self._lock:
            self._bucket_counts = [0 for _ in self._bounds]
            self._count = 0
            self._sum = 0.0

    def render(self) -> list[str]:
        pairs, count, total = self.snapshot()
        lines = [
            f"# HELP {self.name} {self.help_text}",
            f"# TYPE {self.name} histogram",
        ]
        for bound, bucket_count in pairs:
            lines.append(f'{self.name}_bucket{{le="{bound:g}"}} {bucket_count}')
        lines.append(f'{self.name}_bucket{{le="+Inf"}} {count}')
        lines.append(f"{self.name}_sum {total:.6f}")
        lines.append(f"{self.name}_count {count}")
        return lines


class MetricsRegistry:
    """Central registry holding all Prometheus metrics for the bot."""

    def __init__(self) -> None:
        self.queue_depth = Gauge(
            "queue_depth",
            "Current number of pending tasks waiting in the worker queue.",
        )
        self.tts_wait_seconds = Histogram(
            "tts_wait_seconds",
            "TTS semaphore wait and synthesis duration in seconds.",
            buckets=DEFAULT_TTS_BUCKETS,
        )
        self.ffmpeg_queue_length = Gauge(
            "ffmpeg_queue_length",
            "Current number of tasks waiting for or running ffmpeg audio processing.",
        )
        self.request_duration_seconds = Histogram(
            "request_duration_seconds",
            "End-to-end request processing latency from handler to reply in seconds.",
            buckets=DEFAULT_REQUEST_BUCKETS,
        )
        self.redis_failures_total = Counter(
            "redis_failures_total",
            "Total number of Redis operation failures (fail-open / local-fallback events).",
        )
        self.redis_semaphore_wait_seconds = Histogram(
            "redis_semaphore_wait_seconds",
            "Time spent waiting to acquire a distributed/local resource semaphore in seconds.",
            buckets=DEFAULT_TTS_BUCKETS,
        )
        self.redis_semaphore_rejected_total = Counter(
            "redis_semaphore_rejected_total",
            "Total number of resource calls rejected after semaphore acquire timeout.",
        )
        self.bot_guard_blocked_total = Counter(
            "bot_guard_blocked_total",
            "Total number of malicious or automated bot requests blocked by BotGuard.",
        )
        self.bot_guard_challenged_total = Counter(
            "bot_guard_challenged_total",
            "Total number of suspicious requests challenged for human verification.",
        )

    def reset(self) -> None:
        self.queue_depth.reset()
        self.tts_wait_seconds.reset()
        self.ffmpeg_queue_length.reset()
        self.request_duration_seconds.reset()
        self.redis_failures_total.reset()
        self.redis_semaphore_wait_seconds.reset()
        self.redis_semaphore_rejected_total.reset()
        self.bot_guard_blocked_total.reset()
        self.bot_guard_challenged_total.reset()

    def render_prometheus(self) -> str:
        sections: list[str] = []
        for metric in (
            self.queue_depth,
            self.tts_wait_seconds,
            self.ffmpeg_queue_length,
            self.request_duration_seconds,
            self.redis_failures_total,
            self.redis_semaphore_wait_seconds,
            self.redis_semaphore_rejected_total,
            self.bot_guard_blocked_total,
            self.bot_guard_challenged_total,
        ):
            sections.append("\n".join(metric.render()))
        return "\n\n".join(sections) + "\n"


metrics = MetricsRegistry()


# ---------------------------------------------------------------------------
# OpenTelemetry-compatible Distributed Tracing (W3C TraceContext)
# ---------------------------------------------------------------------------


def _new_trace_id() -> str:
    return secrets.token_hex(16)


def _new_span_id() -> str:
    return secrets.token_hex(8)


@dataclass
class SpanRecord:
    """Recorded span linking handler -> queue -> worker -> TTS -> reply."""

    name: str
    trace_id: str
    span_id: str
    parent_span_id: str | None
    start_time_ns: int
    end_time_ns: int = 0
    attributes: dict[str, Any] = field(default_factory=dict)
    status: str = "OK"
    error: str | None = None

    def set_attribute(self, key: str, value: Any) -> None:
        self.attributes[key] = value

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "parent_span_id": self.parent_span_id,
            "duration_ms": round(
                max(0, self.end_time_ns - self.start_time_ns) / 1_000_000, 3
            ),
            "status": self.status,
            "error": self.error,
            "attributes": dict(self.attributes),
        }


_RECENT_SPANS_MAX = 200
_recent_spans: deque[SpanRecord] = deque(maxlen=_RECENT_SPANS_MAX)
_spans_lock = threading.Lock()
_otel_tracer: Any = None
_otel_initialized = False


def configure_otel_tracing(service_name: str, enabled: bool) -> bool:
    """Optionally attach an OpenTelemetry TracerProvider when SDK is installed."""
    global _otel_tracer, _otel_initialized
    if not enabled:
        _otel_tracer = None
        _otel_initialized = False
        return False
    if _otel_initialized:
        return _otel_tracer is not None
    _otel_initialized = True
    try:
        from opentelemetry import trace as otel_trace  # type: ignore[import-not-found]

        _otel_tracer = otel_trace.get_tracer(service_name)
        logger.info("OpenTelemetry tracer enabled for service=%s", service_name)
        return True
    except ImportError:
        logger.info(
            "OpenTelemetry SDK not installed; using built-in W3C trace/span propagation"
        )
        _otel_tracer = None
        return False


def get_recent_spans(trace_id: str | None = None) -> list[SpanRecord]:
    """Return recently completed spans, optionally filtered by *trace_id*."""
    with _spans_lock:
        if trace_id is None:
            return list(_recent_spans)
        return [s for s in _recent_spans if s.trace_id == trace_id]


def clear_recent_spans() -> None:
    with _spans_lock:
        _recent_spans.clear()


@contextmanager
def start_span(
    name: str,
    *,
    attributes: dict[str, Any] | None = None,
    parent_trace_id: str | None = None,
    parent_span_id: str | None = None,
) -> Iterator[SpanRecord]:
    """Start a traced span, updating ``trace_id_var`` and ``span_id_var`` ContextVars.

    Supports cross-queue context propagation by passing ``parent_trace_id`` and
    ``parent_span_id`` stored on queued tasks.
    """
    current_trace = trace_id_var.get()
    current_span = span_id_var.get()

    resolved_trace = (
        parent_trace_id
        if parent_trace_id and parent_trace_id != "-"
        else (current_trace if current_trace != "-" else _new_trace_id())
    )
    resolved_parent = (
        parent_span_id
        if parent_span_id and parent_span_id != "-"
        else (current_span if current_span != "-" else None)
    )
    span_id = _new_span_id()

    record = SpanRecord(
        name=name,
        trace_id=resolved_trace,
        span_id=span_id,
        parent_span_id=resolved_parent,
        start_time_ns=time.time_ns(),
        attributes=dict(attributes or {}),
    )

    otel_cm = None
    otel_span = None
    if _otel_tracer is not None:
        try:
            otel_cm = _otel_tracer.start_as_current_span(name)
            otel_span = otel_cm.__enter__()
            for k, v in record.attributes.items():
                otel_span.set_attribute(k, v)
            ctx = otel_span.get_span_context()
            if getattr(ctx, "trace_id", 0):
                record.trace_id = f"{ctx.trace_id:032x}"
            if getattr(ctx, "span_id", 0):
                record.span_id = f"{ctx.span_id:016x}"
        except Exception:  # noqa: BLE001 - tracing must never break bot requests
            otel_cm = None
            otel_span = None

    t_tok = trace_id_var.set(record.trace_id)
    s_tok = span_id_var.set(record.span_id)
    try:
        yield record
    except BaseException as exc:
        record.status = "ERROR"
        record.error = f"{type(exc).__name__}: {exc}"
        if otel_span is not None:
            try:
                otel_span.record_exception(exc)
            except Exception as otel_err:  # noqa: BLE001
                logger.debug(
                    "OTel record_exception failed: %s", type(otel_err).__name__
                )
        raise
    finally:
        record.end_time_ns = time.time_ns()
        if otel_span is not None:
            try:
                for k, v in record.attributes.items():
                    otel_span.set_attribute(k, v)
            except Exception as otel_err:  # noqa: BLE001
                logger.debug("OTel set_attribute failed: %s", type(otel_err).__name__)
        if otel_cm is not None:
            try:
                otel_cm.__exit__(None, None, None)
            except Exception as otel_err:  # noqa: BLE001
                logger.debug("OTel span close failed: %s", type(otel_err).__name__)
        trace_id_var.reset(t_tok)
        span_id_var.reset(s_tok)
        with _spans_lock:
            _recent_spans.append(record)


# ---------------------------------------------------------------------------
# Structured JSON Formatter with Secret Redaction
# ---------------------------------------------------------------------------

MIN_SECRET_LEN = 6


class JsonTokenRedactingFormatter(logging.Formatter):
    """Structured JSON log formatter containing trace_id, span_id, req_id, and secret redaction."""

    def __init__(self, tokens: list[str] | None = None) -> None:
        super().__init__()
        self._tokens = sorted(
            {t for t in (tokens or []) if t and len(t) >= MIN_SECRET_LEN},
            key=len,
            reverse=True,
        )

    def _redact(self, text: str) -> str:
        for token in self._tokens:
            if token in text:
                text = text.replace(token, "***REDACTED***")
        return text

    def format(self, record: logging.LogRecord) -> str:
        req_id = getattr(record, "req_id", req_id_var.get())
        trace_id = getattr(record, "trace_id", trace_id_var.get())
        span_id = getattr(record, "span_id", span_id_var.get())

        message = self._redact(record.getMessage())
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": message,
            "req_id": req_id,
            "trace_id": trace_id,
            "span_id": span_id,
        }
        if record.exc_info:
            payload["exception"] = self._redact(self.formatException(record.exc_info))
        return json.dumps(payload, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Async HTTP Server for /health, /ready, and /metrics
# ---------------------------------------------------------------------------

ReadinessCheck = Callable[[], tuple[bool, dict[str, Any]]]


class ObservabilityServer:
    """Lightweight asyncio HTTP/1.1 server exposing /health, /ready, and /metrics."""

    def __init__(
        self,
        *,
        host: str = "127.0.0.1",
        port: int = 9090,
        readiness_check: ReadinessCheck | None = None,
        registry: MetricsRegistry = metrics,
        service_name: str = "telegram-voice-bot",
    ) -> None:
        self._host = host
        self._port = port
        self._readiness_check = readiness_check
        self._registry = registry
        self._service_name = service_name
        self._started_at = time.monotonic()
        self._server: asyncio.Server | None = None

    @property
    def bound_port(self) -> int | None:
        if self._server is None or not self._server.sockets:
            return None
        sockname = self._server.sockets[0].getsockname()
        return int(sockname[1])

    async def start(self) -> None:
        self._started_at = time.monotonic()
        self._server = await asyncio.start_server(
            self._handle_connection,
            host=self._host,
            port=self._port,
        )
        logger.info(
            "Observability HTTP server listening on http://%s:%d (/health, /ready, /metrics)",
            self._host,
            self.bound_port or self._port,
        )

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    def _build_response(self, method: str, target: str) -> tuple[int, str, bytes]:
        if method not in ("GET", "HEAD"):
            body = json.dumps({"error": "Method not allowed"}).encode("utf-8")
            return 405, "application/json; charset=utf-8", body

        path = target.split("?", 1)[0]

        if path == "/health":
            payload = {
                "status": "ok",
                "service": self._service_name,
                "uptime_seconds": round(time.monotonic() - self._started_at, 3),
            }
            return (
                200,
                "application/json; charset=utf-8",
                json.dumps(payload).encode("utf-8"),
            )

        if path == "/ready":
            checks: dict[str, Any]
            if self._readiness_check is None:
                ready, checks = True, {}
            else:
                ready, checks = self._readiness_check()
            status_code = 200 if ready else 503
            payload = {
                "status": "ready" if ready else "not_ready",
                "service": self._service_name,
                "checks": checks,
            }
            return (
                status_code,
                "application/json; charset=utf-8",
                json.dumps(payload).encode("utf-8"),
            )

        if path == "/metrics":
            body = self._registry.render_prometheus().encode("utf-8")
            return 200, "text/plain; version=0.0.4; charset=utf-8", body

        body = json.dumps({"error": "Not found"}).encode("utf-8")
        return 404, "application/json; charset=utf-8", body

    async def _handle_connection(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=2.0)
            if not request_line:
                return
            parts = request_line.decode("latin-1", errors="replace").strip().split()
            method = parts[0].upper() if len(parts) >= 1 else "GET"
            target = parts[1] if len(parts) >= 2 else "/"

            # Drain HTTP headers (bounded to prevent slowloris / memory abuse)
            for _ in range(64):
                line = await asyncio.wait_for(reader.readline(), timeout=2.0)
                if line in (b"", b"\r\n", b"\n"):
                    break

            status, content_type, body = self._build_response(method, target)
            reason = {
                200: "OK",
                404: "Not Found",
                405: "Method Not Allowed",
                503: "Service Unavailable",
            }.get(status, "OK")
            headers = (
                f"HTTP/1.1 {status} {reason}\r\n"
                f"Content-Type: {content_type}\r\n"
                f"Content-Length: {len(body)}\r\n"
                f"Cache-Control: no-store\r\n"
                f"Connection: close\r\n\r\n"
            ).encode("ascii")
            writer.write(headers)
            if method != "HEAD":
                writer.write(body)
            await writer.drain()
        except (TimeoutError, OSError):
            pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except OSError:
                pass
