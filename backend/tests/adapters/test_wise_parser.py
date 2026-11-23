# ruff: noqa: PT018
"""Wise statement parser: both conversion shapes, skipped rows, dedupe, hand mapping."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

from investment_dashboard.adapters.wise.parser import WiseRow, parse_statement

D = Decimal
_FIXTURE = Path(__file__).parent.parent / "fixtures" / "wise_statement.csv"


def _by_id(rows: tuple[WiseRow, ...]) -> dict[str, list[WiseRow]]:
    out: dict[str, list[WiseRow]] = {}
    for r in rows:
        out.setdefault(r.external_id, []).append(r)
    return out


def test_fixture_rows_classified() -> None:
    st = parse_statement(_FIXTURE.read_bytes())
    assert st.missing == ()
    ids = _by_id(st.rows)
    assert len(st.rows) == 8
    # the duplicate conversion: the EUR row (fee stated) is used, the USD row skipped
    conv = [r for r in ids["CONVERSION_ORDER-111"] if r.status == "conversion"]
    assert len(conv) == 1 and conv[0].fee_stated
    assert conv[0].amounts is not None
    assert (conv[0].amounts.eur_sent, conv[0].amounts.fees_eur) == (D("198.89"), D("1.11"))
    assert conv[0].amounts.usd_received == D("215.73")
    other = [r for r in ids["CONVERSION_ORDER-111"] if r.status != "conversion"]
    assert len(other) == 1 and other[0].status == "skipped"
    assert "Same conversion" in (other[0].reason or "")
    assert conv[0].on == date(2023, 11, 14)


def test_send_with_conversion_shape() -> None:
    (row,) = _by_id(parse_statement(_FIXTURE.read_bytes()).rows)["TRANSFER-222"]
    assert row.status == "conversion" and row.sent_on
    assert row.amounts is not None
    assert (row.amounts.eur_sent, row.amounts.fees_eur, row.amounts.usd_received) == (
        D("297.66"),
        D("2.34"),
        D("348.86"),
    )


def test_hidden_fee_row_alone() -> None:
    (row,) = _by_id(parse_statement(_FIXTURE.read_bytes()).rows)["CONVERSION_ORDER-777"]
    assert row.amounts is not None and not row.fee_stated
    # 108.00 / 1.08 = 100.00 exactly: nothing hidden
    assert (row.amounts.eur_sent, row.amounts.fees_eur) == (D("100.00"), D("0.00"))


def test_hidden_fee_from_the_usd_statement_only() -> None:
    lines = _FIXTURE.read_text(encoding="utf-8").splitlines()
    only_usd = "\n".join([lines[0], lines[1]])
    (row,) = parse_statement(only_usd.encode()).rows
    assert row.status == "conversion" and not row.fee_stated and row.amounts is not None
    assert (row.amounts.eur_sent, row.amounts.fees_eur) == (D("198.89"), D("1.11"))


def test_not_conversions_are_skipped_with_a_reason() -> None:
    ids = _by_id(parse_statement(_FIXTURE.read_bytes()).rows)
    for key, word in (
        ("DEPOSIT-333", "deposit"),
        ("CARD-444", "Card payment"),
        ("TRANSFER-555", "without a conversion"),
    ):
        (r,) = ids[key]
        assert r.status == "skipped" and word in (r.reason or "")


def test_other_currency_pair_follows_the_setting() -> None:
    raw = _FIXTURE.read_bytes()
    (ignored,) = _by_id(parse_statement(raw, ignore_other_pairs=True).rows)["CONVERSION_ORDER-666"]
    assert ignored.status == "ignored"
    (unsupported,) = _by_id(parse_statement(raw, ignore_other_pairs=False).rows)[
        "CONVERSION_ORDER-666"
    ]
    assert unsupported.status == "unsupported" and "only EUR to USD" in (unsupported.reason or "")


def test_tab_separated_reads_the_same() -> None:
    text = _FIXTURE.read_text(encoding="utf-8").replace(",", "\t")
    a = parse_statement(text.encode())
    b = parse_statement(_FIXTURE.read_bytes())
    assert [(r.external_id, r.status, r.amounts) for r in a.rows] == [
        (r.external_id, r.status, r.amounts) for r in b.rows
    ]


def test_changed_layout_can_be_mapped_by_hand() -> None:
    text = (
        _FIXTURE.read_text(encoding="utf-8")
        .replace("TransferWise ID", "Ref")
        .replace("Exchange To Amount", "Bought")
    )
    st = parse_statement(text.encode())
    assert set(st.missing) == {"id", "exchange_to_amount"}
    assert st.rows == ()
    fixed = parse_statement(
        text.encode(),
        mapping={"id": st.headers.index("Ref"), "exchange_to_amount": st.headers.index("Bought")},
    )
    assert fixed.missing == () and len(fixed.rows) == 8
