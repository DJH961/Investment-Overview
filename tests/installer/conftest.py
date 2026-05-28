"""Make the top-level ``installer`` package importable for these tests.

The ``investment_dashboard`` package is installed editable into the test
virtualenv via ``pip install -e .`` so it is importable without help. The
``installer`` package, by contrast, lives at the repository root and is
not packaged — it ships as source files inside the PyInstaller-built
``.exe``. We add the repo root to ``sys.path`` here so the unit tests can
exercise ``installer.version`` and ``installer.launcher`` directly.
"""

from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
