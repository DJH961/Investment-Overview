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
