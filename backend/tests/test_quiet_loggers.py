"""Harmless third-party log noise is held back from the app's log views."""

from __future__ import annotations

import logging

from investment_dashboard.logging import quiet_third_party_loggers


def test_bs4_decode_warning_is_silenced() -> None:
    quiet_third_party_loggers()
    dammit = logging.getLogger("bs4.dammit")
    assert not dammit.isEnabledFor(logging.WARNING)
    assert dammit.isEnabledFor(logging.ERROR)


def test_charset_normalizer_debug_is_silenced() -> None:
    quiet_third_party_loggers()
    noisy = logging.getLogger("charset_normalizer")
    assert not noisy.isEnabledFor(logging.DEBUG)
    assert noisy.isEnabledFor(logging.WARNING)
