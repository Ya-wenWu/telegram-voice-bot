"""Request correlation and trace context for structured cross-module logging."""

import logging
from contextvars import ContextVar

req_id_var: ContextVar[str] = ContextVar("req_id", default="-")
trace_id_var: ContextVar[str] = ContextVar("trace_id", default="-")
span_id_var: ContextVar[str] = ContextVar("span_id", default="-")


class RequestIdFilter(logging.Filter):
    """Attach ``req_id``, ``trace_id``, and ``span_id`` ContextVars to every LogRecord."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.req_id = req_id_var.get()
        record.trace_id = trace_id_var.get()
        record.span_id = span_id_var.get()
        return True
