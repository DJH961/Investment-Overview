"""Settings change history (config tier, migration ``0018``).

One row per changed ``app_config`` key written through ``settings_service``.
Secret values are stored as ``"<redacted>"`` only. The service keeps the newest
1000 rows.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import ConfigBase as Base


class AppConfigAudit(Base):
    __tablename__ = "app_config_audit"
    __table_args__ = (Index("ix_app_config_audit_key", "key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(64), nullable=False)
    old_value: Mapped[str | None] = mapped_column(Text)
    new_value: Mapped[str | None] = mapped_column(Text)
    changed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    #: ``session:<id8>``, ``token`` or ``cli``.
    actor: Mapped[str] = mapped_column(String(64), nullable=False)
    #: ``set`` / ``reset`` / ``import`` / ``revert``.
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    request_id: Mapped[str | None] = mapped_column(String(64))
