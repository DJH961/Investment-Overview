#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
    PY_EXE=python3
elif command -v python >/dev/null 2>&1; then
    PY_EXE=python
else
    echo "Python 3.12+ was not found on PATH. Please install Python and re-run this script." >&2
    exit 1
fi

exec "$PY_EXE" ./run_dashboard.py "$@"
