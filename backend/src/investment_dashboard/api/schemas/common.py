"""Shared schema building blocks.

Money and rates are ``Decimal`` end to end; pydantic serialises ``Decimal`` as a
JSON **string**, which is what the frontend expects (it never does maths on
them, it only formats). Read-models already emit strings via
``readmodels._serialize.dec`` — model those fields as ``DecStr``.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from investment_dashboard.api.deps import Ccy

#: A decimal number transported as a string (``"1234.56"``), or ``None``.
DecStr = Annotated[str, Field(pattern=r"^-?\d+(\.\d+)?([eE][-+]?\d+)?$")]


class ApiModel(BaseModel):
    """Base for every API schema."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class Envelope(ApiModel):
    """Common metadata on report responses."""

    ccy: Ccy
    as_of: str = Field(description="ISO date/datetime the numbers are valid for.")


class OkResponse(ApiModel):
    ok: bool = True


class ByCurrency[T](ApiModel):
    """The same report built once per reporting currency (docs/v6_speed_plan.md §1a R3).

    Each side is a complete, independently built response in that currency (EUR
    returns are FX-aware, never converted from USD), so the client switches currency
    by picking a side: no request, no conversion.
    """

    EUR: T
    USD: T
    detail: str | None = None


__all__ = ["ApiModel", "Ccy", "DecStr", "Envelope", "OkResponse"]
