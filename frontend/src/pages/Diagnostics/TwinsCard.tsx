import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { Skeleton } from "../../components/Skeleton";
import { formatDate, formatDateTime } from "../../lib/format";
import { toNum } from "../../lib/queries/portfolio";
import { useTwinHealth, type TwinFundHealth, type TwinHealth } from "../../lib/queries/maintenance";

/** A divergence figure already in percentage points (not a fraction), signed. */
function Pp({ value }: { value: string | null | undefined }) {
  const n = toNum(value ?? null);
  if (n === null) return <>—</>;
  const sign = n > 0 ? "+" : "";
  return (
    <>
      {sign}
      {n.toFixed(2)} pp
    </>
  );
}

function Fund({ fund, window }: { fund: TwinFundHealth; window: number }) {
  const d = fund.divergence;
  return (
    <li className="twins__fund">
      <div className="twins__fund-head">
        <span className="twins__pair">
          <strong>{fund.symbol}</strong> ≈ {fund.twin_symbol}
        </span>
        {fund.estimating ? (
          <span className="twins__state twins__state--on">estimating now</span>
        ) : (
          <span className="twins__state">NAV posted</span>
        )}
      </div>
      <p className="twins__name">{fund.name}</p>
      <dl className="twins__facts">
        <div className="twins__fact">
          <dt className="twins__fact-key">Stored sessions</dt>
          <dd className="twins__fact-value">
            {fund.stored_sessions}
            {fund.first_session && fund.last_session
              ? ` · ${formatDate(fund.first_session)} to ${formatDate(fund.last_session)}`
              : ""}
          </dd>
        </div>
        <div className="twins__fact">
          <dt className="twins__fact-key">Newest twin price</dt>
          <dd className="twins__fact-value">{fund.last_price_at ? formatDateTime(fund.last_price_at) : "none stored"}</dd>
        </div>
        <div className="twins__fact">
          <dt className="twins__fact-key">Year history</dt>
          <dd className="twins__fact-value">{fund.year_backfill_done ? "backfilled" : "not backfilled yet"}</dd>
        </div>
      </dl>
      {d ? (
        <p className="twins__gap">
          Last gap <Pp value={d.last_gap_pp} /> on {formatDate(d.last_date)} · typical{" "}
          {toNum(d.median_abs_pp)?.toFixed(2) ?? "—"} pp · bias <Pp value={d.bias_pp} /> over{" "}
          {d.sessions} of {window} sessions.
        </p>
      ) : (
        <p className="twins__muted">
          No accuracy yet: the fund and its twin need a session both have a close for.
        </p>
      )}
    </li>
  );
}

function Body({ h }: { h: TwinHealth }) {
  if (h.funds.length === 0) {
    return (
      <p className="twins__lead">
        No fund has an ETF twin yet. Map one on a holding’s page to have its value estimated while
        its NAV is still unpublished.
      </p>
    );
  }
  return (
    <>
      <p className="twins__lead">
        {h.enabled ? (
          <>
            Mutual funds publish a NAV once a day and late, so until it arrives each fund below is
            valued from its ETF twin’s live price, and the Overview total is an estimate.
          </>
        ) : (
          <>
            Twin estimates are <strong>off</strong>, so every page shows the official NAV even while
            it is stale. The accuracy below keeps being measured, so you can judge a twin before
            switching estimates back on in <strong>Settings → Data refresh</strong>.
          </>
        )}
      </p>
      <ul className="twins__list">
        {h.funds.map((f) => (
          <Fund key={f.instrument_id} fund={f} window={h.window} />
        ))}
      </ul>
      <p className="twins__muted">
        A gap is the twin’s return minus the fund’s, so a positive bias means the twin runs high and
        the estimate reads rich. Fix a bad twin under <strong>Providers</strong> and{" "}
        <strong>Cache</strong> below: “Refresh ETF twin prices now”, “Re-download ETF twin history”
        and “Clear stored twin prices”.
      </p>
    </>
  );
}

/** Health & Repair: which funds lean on an ETF twin, and how well the twin tracks them. */
export function TwinsCard() {
  const q = useTwinHealth();
  return (
    <Card title="ETF twins" collapsibleId="repair.twins">
      {q.isPending ? (
        <Skeleton height="120px" />
      ) : q.data ? (
        <div className="twins">
          <Body h={q.data} />
        </div>
      ) : (
        <ErrorState onRetry={() => void q.refetch()} />
      )}
    </Card>
  );
}
