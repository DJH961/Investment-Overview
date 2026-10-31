"""``inv-dashboard-set-password``: set the app login password.

Prompts twice via ``getpass`` (or reads one line from stdin with ``--stdin``),
requires at least 12 characters, stores an argon2id hash and revokes every
existing session. The password is never taken from argv.
"""

from __future__ import annotations

import argparse
import getpass
import sys

from investment_dashboard.services import auth_service


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="inv-dashboard-set-password", description=__doc__)
    parser.add_argument("--stdin", action="store_true", help="read the password from stdin")
    args = parser.parse_args(argv)

    if args.stdin:
        password = sys.stdin.readline().rstrip("\r\n")
    else:
        password = getpass.getpass("New password: ")
        if password != getpass.getpass("Repeat password: "):
            print("Passwords do not match.", file=sys.stderr)
            return 1

    from investment_dashboard.db import config_session_scope  # noqa: PLC0415

    try:
        with config_session_scope() as session:
            auth_service.set_password(session, password)
    except auth_service.WeakPasswordError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print("Password updated; all sessions were signed out.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
