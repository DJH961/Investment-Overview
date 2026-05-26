#!/usr/bin/env bash
# Double-clickable launcher for the Investment Dashboard (macOS / Linux).
#
# Mirrors run_dashboard.bat — bootstraps a venv on first run, reuses it
# thereafter, then opens the dashboard in the default browser.

set -euo pipefail

cd "$(dirname "$0")"

VENV_DIR=".venv"

find_python() {
    for candidate in python3.13 python3.12 python3 python; do
        if command -v "$candidate" >/dev/null 2>&1; then
            if "$candidate" -c 'import sys;sys.exit(0 if sys.version_info>=(3,12) else 1)'; then
                echo "$candidate"
                return 0
            fi
        fi
    done
    return 1
}

if ! PY_EXE="$(find_python)"; then
    echo "Python 3.12+ was not found on PATH. Please install it and re-run."
    read -r -p "Press Enter to close…" _ || true
    exit 1
fi

if [ ! -x "$VENV_DIR/bin/python" ]; then
    echo "Creating virtual environment in $VENV_DIR …"
    "$PY_EXE" -m venv "$VENV_DIR"
    "$VENV_DIR/bin/python" -m pip install --upgrade pip >/dev/null
    echo "Installing investment-dashboard and dependencies (one-time, ~1 minute) …"
    "$VENV_DIR/bin/python" -m pip install -e .
fi

echo "Starting Investment Dashboard …"
exec "$VENV_DIR/bin/python" "./run_dashboard.py"
