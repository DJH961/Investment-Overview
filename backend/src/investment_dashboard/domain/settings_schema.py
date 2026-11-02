"""Typed settings schema: what a setting is, and how its value is parsed and checked.

Pure (no DB, no I/O): the catalogue lives in ``services/settings_registry`` and
the store in ``services/settings_service``. Values are stored as text in
``app_config``; this module converts between three forms:

* **typed** — the Python value code uses (``bool``, ``int``, ``Decimal``, ``str``,
  ``tuple[str, ...]``, ``tuple[Decimal, ...]``, ``dict[str, str]``);
* **stored** — the ``app_config.value`` text (:func:`dump` / :func:`parse`). The
  formats match what the legacy per-setting services already write (``"1"`` /
  ``"0"`` for booleans, plain decimal strings), so both read the same rows;
* **JSON** — what the API sends and receives (:func:`coerce` / :func:`to_json`).
  Decimals travel as strings so no float ever touches a money value.

``Decimal`` end to end. Every invalid input raises :class:`SettingError`
(a ``ValueError``) with a short human message.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from typing import Literal


class SettingError(ValueError):
    """A value does not fit its setting's type, bounds or choices."""


class SettingType(StrEnum):
    BOOL = "bool"
    INT = "int"
    DECIMAL = "decimal"
    #: A fraction (``0.07`` = 7 %); bounds are fractions too.
    PERCENT = "percent"
    STRING = "string"
    ENUM = "enum"
    SYMBOL = "symbol"
    SYMBOL_LIST = "symbol_list"
    #: Fractions, e.g. projection scenarios.
    PERCENT_LIST = "percent_list"
    TIME_HM = "time_hm"
    DURATION_S = "duration_s"
    JSON_MAP = "json_map"


Level = Literal["user", "advanced"]
#: How an env value bounds the stored value (security settings): ``ceiling`` means
#: the app may only go lower than env, ``floor`` only higher.
EnvBound = Literal["ceiling", "floor"]

Typed = bool | int | Decimal | str | tuple[str, ...] | tuple[Decimal, ...] | dict[str, str] | None
JsonValue = bool | int | str | list[str] | dict[str, str] | None

_SYMBOL_RE = re.compile(r"^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_TRUE = frozenset({"1", "true", "yes", "on"})
_FALSE = frozenset({"0", "false", "no", "off"})
_MAX_STRING = 512
_MAX_LIST = 100


@dataclass(frozen=True)
class SettingDef:
    """One editable setting. ``default`` is a typed value (``None`` = unset)."""

    key: str
    type: SettingType
    default: Typed
    section: str
    label: str
    help: str = ""
    min: Decimal | None = None
    max: Decimal | None = None
    choices: tuple[str, ...] = ()
    level: Level = "user"
    secret: bool = False
    restart_required: bool = False
    #: Name of the bootstrap ``Settings`` field that supplies an env value.
    env_var: str | None = None
    env_bound: EnvBound | None = None
    danger: str | None = None
    nullable: bool = False
    since: str = "6.0"
    unit: str | None = None
    #: Extra check on a typed value (e.g. a timezone lookup); raise ``SettingError``.
    validator: Callable[[Typed], None] | None = field(default=None, compare=False)


# -- conversion ------------------------------------------------------------------


def _decimal(raw: object, key: str) -> Decimal:
    if isinstance(raw, bool | float):
        raise SettingError(f"{key}: send numbers as strings or integers")
    try:
        value = Decimal(str(raw).strip())
    except InvalidOperation as exc:
        raise SettingError(f"{key}: {raw!r} is not a number") from exc
    if not value.is_finite():
        raise SettingError(f"{key}: must be a finite number")
    return value


def _bounds(defn: SettingDef, value: Decimal) -> None:
    if defn.min is not None and value < defn.min:
        raise SettingError(f"{defn.key}: must be at least {defn.min}")
    if defn.max is not None and value > defn.max:
        raise SettingError(f"{defn.key}: must be at most {defn.max}")


def _symbol(raw: object, key: str) -> str:
    if not isinstance(raw, str):
        raise SettingError(f"{key}: symbol must be text")
    value = raw.strip().upper()
    if not _SYMBOL_RE.match(value):
        raise SettingError(f"{key}: {raw!r} is not a valid symbol")
    return value


def _items(raw: object, key: str) -> list[object]:
    if isinstance(raw, str):
        stripped = raw.strip()
        if stripped.startswith("["):
            try:
                loaded = json.loads(stripped)
            except ValueError as exc:
                raise SettingError(f"{key}: not a valid list") from exc
            raw = loaded
        else:
            return [p for p in (s.strip() for s in stripped.split(",")) if p]
    if not isinstance(raw, list | tuple):
        raise SettingError(f"{key}: expected a list")
    if len(raw) > _MAX_LIST:
        raise SettingError(f"{key}: at most {_MAX_LIST} entries")
    return list(raw)


def _coerce_value(defn: SettingDef, raw: object) -> Typed:  # noqa: PLR0911, PLR0912, PLR0915
    key, t = defn.key, defn.type
    if t is SettingType.BOOL:
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, int) and raw in (0, 1):
            return bool(raw)
        if isinstance(raw, str) and raw.strip().lower() in _TRUE | _FALSE:
            return raw.strip().lower() in _TRUE
        raise SettingError(f"{key}: expected true or false")
    if t in (SettingType.INT, SettingType.DURATION_S):
        number = _decimal(raw, key)
        if number != number.to_integral_value():
            raise SettingError(f"{key}: must be a whole number")
        _bounds(defn, number)
        return int(number)
    if t in (SettingType.DECIMAL, SettingType.PERCENT):
        number = _decimal(raw, key)
        _bounds(defn, number)
        return number
    if t is SettingType.ENUM:
        value = str(raw).strip() if isinstance(raw, str | int) else None
        if value is None or value not in defn.choices:
            raise SettingError(f"{key}: must be one of {', '.join(defn.choices)}")
        return value
    if t is SettingType.STRING:
        if not isinstance(raw, str):
            raise SettingError(f"{key}: expected text")
        value = raw.strip()
        if len(value) > _MAX_STRING:
            raise SettingError(f"{key}: at most {_MAX_STRING} characters")
        if defn.choices and value not in defn.choices:
            raise SettingError(f"{key}: must be one of {', '.join(defn.choices)}")
        return value
    if t is SettingType.SYMBOL:
        return _symbol(raw, key)
    if t is SettingType.SYMBOL_LIST:
        symbols = [_symbol(item, key) for item in _items(raw, key)]
        return tuple(dict.fromkeys(symbols))
    if t is SettingType.PERCENT_LIST:
        rates = []
        for item in _items(raw, key):
            rate = _decimal(item, key)
            _bounds(defn, rate)
            rates.append(rate)
        if not rates:
            raise SettingError(f"{key}: at least one value is needed")
        return tuple(rates)
    if t is SettingType.TIME_HM:
        if not isinstance(raw, str) or not _TIME_RE.match(raw.strip()):
            raise SettingError(f"{key}: expected a time as HH:MM")
        return raw.strip()
    if t is SettingType.JSON_MAP:
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except ValueError as exc:
                raise SettingError(f"{key}: not a valid JSON object") from exc
        if not isinstance(raw, dict) or len(raw) > _MAX_LIST:
            raise SettingError(f"{key}: expected an object of at most {_MAX_LIST} entries")
        out: dict[str, str] = {}
        for k, v in raw.items():
            if not isinstance(k, str) or not isinstance(v, str):
                raise SettingError(f"{key}: keys and values must be text")
            if len(k) > _MAX_STRING or len(v) > _MAX_STRING:
                raise SettingError(f"{key}: entries are too long")
            out[k.strip()] = v.strip()
        return out
    raise SettingError(f"{key}: unsupported type {t}")  # pragma: no cover


def coerce(defn: SettingDef, raw: object) -> Typed:
    """Validate a JSON/API value (or stored text) into the typed value."""
    if raw is None or (isinstance(raw, str) and raw.strip() == "" and defn.nullable):
        if defn.nullable:
            return None
        raise SettingError(f"{defn.key}: a value is required")
    value = _coerce_value(defn, raw)
    if defn.validator is not None:
        defn.validator(value)
    return value


def parse(defn: SettingDef, stored: str | None) -> Typed:
    """Typed value from ``app_config`` text (``None`` -> ``None``)."""
    if stored is None:
        return None
    return coerce(defn, stored)


def dump(defn: SettingDef, value: Typed) -> str | None:
    """Stored text for a typed value (the format legacy services read)."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, tuple):
        return ",".join(format(v, "f") if isinstance(v, Decimal) else str(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    return str(value)


def to_json(value: Typed) -> JsonValue:
    """JSON-safe form: decimals as strings, tuples as lists."""
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, tuple):
        return [format(v, "f") if isinstance(v, Decimal) else str(v) for v in value]
    if isinstance(value, dict):
        return dict(value)
    return value


def bounded(defn: SettingDef, value: Typed, env_value: Typed) -> Typed:
    """Apply an env ceiling/floor: the app may only make the value stricter."""
    if defn.env_bound is None or env_value is None or value is None:
        return value
    if not isinstance(value, int | Decimal) or not isinstance(env_value, int | Decimal):
        return value
    if defn.env_bound == "ceiling":
        return min(value, env_value)
    return max(value, env_value)


def check_catalogue(defs: Mapping[str, SettingDef], sections: frozenset[str]) -> list[str]:
    """Structural problems in a catalogue (empty list = fine)."""
    problems: list[str] = []
    for key, defn in defs.items():
        if key != defn.key:
            problems.append(f"{key}: key mismatch")
        if len(key) > 64:
            problems.append(f"{key}: longer than the app_config key column")
        if defn.section not in sections:
            problems.append(f"{key}: unknown section {defn.section}")
        if defn.type is SettingType.ENUM and not defn.choices:
            problems.append(f"{key}: enum without choices")
        if defn.default is None and not (defn.nullable or defn.secret):
            problems.append(f"{key}: no default")
        if defn.default is not None:
            try:
                coerce(defn, to_json(defn.default))
            except SettingError as exc:
                problems.append(f"{key}: default invalid ({exc})")
    return problems
