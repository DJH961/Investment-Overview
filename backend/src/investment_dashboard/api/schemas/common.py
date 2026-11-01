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
    detail: str | None = None


__all__ = ["ApiModel", "Ccy", "DecStr", "Envelope", "OkResponse"]
