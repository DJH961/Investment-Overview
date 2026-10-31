"""Write the v6 OpenAPI document to ``backend/openapi.json``.

The frontend generates ``src/lib/api-types.ts`` from it (``npm run gen:api``).
Run: ``uv run python -m investment_dashboard.tools.export_openapi`` from ``backend/``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from investment_dashboard.api.app import create_app

DEFAULT_OUT = Path(__file__).resolve().parents[3] / "openapi.json"


def render() -> str:
    return json.dumps(create_app(lifespan=False).openapi(), indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    out = Path(args[0]) if args else DEFAULT_OUT
    out.write_text(render(), encoding="utf-8", newline="\n")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
