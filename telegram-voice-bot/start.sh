#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
    echo "error: .venv not found. Create it first:" >&2
    echo "  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
    exit 1
fi

# Settings may also come from the process environment (e.g. a systemd
# EnvironmentFile), so a missing .env is only a hint, not a failure.
if [ ! -f .env ]; then
    echo "note: .env not found; relying on the process environment." >&2
    echo "      To create one: cp .env.example .env && chmod 600 .env" >&2
fi

exec .venv/bin/python main.py "$@"
