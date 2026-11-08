import { Card } from "../Card";
import { DivergingBar, type DivergingBarRow } from "../DivergingBar";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { formatAxisDate, formatDayLabel, formatNumber, formatTime, formatWeekdayTime, todayIn } from "../../lib/format";
import { toNum, type OverviewDto } from "../../lib/queries/portfolio";
import { useTimeZone } from "../../lib/timezone";
import "./CurrencyBox.scss";

type Today = OverviewDto["currency"]["today"];

export interface CurrencyBoxProps {
  data: OverviewDto;
}

const MOVE_SUB = { prev_close: "since last close", overnight: "overnight", session_open: "since last open" } as const;

function moveLabel(move: NonNullable<Today["move"]>): string {
  if (move.label_kind === "yesterday") return "Yesterday";
  if (move.label_kind === "weekday") return formatDayLabel(move.session_date, "weekday");
  return "Today";
}

/** "since yesterday" / "yesterday" / "on Friday" / "since Friday". */
export function sincePhrase(p: Today["since_phrase"]): string {
  if (!p) return "since yesterday";
  const day = formatDayLabel(p.session_date, "weekday");
  if (p.kind === "yesterday") return "yesterday";
  if (p.kind === "on_day") return `on ${day}`;
  if (p.kind === "since_day") return `since ${day}`;
  return "since yesterday";
}

/**
 * The two legs (market hours / overnight) with the currently live one first,
 * or a single full-width bar on a US-only market holiday. Mirrors NiceGUI
 * `_fx_diverge_bar`. Returns [] when there is no split to draw.
 */
export function legRows(
  today: Today,
  legs: { net?: string | null; market_hours?: string | null; overnight?: string | null },
  fmt: (v: number) => DivergingBarRow["display"],
): DivergingBarRow[] {
  const { regime } = today;
  const net = toNum(legs.net);
  if (regime.single_overnight) {
    if (net === null) return [];
    const label = regime.holiday ? "Market holiday" : "Overnight";
    return [{ id: "overnight", label, value: net, display: fmt(net), tag: "live", striped: true, width: 1 }];
  }
  const market = toNum(legs.market_hours);
  const overnight = toNum(legs.overnight);
  if (market === null || overnight === null || (market === 0 && overnight === 0)) return [];
  const liveTag = regime.forex_open ? "live" : "paused";
  const marketRow: DivergingBarRow = { id: "market", label: "Market hours", value: market, display: fmt(market) };
  const nightRow: DivergingBarRow = {
    id: "overnight",
    label: "Overnight",
    value: overnight,
    display: fmt(overnight),
    striped: true,
  };
  return regime.market_open
    ? [{ ...marketRow, tag: liveTag }, { ...nightRow, tag: "last" }]
    : [{ ...nightRow, tag: liveTag }, { ...marketRow, tag: "last" }];
}

/**
 * Resolve an ISO timestamp for ``asOf``: live observation instant first, else
 * ``spot_observed_at``, else the ECB 16:00 CET reference-fixing time on ``asOf.as_of``
 * so even an EOD fallback always carries a timestamp from when its rate was fixed.
 */
function resolveIsoStamp(asOf: Today["as_of"], observedAt?: string | null): string | null {
  if (asOf?.observed_at) return asOf.observed_at;
  if (observedAt) return observedAt;
  if (asOf?.as_of) return `${asOf.as_of}T15:00:00Z`;
  return null;
}

function AsOfStamp({
  asOf,
  observedAt,
  frozen,
  timeZone,
}: {
  asOf: Today["as_of"];
  observedAt?: string | null;
  frozen?: boolean;
  timeZone?: string;
}) {
  const isoStamp = resolveIsoStamp(asOf, observedAt);
  if (!asOf && !isoStamp) return null;
  let label: string;
  if (frozen && isoStamp) {
    label = formatWeekdayTime(isoStamp, timeZone);
  } else if (asOf?.source === "eod" && asOf.as_of) {
    const datePart = asOf.as_of === todayIn(timeZone) ? "Today" : formatAxisDate(Date.parse(asOf.as_of), 0);
    label = isoStamp ? `${datePart}, ${formatTime(isoStamp, timeZone)}` : datePart;
  } else if (isoStamp) {
    label = formatTime(isoStamp, timeZone);
  } else if (asOf?.source === "live" || asOf?.as_of === todayIn(timeZone)) {
    label = "Today";
  } else if (asOf) {
    label = formatAxisDate(Date.parse(asOf.as_of), 0);
  } else {
    return null;
  }
  return (
    <span className="currency-box__sub">
      <span className="currency-box__as-of">as of {label}</span>
    </span>
  );
}

function HeaderStamp({
  asOf,
  observedAt,
  frozen,
  timeZone,
}: {
  asOf: Today["as_of"];
  observedAt?: string | null;
  frozen?: boolean;
  timeZone?: string;
}) {
  const isoStamp = resolveIsoStamp(asOf, observedAt);
  const eodBadge =
    asOf?.source === "eod" ? (
      <span className="currency-box__eod" title="End-of-day ECB reference rate">
        EOD FX
      </span>
    ) : null;
  if (frozen) {
    return (
      <span className="currency-box__header-badges">
        <span className="currency-box__closed">Market closed</span>
        {eodBadge}
      </span>
    );
  }
  if (eodBadge) {
    return <span className="currency-box__header-badges">{eodBadge}</span>;
  }
  if (asOf?.source === "live" && isoStamp) {
    return (
      <span className="currency-box__header-badges">
        <span className="currency-box__stamp currency-box__stamp--live">Live · {formatTime(isoStamp, timeZone)}</span>
      </span>
    );
  }
  return null;
}

function EffectPanel({ data }: { data: OverviewDto }) {
  const today = data.currency.today;
  const phrase = sincePhrase(today.since_phrase);
  const ip = today.investing_power_usd;
  const amount = toNum(ip?.amount_eur);
  const amountUsd = toNum(ip?.amount_usd);
  const amountLine =
    data.ccy === "USD" && amount !== null ? (
      <p className="currency-box__amount" data-ccy-specific>
        <span>
          Regular <Money amount={amount} currency="EUR" digits={Number.isInteger(amount) ? 0 : 2} />
        </span>
        {amountUsd !== null && (
          <span>
            <Money amount={amountUsd} currency="USD" /> today
          </span>
        )}
      </p>
    ) : null;
  if (data.ccy === "USD") {
    const net = toNum(ip?.net);
    if (!ip || net === null) return null;
    const digits = Math.abs(net) < 100 ? 2 : 0;
    const fmt = (v: number) => <Money amount={v} currency="USD" signed colored digits={digits} />;
    const title = `Investing power ${phrase}`;
    return (
      <section className="currency-box__effect" aria-label={title}>
        <div className="currency-box__effect-head">
          <span className="currency-box__effect-title">{title}</span>
          <span className="currency-box__effect-net">{fmt(net)}</span>
        </div>
        <DivergingBar rows={legRows(today, ip, fmt)} ariaLabel="Market hours versus overnight" />
        {amountLine}
      </section>
    );
  }
  const legs = today.effect_eur;
  const net = toNum(legs?.net);
  if (!legs || net === null) return null;
  const fmt = (v: number) => <Money amount={v} currency="EUR" signed colored digits={0} />;
  const title = `Currency effect ${phrase}`;
  return (
    <section className="currency-box__effect" aria-label={title}>
      <div className="currency-box__effect-head">
        <span className="currency-box__effect-title">{title}</span>
        <span className="currency-box__effect-net">{fmt(net)}</span>
      </div>
      <DivergingBar rows={legRows(today, legs, fmt)} ariaLabel="Market hours versus overnight" />
    </section>
  );
}

/**
 * The daily "Currency · EUR ↔ USD" box (NiceGUI `_currency_box_html`): spot pair
 * with provenance stamp, the regime-aware move and since-open/close stat, the
 * weekend freeze, and the currency effect (EUR) / investing power (USD) split
 * into market hours and overnight.
 */
export function CurrencyBox({ data }: CurrencyBoxProps) {
  const timeZone = useTimeZone();
  const today = data.currency.today;
  const frozen = today.regime?.forex_frozen ?? false;
  const spot = toNum(today.spot_display ?? null);
  const effect = today.regime ? <EffectPanel data={data} /> : null;

  return (
    <Card
      className="currency-box"
      title="Currency · EUR ↔ USD"
      collapsibleId="overview.currency"
      actions={
        <HeaderStamp
          asOf={today.as_of}
          observedAt={today.spot_observed_at}
          frozen={frozen}
          timeZone={timeZone}
        />
      }
    >
      <div className={effect ? "currency-box__body" : "currency-box__body currency-box__body--single"}>
        <div className="currency-box__left">
          <dl className="currency-box__stats">
            <div className="currency-box__stat">
              <dt className="currency-box__label">{today.pair ?? (data.ccy === "USD" ? "EUR/USD" : "USD/EUR")}</dt>
              <dd className="currency-box__value">{formatNumber(spot, 4)}</dd>
              <dd className="currency-box__meta">
                <AsOfStamp
                  asOf={today.as_of}
                  observedAt={today.spot_observed_at}
                  frozen={frozen}
                  timeZone={timeZone}
                />
              </dd>
            </div>
            {today.move && (
              <div className="currency-box__stat">
                <dt className="currency-box__label">{moveLabel(today.move)}</dt>
                <dd className="currency-box__value">
                  <Percent ratio={toNum(today.move.pct)} signed colored />
                </dd>
                <dd className="currency-box__meta">
                  <span className="currency-box__sub">{MOVE_SUB[today.move.anchor_kind]}</span>
                </dd>
              </div>
            )}
            {today.since && (
              <div className="currency-box__stat">
                <dt className="currency-box__label">{today.since.kind === "open" ? "Since open" : "Since close"}</dt>
                <dd className="currency-box__value">
                  <Percent ratio={toNum(today.since.pct)} signed colored />
                </dd>
                <dd className="currency-box__meta">
                  <span className="currency-box__sub">rate move</span>
                </dd>
              </div>
            )}
          </dl>
          {frozen && (
            <p className="currency-box__reopen">
              Frozen at Friday&apos;s close
              {today.reopen_at ? ` · reopens ${formatWeekdayTime(today.reopen_at, timeZone)}` : ""}
            </p>
          )}
          {today.anchor_missing && (
            <p className="currency-box__warning">The previous close rate is missing; the move uses the best earlier rate.</p>
          )}
        </div>
        {effect}
      </div>
    </Card>
  );
}
