#!/usr/bin/env bash
# Запуск скринера: ./run.sh [порт]
set -e
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
exec .venv/bin/uvicorn app.main:app --host "${HOST:-127.0.0.1}" --port "${1:-8000}"
