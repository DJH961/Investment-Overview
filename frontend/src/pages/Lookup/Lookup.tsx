import { Inbox } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { Chart } from "../../components/Chart";
import { Chip } from "../../components/Chip";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { formatStamp } from "../../components/Freshness";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Skeleton } from "../../components/Skeleton";
import { type TabItem, Tabs } from "../../components/Tabs";
import { ApiError } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { HOLDING_RANGES, type HoldingRange } from "../../lib/queries/holding-detail";
import { type LookupHistoryDto, type LookupQuoteDto, useLookupHistory, useLookupQuote } from "../../lib/queries/lookup";
import { toNum } from "../../lib/queries/portfolio";
import { HoldingHeader } from "../Holding/HoldingHeader";
import { axisFormat, chartSessions, rangeLabel, tooltipFormat } from "../Holding/holdingFormat";
import "../Holding/Holding.scss";
import "./Lookup.scss";

type LookupTab = "performance" | "details";
const TABS: LookupTab[] = ["performance", "details"];

/**
 * One point in another currency, at that point's own EUR/USD rate (one instant, one
 * rate: AGENTS.md allows it). `fx` is dollars per euro.
 */
export function convertAt(price: number | null, native: string, target: string, fx: number | null): number | null {
  if (price === null) return null;
  if (target === native) return price;
  if (fx === null || fx === 0) return null;
  if (native === "USD" && target === "EUR") return price / fx;
  if (native === "EUR" && target === "USD") return price * fx;
  return null;
}

function PriceChart({ symbol, quote }: { symbol: string; quote: LookupQuoteDto }) {
  const [range, setRange] = useState<HoldingRange>("1y");
  const native = quote.currency ?? "USD";
  const convertible = native === "USD" || native === "EUR";
  const options = convertible ? (native === "USD" ? ["USD", "EUR"] : ["EUR", "USD"]) : [native];
  const [shown, setShown] = useState(native);
  const q = useLookupHistory(symbol, range);
  const data: LookupHistoryDto | undefined = q.data;
  const points = useMemo(
    () =>
      (data?.points ?? []).map((p) => ({
        t: p.t,
        v: convertAt(toNum(p.price_native), native, shown, toNum(p.fx_eur_usd)),
      })),
    [data, native, shown],
  );
  const sessions = chartSessions(data?.sessions);
  return (
    <section className="holding-page__section holding-page__chart" aria-label="Price chart">
      <Chart
        series={[{ id: "price", label: `${symbol} price`, tone: "primary", points }]}
        range={range}
        ranges={HOLDING_RANGES}
        rangeLabel={rangeLabel}
        onRangeChange={(r) => setRange(r as HoldingRange)}
        headerExtra={
          options.length > 1 ? (
            <SegmentedControl ariaLabel="Price in" size="sm" options={options.map((o) => ({ value: o, label: o }))} value={shown} onChange={setShown} />
          ) : undefined
        }
        xMode={data?.x_mode === "time" && sessions.length ? "session" : (data?.x_mode ?? "date")}
        sessions={sessions}
        loading={q.isPending}
        busy={q.isFetching && !q.isPending}
        valueFormat={(v) => formatMoney(v, shown, { unmasked: true })}
        timeFormat={axisFormat(range, data?.x_mode)}
        tooltipTimeFormat={tooltipFormat(range, data?.x_mode)}
        height={240}
        ariaLabel={`${symbol} price`}
        emptyMessage={q.isError ? "Could not load the price history." : "No prices for this range."}
      />
      {shown !== native && (
        <p className="holding-page__note">Each point in {shown} at that moment&apos;s EUR/USD rate.</p>
      )}
    </section>
  );
}

function Details({ quote }: { quote: LookupQuoteDto }) {
  const low = toNum(quote.week52_low);
  const high = toNum(quote.week52_high);
  const price = toNum(quote.price_native);
  // Where today's price sits in the 52-week range (a position on a bar, display only).
  const at = low !== null && high !== null && price !== null && high > low ? Math.min(1, Math.max(0, (price - low) / (high - low))) : null;
  const ccy = quote.currency ?? "USD";
  const money = (v: number | null) => formatMoney(v, ccy, { unmasked: true });
  return (
    <section className="holding-page__section" aria-labelledby="lookup-details">
      <h2 id="lookup-details" className="holding-page__section-title">
        Details
      </h2>
      <dl className="holding-page__facts">
        <div className="holding-page__fact">
          <dt className="holding-page__fact-key">Exchange</dt>
          <dd className="holding-page__fact-value">{quote.exchange ?? "–"}</dd>
        </div>
        <div className="holding-page__fact">
          <dt className="holding-page__fact-key">Currency</dt>
          <dd className="holding-page__fact-value">{ccy}</dd>
        </div>
        <div className="holding-page__fact">
          <dt className="holding-page__fact-key">Type</dt>
          <dd className="holding-page__fact-value">{quote.type ?? "–"}</dd>
        </div>
        <div className="holding-page__fact lookup-page__range">
          <dt className="holding-page__fact-key">52-week range</dt>
          <dd className="holding-page__fact-value">
            {money(low)} – {money(high)}
            {at !== null && (
              <span className="lookup-page__range-bar" aria-hidden>
                <span className="lookup-page__range-mark" style={{ left: `${at * 100}%` }} />
              </span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** Any instrument, not held (7.1, P20): price only, nothing from the portfolio. */
export function Lookup() {
  const { symbol: raw = "", tab } = useParams();
  const symbol = decodeURIComponent(raw).toUpperCase();
  const navigate = useNavigate();
  const quote = useLookupQuote(symbol);
  if (tab !== undefined && !TABS.includes(tab as LookupTab)) return <Navigate to={`/lookup/${raw}`} replace />;
  const active: LookupTab = (tab as LookupTab | undefined) ?? "performance";
  const back = { to: "/holdings", label: "Holdings" };

  if (quote.isPending) {
    return (
      <div className="holding-page">
        <Skeleton height="12rem" />
      </div>
    );
  }
  if (quote.isError || !quote.data) {
    return (
      <div className="holding-page">
        {quote.isError && !(quote.error instanceof ApiError && quote.error.status === 404) ? (
          <ErrorState message="Could not look this symbol up." onRetry={() => void quote.refetch()} />
        ) : (
          <EmptyState
            icon={<Inbox aria-hidden />}
            title={`Nothing found for ${symbol}`}
            description="Check the symbol, or search for the name instead."
            action={<Link to="/holdings">Back to Holdings</Link>}
          />
        )}
      </div>
    );
  }
  const d = quote.data;
  const ccy = d.currency ?? "USD";
  const items: TabItem<LookupTab>[] = [
    { value: "performance", label: "Performance", content: active === "performance" ? <PriceChart symbol={symbol} quote={d} /> : null },
    { value: "details", label: "Details", content: active === "details" ? <Details quote={d} /> : null },
  ];
  return (
    <div className="holding-page">
      <HoldingHeader
        symbol={d.symbol}
        name={d.name ?? d.symbol}
        back={back}
        chips={
          <>
            <Chip size="sm" tone="accent">
              Not held
            </Chip>
            {d.exchange && (
              <Chip size="sm" outline>
                {d.exchange}
              </Chip>
            )}
            <Chip size="sm" outline>
              {ccy}
            </Chip>
            {d.type && (
              <Chip size="sm" outline>
                {d.type}
              </Chip>
            )}
            {d.captured_at && <span className="holding-page__muted lookup-page__stamp">Price {formatStamp(d.captured_at)}</span>}
          </>
        }
        value={formatMoney(toNum(d.price_native), ccy, { unmasked: true })}
        today={
          <>
            <span>{formatMoney(toNum(d.day_change_native), ccy, { unmasked: true, signed: true })}</span>
            <Percent ratio={toNum(d.day_pct)} signed colored />
          </>
        }
      />
      <Tabs
        items={items}
        value={active}
        ariaLabel="Instrument views"
        onChange={(t) => navigate(t === "performance" ? `/lookup/${raw}` : `/lookup/${raw}/${t}`, { replace: true })}
      />
    </div>
  );
}
