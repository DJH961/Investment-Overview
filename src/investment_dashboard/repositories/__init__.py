"""DB access layer. Only place that imports SQLAlchemy ORM models.

Repositories return plain ORM objects or simple dicts; services compose
them with domain math. The UI never imports anything from this package
directly — it only talks to services.
"""

from investment_dashboard.repositories import (
    accounts_repo,
    allocations_repo,
    fx_repo,
    instruments_repo,
    price_cache_repo,
    prices_repo,
    snapshots_repo,
    transactions_repo,
)

__all__ = [
    "accounts_repo",
    "allocations_repo",
    "fx_repo",
    "instruments_repo",
    "price_cache_repo",
    "prices_repo",
    "snapshots_repo",
    "transactions_repo",
]
