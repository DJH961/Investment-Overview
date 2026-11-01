"""Authentication logic: password hashing, server-side sessions, rate limit, passkeys.

Sessions use an opaque 256-bit random cookie value; only its SHA-256 is stored.
All time comes from :func:`now` (naive UTC) so tests can inject a clock by
replacing :data:`_clock`.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import secrets
import threading
from collections import OrderedDict, deque
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from sqlalchemy.orm import Session
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from investment_dashboard.config import Settings
from investment_dashboard.repositories import auth_repo

if TYPE_CHECKING:
    from investment_dashboard.models import AuthPasskey

MIN_PASSWORD_LENGTH = 12
CHALLENGE_TTL_SECONDS = 300
MAX_CHALLENGES = 1000
MAX_RATE_KEYS = 10_000
_TOUCH_INTERVAL = timedelta(seconds=60)
_PASSKEY_USER_ID = b"investment-overview-owner"

_hasher = PasswordHasher()
#: Verified against when no usable hash exists so timing does not leak that.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))


class WeakPasswordError(ValueError):
    """Raised when a new password is too short."""


def _utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


#: Replace in tests to freeze/advance time.
_clock: Callable[[], datetime] = _utc_now


def now() -> datetime:
    return _clock()


def _ts() -> float:
    return (now() - datetime(1970, 1, 1)).total_seconds()


# --------------------------------------------------------------------------- password


def set_password(session: Session, password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise WeakPasswordError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")
    hashed = _hasher.hash(password)
    auth_repo.upsert_credential(session, hashed, now())
    auth_repo.delete_all_sessions(session)


def has_password(session: Session) -> bool:
    return auth_repo.get_credential(session) is not None


def verify_password(session: Session, password: str) -> bool:
    """Constant-effort check; ``False`` when no password is set."""
    row = auth_repo.get_credential(session)
    stored = row.password_hash if row is not None else _DUMMY_HASH
    try:
        ok = _hasher.verify(stored, password)
    except (VerificationError, InvalidHashError):
        ok = False
    return ok and row is not None


# --------------------------------------------------------------------------- sessions


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(session: Session, settings: Settings, user_agent: str | None) -> str:
    """Create a session and return the raw cookie value (shown to the client once)."""
    token = secrets.token_urlsafe(32)
    t = now()
    auth_repo.add_session(
        session,
        session_id=_hash_token(token),
        created_at=t,
        expires_at=t + timedelta(days=settings.session_max_age_days),
        user_agent=(user_agent or "")[:256] or None,
    )
    # Opportunistic cleanup of dead sessions.
    auth_repo.delete_expired_sessions(session, t)
    return token


def validate_session(session: Session, settings: Settings, token: str) -> str | None:
    """Return the hashed session id if valid (sliding idle + absolute), else ``None``."""
    if not token or len(token) > 256:
        return None
    sid = _hash_token(token)
    row = auth_repo.get_session(session, sid)
    if row is None:
        return None
    t = now()
    idle = timedelta(minutes=settings.session_idle_minutes)
    if t >= row.expires_at or t >= row.last_seen_at + idle:
        auth_repo.delete_row(session, row)
        return None
    if t - row.last_seen_at >= _TOUCH_INTERVAL:
        row.last_seen_at = t
    return sid


def peek_session(session: Session, settings: Settings, token: str) -> bool:
    """True if the session is valid right now, WITHOUT sliding the idle timeout.

    For long-lived connections (SSE) that re-check periodically: a heartbeat must
    not count as user activity. Read-only: expired rows are left for the next
    ``validate_session`` / cleanup to delete.
    """
    if not token or len(token) > 256:
        return False
    row = auth_repo.get_session(session, _hash_token(token))
    if row is None:
        return False
    t = now()
    idle = timedelta(minutes=settings.session_idle_minutes)
    return not (t >= row.expires_at or t >= row.last_seen_at + idle)


def delete_session(session: Session, token: str) -> None:
    auth_repo.delete_session_by_id(session, _hash_token(token))


# --------------------------------------------------------------------------- rate limit


def client_key(host: str | None) -> str:
    """Rate-limit key for a client address; IPv6 clients are grouped by /64."""
    if not host:
        return "unknown"
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return host[:64]
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped is not None:
            return str(addr.ipv4_mapped)
        return str(ipaddress.ip_network(f"{addr}/64", strict=False).network_address) + "/64"
    return str(addr)


class RateLimiter:
    """In-memory sliding window of events per key plus an optional global cap.

    ``global_factor`` scales the global cap (``max(limit * factor, global_min)``);
    ``None`` disables it.
    """

    def __init__(self, global_factor: int | None = 10, global_min: int = 50) -> None:
        self._lock = threading.Lock()
        self._per_key: dict[str, deque[float]] = {}
        self._global: deque[float] = deque()
        self._global_factor = global_factor
        self._global_min = global_min

    def reset(self) -> None:
        with self._lock:
            self._per_key.clear()
            self._global.clear()

    @staticmethod
    def _prune(q: deque[float], cutoff: float) -> None:
        while q and q[0] <= cutoff:
            q.popleft()

    def _sweep(self, cutoff: float) -> None:
        for k in list(self._per_key):
            q = self._per_key[k]
            self._prune(q, cutoff)
            if not q:
                del self._per_key[k]

    def retry_after(self, key: str, limit: int, *, bypass_global: bool = False) -> int | None:
        """Seconds to wait if ``key`` (or, unless bypassed, everyone) is over the limit."""
        limit = max(1, limit)
        t = _ts()
        with self._lock:
            windows: list[tuple[deque[float], int]] = []
            q = self._per_key.get(key)
            if q is not None:
                self._prune(q, t - 60)
                if not q:
                    del self._per_key[key]
                else:
                    windows.append((q, limit))
            if self._global_factor is not None and not bypass_global:
                self._prune(self._global, t - 60)
                windows.append((self._global, max(limit * self._global_factor, self._global_min)))
            for window, cap in windows:
                if len(window) >= cap:
                    return max(1, int(window[0] + 60 - t) + 1)
        return None

    def record_failure(self, key: str) -> None:
        t = _ts()
        with self._lock:
            if len(self._per_key) > MAX_RATE_KEYS:
                self._sweep(t - 60)
            self._per_key.setdefault(key, deque()).append(t)
            if self._global_factor is not None:
                self._global.append(t)
                self._prune(self._global, t - 60)


rate_limiter = RateLimiter()
#: Counts every passkey-login-options request (not just failures); no global cap.
options_limiter = RateLimiter(global_factor=None)


# --------------------------------------------------------------------------- passkeys


class ChallengeStore:
    """Single-use, short-lived WebAuthn challenges keyed by a random id.

    Insertion order equals expiry order (constant TTL), so purging is a pop
    from the front; the store is capped at :data:`MAX_CHALLENGES` entries.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: OrderedDict[str, tuple[bytes, str, str | None, float]] = OrderedDict()

    def reset(self) -> None:
        with self._lock:
            self._items.clear()

    def put(self, purpose: str, challenge: bytes, extra: str | None = None) -> str:
        key = secrets.token_urlsafe(24)
        t = _ts()
        with self._lock:
            while self._items:
                oldest = next(iter(self._items.values()))
                if oldest[3] > t:
                    break
                self._items.popitem(last=False)
            while len(self._items) >= MAX_CHALLENGES:
                self._items.popitem(last=False)
            self._items[key] = (challenge, purpose, extra, t + CHALLENGE_TTL_SECONDS)
        return key

    def pop(self, key: str | None, purpose: str) -> tuple[bytes, str | None] | None:
        if not key:
            return None
        with self._lock:
            item = self._items.pop(key, None)
        if item is None or item[3] <= _ts() or item[1] != purpose:
            return None
        return item[0], item[2]


challenges = ChallengeStore()


class PasskeyError(Exception):
    """Passkey ceremony failed (bad/expired challenge or invalid assertion)."""


def passkey_count(session: Session) -> int:
    return auth_repo.passkey_count(session)


def registration_options(session: Session, settings: Settings, name: str | None) -> tuple[str, str]:
    """Return ``(options_json, challenge_key)``."""
    existing = [
        PublicKeyCredentialDescriptor(id=cid) for cid in auth_repo.passkey_credential_ids(session)
    ]
    options = generate_registration_options(
        rp_id=settings.webauthn_rp_id,
        rp_name=settings.webauthn_rp_name,
        user_name="owner",
        user_id=_PASSKEY_USER_ID,
        exclude_credentials=existing,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
    )
    key = challenges.put("register", options.challenge, name)
    return options_to_json(options), key


def register_passkey(
    session: Session,
    settings: Settings,
    challenge_key: str | None,
    credential: dict[str, Any],
    name: str | None,
) -> AuthPasskey:
    popped = challenges.pop(challenge_key, "register")
    if popped is None:
        raise PasskeyError("Challenge missing or expired.")
    challenge, stored_name = popped
    body = {k: v for k, v in credential.items() if k != "name"}
    try:
        verified = verify_registration_response(
            credential=body,
            expected_challenge=challenge,
            expected_rp_id=settings.webauthn_rp_id,
            expected_origin=settings.webauthn_origin,
            require_user_verification=True,
        )
    except Exception as exc:
        raise PasskeyError("Passkey registration failed.") from exc
    raw_transports = (body.get("response") or {}).get("transports") or []
    transports = [t for t in raw_transports if isinstance(t, str)][:8]
    if auth_repo.passkey_exists(session, verified.credential_id):
        raise PasskeyError("Passkey already registered.")
    return auth_repo.add_passkey(
        session,
        credential_id=verified.credential_id,
        public_key=verified.credential_public_key,
        sign_count=verified.sign_count,
        transports=json.dumps(transports),
        name=((name or stored_name or "Passkey").strip() or "Passkey")[:80],
        created_at=now(),
    )


def authentication_options(settings: Settings) -> tuple[str, str]:
    options = generate_authentication_options(
        rp_id=settings.webauthn_rp_id,
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    key = challenges.put("login", options.challenge)
    return options_to_json(options), key


def authenticate_passkey(
    session: Session,
    settings: Settings,
    challenge_key: str | None,
    credential: dict[str, Any],
) -> None:
    popped = challenges.pop(challenge_key, "login")
    if popped is None:
        raise PasskeyError("Challenge missing or expired.")
    try:
        raw_id = base64url_to_bytes(str(credential.get("rawId") or credential.get("id") or ""))
    except Exception as exc:
        raise PasskeyError("Passkey login failed.") from exc
    row = auth_repo.get_passkey_by_credential_id(session, raw_id)
    if row is None:
        raise PasskeyError("Passkey login failed.")
    try:
        verified = verify_authentication_response(
            credential=credential,
            expected_challenge=popped[0],
            expected_rp_id=settings.webauthn_rp_id,
            expected_origin=settings.webauthn_origin,
            credential_public_key=row.public_key,
            credential_current_sign_count=row.sign_count,
            require_user_verification=True,
        )
    except Exception as exc:
        raise PasskeyError("Passkey login failed.") from exc
    row.sign_count = verified.new_sign_count
    row.last_used_at = now()


def list_passkeys(session: Session) -> list[AuthPasskey]:
    return auth_repo.list_passkeys(session)


def delete_passkey(session: Session, passkey_id: int) -> bool:
    row = auth_repo.get_passkey(session, passkey_id)
    if row is None:
        return False
    auth_repo.delete_row(session, row)
    return True
