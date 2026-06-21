"""Shared SQLCipher passphrase resolution for the CLI tools.

Passing a secret as a ``--passphrase`` argument leaks it into ``ps`` output
and the shell history file. The preferred sources are, in order:

1. The ``INV_DASHBOARD_DB_PASSPHRASE`` environment variable.
2. An interactive prompt (``getpass``) when stdin is a TTY.

The explicit ``--passphrase`` flag is still honoured for non-interactive
automation, but using it emits a warning so the operator knows the value is
exposed to other processes on the machine.
"""

from __future__ import annotations

import getpass
import logging
import os
import sys

ENV_VAR = "INV_DASHBOARD_DB_PASSPHRASE"

log = logging.getLogger(__name__)


def resolve_passphrase(
    cli_value: str | None,
    *,
    prompt: str = "SQLCipher passphrase: ",
    allow_prompt: bool = True,
) -> str | None:
    """Resolve a passphrase from the CLI flag, the environment, or a prompt.

    ``cli_value`` is the (insecure) ``--passphrase`` argument. When it is set,
    a warning is logged because it leaks into the process list and shell
    history. When it is ``None`` the environment variable is tried, then an
    interactive ``getpass`` prompt if ``allow_prompt`` is true and stdin is a
    TTY. Returns ``None`` when no passphrase can be obtained (e.g. running
    non-interactively with neither the flag nor the env var set).
    """
    if cli_value:
        log.warning(
            "--passphrase was passed on the command line; it can leak into the "
            "process list and shell history. Prefer the %s environment variable "
            "or the interactive prompt.",
            ENV_VAR,
        )
        return cli_value

    env_value = os.environ.get(ENV_VAR)
    if env_value:
        return env_value

    if allow_prompt and sys.stdin is not None and sys.stdin.isatty():
        entered = getpass.getpass(prompt)
        return entered or None

    return None
