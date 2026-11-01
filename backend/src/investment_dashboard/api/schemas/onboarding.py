"""Schemas for ``/api/onboarding``."""

from __future__ import annotations

from investment_dashboard.api.schemas.common import ApiModel


class OnboardingOut(ApiModel):
    """Which first-run steps are done (each is independent; all can be skipped)."""

    account: bool
    first_import: bool
    password: bool
    passkey: bool
    conversions: bool
    targets: bool
    complete: bool
