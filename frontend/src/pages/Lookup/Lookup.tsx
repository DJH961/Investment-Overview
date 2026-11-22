import { Inbox } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import { Chart } from "../../components/Chart";
import { Chip } from "../../components/Chip";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { formatStamp } from "../../components/Freshness";
import { Percent } from "../../components/Percent";
import { Skeleton } from "../../components/Skeleton";
import { type TabItem, Tabs } from "../../components/Tabs";
import { ApiError } from "../../lib/api";
import { formatDate, formatMoney } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import { HOLDING_RANGES, type HoldingRange } from "../../lib/queries/holding-detail";
import { type LookupHistoryDto, type LookupQuoteDto, useLookupHistory, useLookupQuote } from "../../lib/queries/lookup";
import { toNum } from "../../lib/queries/portfolio";
import { BackLink, backTargetFromState, HoldingHeader } from "../Holding/HoldingHeader";
import { axisFormat, chartSessions, chartXMode, rangeLabel, tooltipFormat } from "../Holding/holdingFormat";
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
  // Follows the app's EUR / USD switch; other currencies stay native.
  const { currency } = usePrefs();
  const shown = native === "USD" || native === "EUR" ? currency : native;
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
        xMode={chartXMode(data?.x_mode, sessions)}
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
      <h2 id="lookup-details" className="holding-page__sr">
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
  const location = useLocation();
  const navigate = useNavigate();
  const back = backTargetFromState(location.state);
  const quote = useLookupQuote(symbol);
  if (tab !== undefined && !TABS.includes(tab as LookupTab)) return <Navigate to={`/lookup/${raw}`} replace state={location.state} />;
  const active: LookupTab = (tab as LookupTab | undefined) ?? "performance";

  if (quote.isPending) {
    return (
      <div className="holding-page">
        <BackLink to={back.to} label={back.label} />
        <Skeleton height="12rem" />
      </div>
    );
  }
  if (quote.isError || !quote.data) {
    return (
      <div className="holding-page">
        <BackLink to={back.to} label={back.label} />
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
        pills={
          <Chip size="sm" tone="accent">
            Not held
          </Chip>
        }
        chips={
          <>
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
          </>
        }
        value={formatMoney(toNum(d.price_native), ccy, { unmasked: true })}
        today={
          <>
            <span>{formatMoney(toNum(d.day_change_native), ccy, { unmasked: true, signed: true })}</span>
            <Percent ratio={toNum(d.day_pct)} signed colored />
            {d.captured_at && <span className="holding-page__muted lookup-page__stamp">{formatStamp(d.captured_at)}</span>}
          </>
        }
      />
      {d.last_held_on && (
        <p className="holding-page__muted lookup-page__sold">
          You held this until {formatDate(d.last_held_on)}.{" "}
          <Link to={`/transactions?symbol=${encodeURIComponent(d.symbol)}`}>See its transactions</Link>
        </p>
      )}
      <Tabs
        items={items}
        value={active}
        ariaLabel="Instrument views"
        onChange={(t) =>
          navigate(t === "performance" ? `/lookup/${raw}` : `/lookup/${raw}/${t}`, {
            replace: true,
            state: location.state,
          })
        }
      />
    </div>
  );
}
