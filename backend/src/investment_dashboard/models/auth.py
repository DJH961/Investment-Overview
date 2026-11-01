"""Login credential, passkeys and server-side sessions (config tier).

Migration revision ``e3b7c5d9f2a1`` (down_revision ``d2a6b4c8e1f0``). Single
owner account: ``auth_credential`` holds at most one row (``id == 1``). Session
ids are stored only as SHA-256 hashes of the random cookie value.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from investment_dashboard.models.base import ConfigBase as Base


class AuthCredential(Base):
    __tablename__ = "auth_credential"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class AuthPasskey(Base):
    __tablename__ = "auth_passkeys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    credential_id: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, unique=True)
    public_key: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    sign_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    #: JSON list of transport strings.
    transports: Mapped[str | None] = mapped_column(Text)
    name: Mapped[str] = mapped_column(String(80), nullable=False, default="Passkey")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime)


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    #: sha256 hex of the random cookie value (the raw value is never stored).
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    user_agent: Mapped[str | None] = mapped_column(String(256))
