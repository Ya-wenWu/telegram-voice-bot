"""Request correlation ID context for structured cross-module logging."""

import logging
from contextvars import ContextVar

req_id_var: ContextVar[str] = ContextVar("req_id", default="-")


class RequestIdFilter(logging.Filter):
    """Attach the current ``req_id`` ContextVar to every LogRecord."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.req_id = req_id_var.get()
        return True
