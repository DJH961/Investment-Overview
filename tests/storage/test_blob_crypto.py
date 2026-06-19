"""Tests for the v3.0 AES-256-GCM live-web envelope (blob_crypto)."""

from __future__ import annotations

import base64

import pytest

from investment_dashboard.storage import blob_crypto

PASSPHRASE = "correct horse battery staple"


def test_round_trip_recovers_plaintext() -> None:
    plaintext = b'{"hello": "world", "n": 42}'
    envelope = blob_crypto.encrypt_bytes(plaintext, PASSPHRASE)
    assert blob_crypto.decrypt_bytes(envelope, PASSPHRASE) == plaintext


def test_envelope_shape_matches_contract() -> None:
    envelope = blob_crypto.encrypt_bytes(b"x", PASSPHRASE)
    assert envelope["v"] == blob_crypto.ENVELOPE_VERSION
    assert envelope["kdf"] == blob_crypto.KDF_NAME
    assert envelope["kdf_params"]["iterations"] == blob_crypto.PBKDF2_ITERATIONS
    # Every binary field is standard base64 of the expected length.
    assert len(base64.b64decode(envelope["kdf_params"]["salt"])) == blob_crypto.SALT_LENGTH
    assert len(base64.b64decode(envelope["nonce"])) == blob_crypto.NONCE_LENGTH
    assert len(base64.b64decode(envelope["tag"])) == blob_crypto.TAG_LENGTH
    assert base64.b64decode(envelope["ciphertext"]) is not None


def test_salt_and_nonce_are_random_per_encrypt() -> None:
    a = blob_crypto.encrypt_bytes(b"same", PASSPHRASE)
    b = blob_crypto.encrypt_bytes(b"same", PASSPHRASE)
    assert a["kdf_params"]["salt"] != b["kdf_params"]["salt"]
    assert a["nonce"] != b["nonce"]
    assert a["ciphertext"] != b["ciphertext"]


def test_wrong_passphrase_fails_authentication() -> None:
    envelope = blob_crypto.encrypt_bytes(b"secret", PASSPHRASE)
    with pytest.raises(blob_crypto.EnvelopeError):
        blob_crypto.decrypt_bytes(envelope, "not the passphrase")


def test_tampered_ciphertext_is_rejected() -> None:
    envelope = blob_crypto.encrypt_bytes(b"secret", PASSPHRASE)
    raw = bytearray(base64.b64decode(envelope["ciphertext"]) or b"\x00")
    raw[0] ^= 0xFF
    envelope["ciphertext"] = base64.b64encode(bytes(raw)).decode("ascii")
    with pytest.raises(blob_crypto.EnvelopeError):
        blob_crypto.decrypt_bytes(envelope, PASSPHRASE)


def test_empty_passphrase_on_encrypt_is_rejected() -> None:
    with pytest.raises(blob_crypto.EnvelopeError):
        blob_crypto.encrypt_bytes(b"x", "")


@pytest.mark.parametrize(
    "mutation",
    [
        {"v": 2},
        {"kdf": "scrypt"},
        {"kdf_params": {"salt": "AAAA", "iterations": 0}},
    ],
)
def test_unsupported_envelope_metadata_is_rejected(mutation: dict[str, object]) -> None:
    envelope = blob_crypto.encrypt_bytes(b"x", PASSPHRASE)
    envelope.update(mutation)
    with pytest.raises(blob_crypto.EnvelopeError):
        blob_crypto.decrypt_bytes(envelope, PASSPHRASE)


def test_webcrypto_layout_ciphertext_then_tag() -> None:
    # The browser passes ``ciphertext || tag`` to SubtleCrypto.decrypt; verify
    # cryptography's AESGCM accepts the recombined buffer the same way.
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    plaintext = b"web-parity"
    envelope = blob_crypto.encrypt_bytes(plaintext, PASSPHRASE)
    salt = base64.b64decode(envelope["kdf_params"]["salt"])
    nonce = base64.b64decode(envelope["nonce"])
    ciphertext = base64.b64decode(envelope["ciphertext"])
    tag = base64.b64decode(envelope["tag"])
    key = blob_crypto._derive_key(PASSPHRASE, salt, envelope["kdf_params"]["iterations"])
    assert AESGCM(key).decrypt(nonce, ciphertext + tag, None) == plaintext
