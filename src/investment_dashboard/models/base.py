"""Declarative base for all ORM models.

Money is stored as ``Numeric(18, 6)``; share quantities as ``Numeric(18, 8)``;
FX rates as ``Numeric(12, 8)``. SQLAlchemy returns ``decimal.Decimal`` from
``Numeric`` columns, avoiding float drift on financial math.
"""

from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Project-wide declarative base."""
