"""Auth repository: password credential, passkeys and server-side sessions (config tier)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from investment_dashboard.models.auth import AuthCredential, AuthPasskey, AuthSession


def get_credential(session: Session) -> AuthCredential | None:
    return session.get(AuthCredential, 1)


def upsert_credential(session: Session, password_hash: str, at: datetime) -> None:
    row = get_credential(session)
    if row is None:
        session.add(AuthCredential(id=1, password_hash=password_hash, updated_at=at))
    else:
        row.password_hash = password_hash
        row.updated_at = at


def delete_all_sessions(session: Session) -> None:
    session.execute(delete(AuthSession))


def delete_expired_sessions(session: Session, at: datetime) -> None:
    session.execute(delete(AuthSession).where(AuthSession.expires_at <= at))


def delete_session_by_id(session: Session, session_id: str) -> None:
    session.execute(delete(AuthSession).where(AuthSession.id == session_id))


def add_session(
    session: Session,
    *,
    session_id: str,
    created_at: datetime,
    expires_at: datetime,
    user_agent: str | None,
) -> None:
    session.add(
        AuthSession(
            id=session_id,
            created_at=created_at,
            last_seen_at=created_at,
            expires_at=expires_at,
            user_agent=user_agent,
        )
    )


def get_session(session: Session, session_id: str) -> AuthSession | None:
    return session.get(AuthSession, session_id)


def delete_row(session: Session, row: AuthSession | AuthPasskey) -> None:
    session.delete(row)


def passkey_count(session: Session) -> int:
    return int(session.scalar(select(func.count()).select_from(AuthPasskey)) or 0)


def passkey_credential_ids(session: Session) -> list[bytes]:
    return list(session.scalars(select(AuthPasskey.credential_id)))


def passkey_exists(session: Session, credential_id: bytes) -> bool:
    return bool(
        session.scalar(select(AuthPasskey.id).where(AuthPasskey.credential_id == credential_id))
    )


def add_passkey(
    session: Session,
    *,
    credential_id: bytes,
    public_key: bytes,
    sign_count: int,
    transports: str,
    name: str,
    created_at: datetime,
) -> AuthPasskey:
    row = AuthPasskey(
        credential_id=credential_id,
        public_key=public_key,
        sign_count=sign_count,
        transports=transports,
        name=name,
        created_at=created_at,
    )
    session.add(row)
    session.flush()
    return row


def get_passkey_by_credential_id(session: Session, credential_id: bytes) -> AuthPasskey | None:
    return session.scalar(select(AuthPasskey).where(AuthPasskey.credential_id == credential_id))


def list_passkeys(session: Session) -> list[AuthPasskey]:
    return list(session.scalars(select(AuthPasskey).order_by(AuthPasskey.id)))


def get_passkey(session: Session, passkey_id: int) -> AuthPasskey | None:
    return session.get(AuthPasskey, passkey_id)
