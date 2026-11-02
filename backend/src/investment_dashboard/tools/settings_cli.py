"""``inv-dashboard-settings``: list, show or reset in-app settings from a shell.

The escape hatch when a setting made the app unusable::

    docker compose exec app inv-dashboard-settings list
    docker compose exec app inv-dashboard-settings get backup.retention.daily
    docker compose exec app inv-dashboard-settings reset <key> [<key> ...]
    docker compose exec app inv-dashboard-settings reset --all

``reset`` deletes the stored value so the env value or default applies again
(the change is audited as actor ``cli``; the running app picks it up within a
minute). Secret values are never printed.
"""

from __future__ import annotations

import argparse
import json
import sys


def _open_db() -> None:
    from investment_dashboard.config import get_settings  # noqa: PLC0415
    from investment_dashboard.db import set_active_encryption  # noqa: PLC0415
    from investment_dashboard.storage.encryption import resolve_encryption  # noqa: PLC0415

    settings = get_settings()
    set_active_encryption(
        resolve_encryption(
            encrypt_synced_tiers=settings.encrypt_synced_tiers,
            env_passphrase=settings.db_passphrase,
        )
    )
    from investment_dashboard.activity_log import configure_activity_logs  # noqa: PLC0415

    configure_activity_logs(settings.resolved_log_dir)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="inv-dashboard-settings", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="every setting with its value and source")
    get_p = sub.add_parser("get", help="one setting")
    get_p.add_argument("key")
    reset_p = sub.add_parser("reset", help="back to env/default")
    reset_p.add_argument("keys", nargs="*")
    reset_p.add_argument("--all", action="store_true", help="reset every setting")
    args = parser.parse_args(argv)

    _open_db()
    from investment_dashboard.domain.settings_schema import to_json  # noqa: PLC0415
    from investment_dashboard.services import settings_registry, settings_service  # noqa: PLC0415

    def show(key: str) -> str:
        eff = settings_service.effective(key)
        secret = settings_registry.BY_KEY[key].secret
        value = ("<set>" if eff.value else "<not set>") if secret else to_json(eff.value)
        return f"{key} = {json.dumps(value)}  ({eff.source})"

    if args.cmd == "list":
        for key in settings_registry.BY_KEY:
            print(show(key))
        return 0
    if args.cmd == "get":
        if args.key not in settings_registry.BY_KEY:
            print(f"unknown setting {args.key!r}", file=sys.stderr)
            return 2
        print(show(args.key))
        return 0
    if not args.keys and not args.all:
        print("name at least one key, or pass --all", file=sys.stderr)
        return 2
    try:
        changed = settings_service.reset(keys=args.keys, everything=args.all, actor="cli")
    except settings_service.SettingsValidationError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(f"reset {len(changed)} setting(s): {', '.join(changed) or '-'}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
