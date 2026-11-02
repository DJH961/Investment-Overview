"""``inv-dashboard-check-config``: read-only preflight of the server configuration.

Prints PASS/FAIL per startup rule (the same rules the server enforces on boot)
and exits 1 on any FAIL. It never prints secret values and changes nothing.
Run it inside the app container so ``app.env`` is loaded, or pass ``--env-file``.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from investment_dashboard.config import Settings, server_config_checks


def _load_env_file(path: Path) -> None:
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ[key.strip()] = value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="inv-dashboard-check-config", description=__doc__)
    parser.add_argument("--env-file", type=Path, help="read KEY=VALUE lines from this file first")
    args = parser.parse_args(argv)

    if args.env_file is not None:
        _load_env_file(args.env_file)
    settings = Settings()

    failed = False
    if not settings.server_mode:
        print("FAIL  INV_DASHBOARD_SERVER_MODE must be true on the server")
        failed = True
    checks = server_config_checks(settings)
    for rule, problem in checks:
        if problem is None:
            print(f"PASS  {rule}")
        else:
            print(f"FAIL  {rule}: {problem}")
            failed = True
    if not checks:
        print("NOTE  loopback http origin: treated as local dev, production rules skipped")
    print("FAILED: the server would refuse to start" if failed else "OK: the server would start")
    return 1 if failed else 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
