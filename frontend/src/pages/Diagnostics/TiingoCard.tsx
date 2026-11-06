import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { Skeleton } from "../../components/Skeleton";
import { formatDateTime, formatTime } from "../../lib/format";
import { useTiingoUsage, type TiingoUsage } from "../../lib/queries/maintenance";

function Meter({ label, used, cap, resets }: { label: string; used: number; cap: number; resets: string }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <div className="tiingo__meter">
      <div className="tiingo__meter-head">
        <span className="tiingo__meter-label">{label}</span>
        <span className="tiingo__meter-value">
          {used} of {cap} used · {Math.max(0, cap - used)} left · resets {resets}
        </span>
      </div>
      <progress
        className={`tiingo__bar${pct >= 100 ? " tiingo__bar--full" : ""}`}
        aria-label={`${label}: ${used} of ${cap} requests used`}
        max={Math.max(cap, 1)}
        value={Math.min(used, cap)}
      />
    </div>
  );
}

function Body({ u }: { u: TiingoUsage }) {
  if (!u.configured) {
    return (
      <p className="tiingo__lead">
        No Tiingo key is set, so there is no backup when yfinance fails or freezes. Add a free key under{" "}
        <strong>Settings → Providers → Tiingo API token</strong>.
      </p>
    );
  }
  return (
    <>
      <p className="tiingo__lead">
        The key is set. Tiingo is only a backup: yfinance stays the main source, and every Tiingo request counts
        against the limits below (Settings → Providers → Tiingo requests per hour / per day).
      </p>
      <Meter label="This hour" used={u.hour_used} cap={u.hourly_cap} resets={formatTime(u.hour_resets_at)} />
      <Meter label="Today" used={u.day_used} cap={u.daily_cap} resets={`${formatTime(u.day_resets_at)} (midnight New York)`} />
      <p className="tiingo__muted">
        {u.remaining} request{u.remaining === 1 ? "" : "s"} can be made right now. NAV checks today: {u.nav_probes_today}.
      </p>
      {u.rate_limited_at && (
        <p className="tiingo__warn">
          ⚠ Tiingo refused a request at {formatTime(u.rate_limited_at)}: its own allowance for this hour is used up
          (maybe another app uses the same key). Nothing more is sent until the hourly reset.
        </p>
      )}
      {u.last_status && (
        <p className="tiingo__muted">
          Last Tiingo call {formatDateTime(u.last_at)}: {u.last_status === "ok" ? "✓ ok" : `⚠ ${u.last_status}`}
          {u.last_message ? `, ${u.last_message}` : ""}
        </p>
      )}
    </>
  );
}

/** Health & Repair: what the Tiingo key does and how much of its budget is left. */
export function TiingoCard() {
  const q = useTiingoUsage();
  return (
    <Card title="Tiingo backup" collapsibleId="repair.tiingo">
      {q.isError && !q.data ? (
        <ErrorState onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Skeleton height="120px" />
      ) : (
        <div className="tiingo">
          <Body u={q.data} />
          <details className="tiingo__uses">
            <summary className="tiingo__uses-title">When the key is used</summary>
            <ul className="tiingo__list">
              {q.data.uses.map((use) => (
                <li key={use.title} className="tiingo__use">
                  <strong className="tiingo__use-title">{use.title}.</strong> {use.detail}
                </li>
              ))}
            </ul>
          </details>
          <p className="tiingo__muted">
            Run it yourself under <strong>Providers</strong> below: “Fill graph gaps from Tiingo” and “Re-pull prices
            from Tiingo”.
          </p>
        </div>
      )}
    </Card>
  );
}
