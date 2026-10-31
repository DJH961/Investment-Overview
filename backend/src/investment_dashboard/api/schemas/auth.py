"""Schemas for ``/api/auth``."""

from __future__ import annotations

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel


class LoginBody(ApiModel):
    password: str = Field(max_length=1024)


class MeResponse(ApiModel):
    authenticated: bool
    passkeys: int


class PasskeyOut(ApiModel):
    id: int
    name: str
    created_at: str | None = None
    last_used_at: str | None = None


class PasskeyNameBody(ApiModel):
    name: str | None = Field(default=None, max_length=80)
