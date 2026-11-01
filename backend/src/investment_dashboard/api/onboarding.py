"""``GET /api/onboarding`` -- which first-run steps are done."""

from __future__ import annotations

from fastapi import APIRouter

from investment_dashboard.api.deps import ConfigSessionDep, SessionDep
from investment_dashboard.api.schemas.onboarding import OnboardingOut
from investment_dashboard.readmodels import allocations as allocations_rm
from investment_dashboard.readmodels.queries.ledger_query import count_ledger_records
from investment_dashboard.services import auth_service, fx_conversion_service, onboarding_service

router = APIRouter(prefix="/onboarding", tags=["onboarding"])


@router.get("", response_model=OnboardingOut)
def get_onboarding(session: SessionDep, config: ConfigSessionDep) -> OnboardingOut:
    account = onboarding_service.is_onboarded(session)
    first_import = count_ledger_records(session) > 0
    password = auth_service.has_password(config)
    passkey = auth_service.passkey_count(config) > 0
    conversions = bool(fx_conversion_service.list_conversions(session))
    targets = bool(allocations_rm.serialize_targets(session))
    # Conversions are optional (EUR-only users skip them), so they do not gate "complete".
    complete = account and first_import and password and targets
    return OnboardingOut(
        account=account,
        first_import=first_import,
        password=password,
        passkey=passkey,
        conversions=conversions,
        targets=targets,
        complete=complete,
    )
