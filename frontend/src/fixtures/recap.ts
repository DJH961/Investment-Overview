/**
 * Fixture answers for `GET /api/recap` (7.4 P8) until the recorder writes them: built
 * from the recorded Periods rows, so the card's contributed, dividends, returns and
 * values are the Periods page's. Market and currency split the row's growth (made-up
 * shares, roughly like the Impact section); the real return uses a synthetic euro-area
 * index rising 0.2 % a month, published to the month before the recording.
 *
 * Switch (remembered for the tab): `?recap=on` (the Overview card is due, the default)
 * or `?recap=off`. Dismissing it acknowledges it for the tab, as the server would.
 */

type Obj = Record<string, unknown>;
type Row = {
  label: string;
  is_current: boolean;
  contributions: string | null;
  dividends: string | null;
  interest: string | null;
  net_flow: string | null;
  opening_value: string | null;
  closing_value: string | null;
  growth_pct: string | null;
};

const INFLATION = 1.002;
const num = (v: string | null | undefined) => (v == null ? null : Number(v));
const s = (v: number | null, digits = 6) => (v === null ? null : v.toFixed(digits));

function rows(data: Obj, kind: "monthly" | "yearly", ccy: "EUR" | "USD"): Row[] {
  const key = Object.keys(data).find((k) => k.startsWith(`GET /api/periods/${kind}/both`));
  const both = (key ? data[key] : undefined) as Record<string, { rows?: Row[] }> | undefined;
  return both?.[ccy]?.rows ?? [];
}

/** The last month with a published index: the month before the newest recorded one. */
function lastIndexMonth(months: Row[]): string | null {
  const labels = months.map((r) => r.label).sort();
  return labels.length > 1 ? labels[labels.length - 2] : null;
}

const monthsIn = (label: string, to: string): number => {
  if (label.length === 7) return label <= to ? 1 : 0;
  const end = `${label}-12` <= to ? 12 : to.startsWith(label) ? Number(to.slice(5, 7)) : 0;
  return end;
};

function side(row: Row | undefined, ccy: "EUR" | "USD", indexTo: string | null): Obj {
  const eur = ccy === "EUR";
  const open = num(row?.opening_value) ?? 0;
  const close = num(row?.closing_value);
  const flow = num(row?.net_flow) ?? 0;
  const growth = num(row?.growth_pct);
  const move = close === null ? null : close - open - flow;
  // The euro view gives a share of the move to the dollar (the dollar view has none).
  const currency = move === null || !eur ? 0 : -Math.abs(move) * 0.18 + open * 0.0011;
  const n = row && indexTo ? monthsIn(row.label, indexTo) : 0;
  const real = eur && growth !== null && n > 0 ? (1 + growth) / INFLATION ** n - 1 : null;
  const contributed = num(row?.contributions);
  const conversions = row && contributed ? (row.label.length === 4 ? 12 : 1) : 0;
  const realTo = real === null || !indexTo || !row ? null : row.label.length === 7 ? row.label : n === 12 ? `${row.label}-12` : indexTo;
  return {
    contributed: row?.contributions ?? null,
    cashed_out: "0",
    market: move === null ? null : s(move - currency),
    currency: eur ? s(currency) : "0",
    dividends: row?.dividends ?? null,
    interest: row?.interest ?? null,
    conversion_cost: conversions ? s((contributed ?? 0) * (eur ? 0.0042 : 0.0045)) : null,
    conversions,
    opening_value: row?.opening_value ?? null,
    closing_value: row?.closing_value ?? null,
    nominal_return: row?.growth_pct ?? null,
    real_return: s(real, 10),
    real_to: realTo,
  };
}

export function recapFixture(data: Obj, period: string | null, due: boolean, lastAck: string | null): Obj {
  const months = rows(data, "monthly", "EUR");
  const finished = months.filter((r) => !r.is_current);
  const fallback = finished.length ? finished[finished.length - 1].label : (months[0]?.label ?? "2026-05");
  const label = period ?? fallback;
  const kind = label.length === 4 ? "yearly" : "monthly";
  const pick = (ccy: "EUR" | "USD") => rows(data, kind, ccy).find((r) => r.label === label);
  const indexTo = lastIndexMonth(months);
  const year = Number(label.slice(0, 4));
  const month = label.length === 7 ? Number(label.slice(5, 7)) : 12;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const start = label.length === 4 ? `${label}-01-01` : `${label}-01`;
  const eur = pick("EUR");
  return {
    period: label,
    granularity: label.length === 4 ? "year" : "month",
    start,
    end,
    is_complete: !(eur?.is_current ?? false),
    has_data: Boolean(eur),
    due: due && label === fallback && Boolean(eur),
    default_period: fallback,
    last_ack: lastAck,
    EUR: side(eur, "EUR", indexTo),
    USD: side(pick("USD"), "USD", indexTo),
  };
}
