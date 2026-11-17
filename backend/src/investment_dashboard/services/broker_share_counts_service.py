"""Share counts the owner typed from the broker's screen (v7 P7, optional check).

One JSON list in ``app_config`` (key :data:`CONFIG_KEY`):
``[{"account_id": 1, "instrument_id": 2, "shares": "12.5"}, ...]``. Data Health
compares these with the ledger's totals and lists differences as hints; nothing is
ever changed automatically. An empty list (or no value) means the check is not set up.
"""

from __future__ import annotations

import json
import logging
from decimal import Decimal, InvalidOperation

from sqlalchemy.orm import Session

from investment_dashboard.errors import ValidationError
from investment_dashboard.repositories import accounts_repo, instruments_repo
from investment_dashboard.services import app_config_service

log = logging.getLogger(__name__)

#: ``app_config`` key holding the typed counts.
CONFIG_KEY = "ledger.broker_share_counts"

Entry = tuple[int, int, Decimal]


def load(session: Session) -> list[Entry]:
    """Typed counts as ``(account_id, instrument_id, shares)``; empty when not set up."""
    raw = app_config_service.get(session, CONFIG_KEY)
    if not raw:
        return []
    try:
        return [
            (int(e["account_id"]), int(e["instrument_id"]), Decimal(str(e["shares"])))
            for e in json.loads(raw)
        ]
    except (ValueError, TypeError, KeyError, InvalidOperation):
        log.warning("Stored broker share counts are unreadable; ignoring them")
        return []


def replace(session: Session, entries: list[Entry]) -> list[Entry]:
    """Validate and store ``entries`` as the whole list (empty clears the check)."""
    account_ids = {a.id for a in accounts_repo.list_accounts(session)}
    instrument_ids = {i.id for i in instruments_repo.list_instruments(session)}
    seen: set[tuple[int, int]] = set()
    for account_id, instrument_id, shares in entries:
        if account_id not in account_ids:
            raise ValidationError(f"unknown account {account_id}")
        if instrument_id not in instrument_ids:
            raise ValidationError(f"unknown instrument {instrument_id}")
        if not shares.is_finite() or shares < 0:
            raise ValidationError("a share count must be zero or more")
        if (account_id, instrument_id) in seen:
            raise ValidationError("each account and instrument may be listed only once")
        seen.add((account_id, instrument_id))
    if entries:
        payload = [
            {"account_id": a, "instrument_id": i, "shares": format(s.normalize(), "f")}
            for a, i, s in entries
        ]
        app_config_service.set_value(session, CONFIG_KEY, json.dumps(payload))
    else:
        app_config_service.delete_key(session, CONFIG_KEY)
    return load(session)
