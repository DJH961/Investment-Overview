"""Tests for the central secret-redaction helper and logging filter."""

from __future__ import annotations

import logging

from investment_dashboard.redaction import (
    REDACTED,
    SecretRedactingFilter,
    redact_secrets,
)


def test_redacts_classic_and_fine_grained_pats() -> None:
    classic = "ghp_" + "A" * 36
    fine = "github_pat_" + "B" * 40
    oauth = "gho_" + "C" * 36
    text = f"creds {classic} and {fine} and {oauth}"
    out = redact_secrets(text)
    assert classic not in out
    assert fine not in out
    assert oauth not in out
    assert out.count(REDACTED) == 3


def test_redacts_authorization_scheme_but_keeps_word() -> None:
    credential = "abc123def456ghi789"
    out = redact_secrets("Bearer " + credential)
    assert credential not in out
    assert "Bearer" in out
    assert REDACTED in out


def test_extra_secret_is_masked_even_without_known_shape() -> None:
    secret = "s3cr3t-passphrase-value"
    out = redact_secrets(f"using {secret} now", extra=[secret])
    assert secret not in out
    assert REDACTED in out


def test_blank_extra_is_ignored() -> None:
    text = "a b c"
    assert redact_secrets(text, extra=["", "   "]) == text


def test_empty_text_round_trips() -> None:
    assert redact_secrets("") == ""


def test_logging_filter_scrubs_emitted_message() -> None:
    record = logging.LogRecord(
        name="t",
        level=logging.ERROR,
        pathname=__file__,
        lineno=1,
        msg="leaked %s",
        args=("ghp_" + "Z" * 36,),
        exc_info=None,
    )
    assert SecretRedactingFilter().filter(record) is True
    assert "ghp_" not in record.getMessage()
    assert REDACTED in record.getMessage()


def test_traceback_text_is_redacted() -> None:
    import io
    import sys

    from investment_dashboard.redaction import SecretRedactingFilter

    secret = "ghp_" + "Q" * 36
    try:
        raise ValueError(f"upstream said no for {secret}")
    except ValueError:
        exc_info = sys.exc_info()
    record = logging.LogRecord("t", logging.ERROR, __file__, 1, "failed", None, exc_info)
    SecretRedactingFilter().filter(record)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(message)s"))
    handler.handle(record)
    out = stream.getvalue()
    assert "Traceback" in out
    assert secret not in out
    assert REDACTED in out


def test_stack_info_is_redacted() -> None:
    record = logging.LogRecord("t", logging.ERROR, __file__, 1, "m", None, None)
    record.stack_info = "frame password=hunter2hunter2"
    SecretRedactingFilter().filter(record)
    assert "hunter2" not in (record.stack_info or "")


def test_registered_secret_is_masked_everywhere() -> None:
    from investment_dashboard import redaction

    value = "correct horse battery staple"
    redaction.register_secrets(value)
    try:
        assert value not in redact_secrets(f"opening db with {value}!")
        record = logging.LogRecord("t", logging.ERROR, __file__, 1, "x", None, None)
        record.exc_text = f"RuntimeError: {value}"
        SecretRedactingFilter().filter(record)
        assert value not in (record.exc_text or "")
    finally:
        redaction._registered.discard(value)


def test_header_and_key_value_shapes() -> None:
    out = redact_secrets(
        "headers {'X-API-Token': 'abcdefgh1234', 'Cookie': '__Host-session=zzzz9999'} "
        "url=/x?api_key=SUPERSECRET&q=1 password=hunter2hunter2 Authorization: Basic Zm9vOmJhcg=="
    )
    for leaked in ("abcdefgh1234", "zzzz9999", "SUPERSECRET", "hunter2", "Zm9vOmJhcg"):
        assert leaked not in out
    assert "q=1" in out


def test_ordinary_text_is_untouched() -> None:
    text = "Password updated; refreshed 3 symbols, session count 4, 2 passkeys"
    assert redact_secrets(text) == text
