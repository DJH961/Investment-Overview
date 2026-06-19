"""AES-256-GCM envelope encryption for the v3.0 live-web companion blob.

This is the public-repo-safe ciphertext format described in
``docs/v3.0_live_web_companion_proposal.md`` §4. Unlike
:mod:`investment_dashboard.storage.encryption` (which keys the *SQLCipher*
database files), this module encrypts a single in-memory JSON payload — the
minimized mobile export — into an opaque envelope that is safe to publish on
a public GitHub release asset.

Design (locked in for v3.0, mirrored by the browser's WebCrypto code):

* **Cipher:** AES-256-GCM (authenticated — tampering is detected on decrypt).
* **KDF:** PBKDF2-HMAC-SHA256 at 600,000 iterations, 32-byte derived key.
  Both PBKDF2 and AES-GCM are browser-native (``SubtleCrypto``), so the web
  app decrypts with zero JavaScript crypto dependencies.
* **Envelope:** a small JSON object with base64 (standard alphabet) fields::

      {
        "v": 1,
        "kdf": "PBKDF2-HMAC-SHA256",
        "kdf_params": {"salt": "<b64>", "iterations": 600000},
        "nonce": "<b64>",
        "ciphertext": "<b64>",
        "tag": "<b64>"
      }

  ``salt`` and ``nonce`` are freshly random on every encrypt. ``ciphertext``
  and ``tag`` are stored separately so the JS side can recombine them for the
  WebCrypto ``decrypt`` call (which expects ``ciphertext || tag``).

The passphrase is the entire wall protecting this blob once it is public, so
callers must collect a long, unique mobile passphrase (see
:func:`investment_dashboard.storage.encryption.validate_passphrase`).
"""

from __future__ import annotations

import base64
import hashlib
import os
from typing import Any

#: Envelope schema version. Bump only on an incompatible format change.
ENVELOPE_VERSION = 1

#: KDF identifier recorded in the envelope and recognised by the web client.
KDF_NAME = "PBKDF2-HMAC-SHA256"

#: PBKDF2 work factor. Deliberately slow so an attacker who grabs the public
#: blob can only test a few guesses per second. Locked at 600k for v3.0.
PBKDF2_ITERATIONS = 600_000

#: Derived AES key length in bytes (AES-256).
KEY_LENGTH = 32

#: Random salt / GCM nonce sizes in bytes.
SALT_LENGTH = 16
NONCE_LENGTH = 12

#: AES-GCM authentication tag length in bytes.
TAG_LENGTH = 16


class EnvelopeError(ValueError):
    """Raised when an envelope is malformed or fails authentication."""


def _b64encode(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _b64decode(value: str, *, field: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as exc:  # pragma: no cover - defensive
        raise EnvelopeError(f"envelope field {field!r} is not valid base64") from exc


def _derive_key(passphrase: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha256",
        passphrase.encode("utf-8"),
        salt,
        iterations,
        dklen=KEY_LENGTH,
    )


def encrypt_bytes(
    plaintext: bytes,
    passphrase: str,
    *,
    iterations: int = PBKDF2_ITERATIONS,
) -> dict[str, Any]:
    """Encrypt ``plaintext`` into a JSON-serializable AES-GCM envelope.

    A fresh random salt and nonce are generated for every call, so encrypting
    the same payload twice yields different ciphertext (and never reuses a
    GCM nonce under the same derived key).
    """
    if not passphrase:
        raise EnvelopeError("a non-empty passphrase is required to encrypt")

    # Imported lazily so a vanilla install that never publishes the web blob
    # doesn't pay the import cost (and surfaces a clear error if the optional
    # dependency is somehow missing).
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415

    salt = os.urandom(SALT_LENGTH)
    nonce = os.urandom(NONCE_LENGTH)
    key = _derive_key(passphrase, salt, iterations)
    sealed = AESGCM(key).encrypt(nonce, plaintext, None)
    ciphertext, tag = sealed[:-TAG_LENGTH], sealed[-TAG_LENGTH:]
    return {
        "v": ENVELOPE_VERSION,
        "kdf": KDF_NAME,
        "kdf_params": {"salt": _b64encode(salt), "iterations": iterations},
        "nonce": _b64encode(nonce),
        "ciphertext": _b64encode(ciphertext),
        "tag": _b64encode(tag),
    }


def decrypt_bytes(envelope: dict[str, Any], passphrase: str) -> bytes:
    """Recover the plaintext from an envelope produced by :func:`encrypt_bytes`.

    Raises :class:`EnvelopeError` if the envelope is malformed, uses an
    unsupported version/KDF, or fails GCM authentication (wrong passphrase or
    tampered ciphertext).
    """
    if not isinstance(envelope, dict):  # pragma: no cover - defensive
        raise EnvelopeError("envelope must be a JSON object")
    if envelope.get("v") != ENVELOPE_VERSION:
        raise EnvelopeError(f"unsupported envelope version: {envelope.get('v')!r}")
    if envelope.get("kdf") != KDF_NAME:
        raise EnvelopeError(f"unsupported KDF: {envelope.get('kdf')!r}")

    params = envelope.get("kdf_params")
    if not isinstance(params, dict):
        raise EnvelopeError("envelope is missing kdf_params")
    iterations = params.get("iterations")
    if not isinstance(iterations, int) or iterations <= 0:
        raise EnvelopeError("envelope has an invalid iteration count")

    salt = _b64decode(params.get("salt", ""), field="kdf_params.salt")
    nonce = _b64decode(envelope.get("nonce", ""), field="nonce")
    ciphertext = _b64decode(envelope.get("ciphertext", ""), field="ciphertext")
    tag = _b64decode(envelope.get("tag", ""), field="tag")

    from cryptography.exceptions import InvalidTag  # noqa: PLC0415
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415

    key = _derive_key(passphrase, salt, iterations)
    try:
        return AESGCM(key).decrypt(nonce, ciphertext + tag, None)
    except InvalidTag as exc:
        raise EnvelopeError(
            "decryption failed — wrong passphrase or the blob was tampered with"
        ) from exc
