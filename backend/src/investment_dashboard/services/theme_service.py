"""Theme service — persists the user's light/dark/auto preference.

NiceGUI's :class:`ui.dark_mode` is per-client and resets to its initial
value on every page render. That made the header dark-mode toggle feel
broken: switching to Dark on the Overview page and then navigating to
Transactions would snap back to Auto.

Persistence is via the ``app_config`` table, key ``theme``. The stored
value is one of :data:`SUPPORTED_THEMES` and translates to the tri-state
accepted by ``ui.dark_mode``:

* ``"auto"`` → ``None`` (follow the OS preference)
* ``"light"`` → ``False``
* ``"dark"``  → ``True``
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo

SUPPORTED_THEMES: tuple[str, ...] = ("auto", "light", "dark")
DEFAULT_THEME = "auto"

_CONFIG_KEY = "theme"


def _to_token(value: bool | None) -> str:
    if value is None:
        return "auto"
    return "dark" if value else "light"


def _from_token(token: str) -> bool | None:
    if token == "dark":
        return True
    if token == "light":
        return False
    return None


def get_theme(session: Session) -> bool | None:
    """Return the persisted dark-mode value (``None``/``False``/``True``)."""
    raw = app_config_repo.get(session, _CONFIG_KEY)
    if raw is None:
        return _from_token(DEFAULT_THEME)
    candidate = raw.strip().lower()
    if candidate not in SUPPORTED_THEMES:
        return _from_token(DEFAULT_THEME)
    return _from_token(candidate)


def set_theme(session: Session, value: bool | None) -> bool | None:
    """Persist the dark-mode value. Returns the normalised value."""
    token = _to_token(value)
    if token not in SUPPORTED_THEMES:  # pragma: no cover - defensive
        raise ValueError(f"Unsupported theme {value!r}")
    app_config_repo.set_value(session, _CONFIG_KEY, token)
    return _from_token(token)
