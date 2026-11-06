import clsx from "clsx";
import { holdingPriceTime, formatStamp, PriceStamps, sentenceCase } from "../../components/Freshness";
import { InfoTip } from "../../components/InfoTip";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { formatDate, formatMoney, formatNumber, formatQuantity } from "../../lib/format";
import type { HoldingRowDto } from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";

/** Money-market funds read "CASH" (as on the web companion), NAV-priced funds "NAV". */
export function Flags({ row }: { row: HoldingRowDto }) {
  return (
    <span className="holdings-page__flags">
      {row.is_money_market && <span className="holdings-page__flag">CASH</span>}
      {!row.is_money_market && row.price_type === "nav" && <span className="holdings-page__flag">NAV</span>}
      {row.value_warning && <span className="holdings-page__flag holdings-page__flag--warn">stale value</span>}
      {row.price_data_warning && <span className="holdings-page__flag holdings-page__flag--warn">bad history</span>}
    </span>
  );
}

/** A row's own price time, shown only when it differs from the header's (see `foldStamps`). */
export function RowStamp({ text, labelled = false }: { text: string | null; labelled?: boolean }) {
  if (!text) return null;
  return (
    <span className="holdings-page__row-stamp" title={`Price as of ${text}`}>
      <span className={clsx("holdings-page__row-stamp-key", labelled && "holdings-page__row-stamp-key--shown")}>
        Price as of
      </span>{" "}
      {labelled ? text : sentenceCase(text)}
    </span>
  );
}

/**
 * Weight as a number with a thin bar on a shared scale (the largest weight fills it).
 * `start` left-aligns it (the group header); the table right-aligns.
 */
export function WeightCell({ ratio, max, start = false }: { ratio: number | null; max: number; start?: boolean }) {
  const width = ratio !== null && max > 0 ? Math.min((ratio / max) * 100, 100) : 0;
  return (
    <span className={clsx("holdings-page__weight", start && "holdings-page__weight--start")}>
      <Percent ratio={ratio} digits={1} />
      <span className="holdings-page__weight-bar" aria-hidden>
        <span className="holdings-page__weight-fill" style={{ width: `${width}%` }} />
      </span>
    </span>
  );
}

/**
 * Row class for holdings in profit / loss: an accent edge (blue / orange), never a full-row wash.
 * Judged on total return, so a cash fund that earns only dividends — its NAV pinned
 * at par, its capital gain 0 — is tinted for the profit it is actually making.
 */
export function tintClass(row: HoldingRowDto): string | undefined {
  const gain = toNum(row.total_return);
  if (gain === null || gain === 0) return undefined;
  return gain > 0 ? "holdings-page__row--gain" : "holdings-page__row--loss";
}

/** Small outlined "≈ est." pill: the figure next to it is an ETF-twin estimate, not an official one. */
export function EstChip({ children = "≈ est." }: { children?: string }) {
  return <span className="holdings-page__est">{children}</span>;
}

const TIER_LABEL: Record<string, string> = {
  same_index: "Same index",
  close: "Close index",
  manual: "Chosen by you",
};

/** Percentage points, signed: 0.034 -> "+0.03 pp". */
export function formatPp(value: string | null | undefined): string {
  const n = toNum(value);
  if (n === null) return "–";
  const text = formatNumber(Math.abs(n), 2);
  if (Number(text.replace(",", ".")) === 0) return `${text} pp`;
  return `${n > 0 ? "+" : "-"}${text} pp`;
}

/**
 * One muted line under a NAV fund's symbol while its twin is estimating the day
 * (`≈ VOO +0.42%`). The "≈" pill and the sign carry the meaning; colour does not.
 */
export function TwinLine({ row }: { row: HoldingRowDto }) {
  const twin = row.twin;
  if (!twin || !twin.pending) return null;
  const pct = toNum(twin.est_today_pct);
  if (pct === null) return null;
  return (
    <span
      className="holdings-page__twin-line"
      title={`Estimated from the ETF ${twin.symbol} until ${row.symbol}'s NAV posts`}
    >
      <EstChip>≈</EstChip>
      <span className="holdings-page__twin-text">
        {twin.symbol} <Percent ratio={pct} signed />
      </span>
    </span>
  );
}

const DIVERGENCE_HELP =
  "Divergence compares what the twin ETF said the fund would do with what the fund's official NAV then did, " +
  "session by session. A positive gap means the twin ran higher than the fund (the estimate was too high). " +
  "Sessions with a dividend or distribution are left out. How many sessions count is a setting " +
  "(Settings > Data refresh).";

function biasText(bias: number | null): string {
  if (bias === null) return "–";
  if (Math.abs(bias) < 0.005) return "no lean either way";
  return bias > 0 ? "twin runs high" : "twin runs low";
}

/** The "Twin" block: which ETF stands in, its live estimate while pending, and how well it has tracked. */
export function TwinBlock({ row, ccy }: { row: HoldingRowDto; ccy: string }) {
  const twin = row.twin;
  if (!twin) return null;
  const div = twin.divergence;
  const bias = div ? toNum(div.bias_pp) : null;
  const lastPp = div ? toNum(div.last_pp) : null;
  return (
    <section className="holdings-page__twin" aria-label={`ETF twin of ${row.symbol}`}>
      <h3 className="holdings-page__twin-title">
        <EstChip>≈</EstChip> Twin
      </h3>
      <dl className="holdings-page__twin-grid">
        <div>
          <dt>Twin ETF</dt>
          <dd>
            {twin.symbol} <span className="holdings-page__muted">({TIER_LABEL[twin.tier] ?? twin.tier})</span>
          </dd>
        </div>
        {twin.pending ? (
          <>
            <div>
              <dt>Estimated price</dt>
              <dd>{formatMoney(toNum(twin.est_price), row.native_currency, { unmasked: true })}</dd>
            </div>
            <div>
              <dt>Estimated value</dt>
              <dd>
                <Money amount={toNum(twin.est_value)} currency={ccy} />
              </dd>
            </div>
            <div>
              <dt>Estimated today</dt>
              <dd className="holdings-page__twin-move">
                <Money amount={toNum(twin.est_today_move)} currency={ccy} signed colored />
                <Percent ratio={toNum(twin.est_today_pct)} signed colored />
              </dd>
            </div>
            {twin.at && (
              <div>
                <dt>Twin priced</dt>
                <dd>{formatStamp(twin.at)}</dd>
              </div>
            )}
          </>
        ) : (
          <div>
            <dt>Estimate</dt>
            <dd className="holdings-page__muted">NAV posted; the estimate is off until the next open.</dd>
          </div>
        )}
      </dl>
      <h4 className="holdings-page__twin-sub">
        Divergence <InfoTip label="twin divergence" content={DIVERGENCE_HELP} />
      </h4>
      {div ? (
        <dl className="holdings-page__twin-grid">
          <div>
            <dt>Last session{div.last_date ? ` (${formatDate(div.last_date)})` : ""}</dt>
            <dd className="holdings-page__twin-move">
              <span>{formatPp(div.last_pp)}</span>
              {div.last_money !== null && div.last_money !== undefined && lastPp !== null && (
                <Money amount={toNum(div.last_money)} currency={ccy} signed />
              )}
            </dd>
          </div>
          <div>
            <dt>Typical gap (median)</dt>
            <dd>
              {formatPp(div.median_abs_pp).replace(/^\+/, "")}{" "}
              <span className="holdings-page__muted">
                over {div.sessions} of {div.window} sessions
              </span>
            </dd>
          </div>
          <div>
            <dt>Bias</dt>
            <dd>
              {formatPp(div.bias_pp)} <span className="holdings-page__muted">({biasText(bias)})</span>
            </dd>
          </div>
        </dl>
      ) : (
        <p className="holdings-page__muted">Not enough history yet to compare the twin with the real NAV.</p>
      )}
    </section>
  );
}

export function HoldingDetails({
  id,
  row,
  ccy,
  variant = "full",
}: {
  id?: string;
  row: HoldingRowDto;
  ccy: string;
  /** `more`: only what the phone row's chips do not already show. */
  variant?: "full" | "more";
}) {
  const stamps = (
    <div>
      <dt>Price as of / updated</dt>
      <dd>
        <PriceStamps price={holdingPriceTime(row)} updated={row.updated_at} layout="stack" />
      </dd>
    </div>
  );
  if (variant === "more") {
    return (
      <dl id={id} className="holdings-page__detail">
        <div>
          <dt>Avg price</dt>
          <dd>{formatMoney(toNum(row.avg_price_native), row.native_currency)}</dd>
        </div>
        <div>
          <dt>Cost basis</dt>
          <dd>
            <Money amount={toNum(row.cost_basis)} currency={ccy} />
          </dd>
        </div>
        <div>
          <dt>Dividends</dt>
          <dd>
            <Money amount={toNum(row.dividends)} currency={ccy} />
          </dd>
        </div>
        <div>
          <dt>Total return (incl. dividends)</dt>
          <dd>
            <Money amount={toNum(row.total_return)} currency={ccy} signed colored />
          </dd>
        </div>
        <div>
          <dt>MTD</dt>
          <dd>
            <Percent ratio={toNum(row.mtd_growth)} signed colored />
          </dd>
        </div>
        <div>
          <dt>YTD</dt>
          <dd>
            <Percent ratio={toNum(row.ytd_growth)} signed colored />
          </dd>
        </div>
        <div>
          <dt>Expense</dt>
          <dd>
            <Percent ratio={toNum(row.expense_ratio)} />
          </dd>
        </div>
        <div>
          <dt>Account</dt>
          <dd>{row.account}</dd>
        </div>
        {stamps}
      </dl>
    );
  }
  return (
    <dl id={id} className="holdings-page__detail">
      <div>
        <dt>Price</dt>
        <dd>{formatMoney(toNum(row.price_native), row.native_currency, { unmasked: true })}</dd>
      </div>
      {stamps}
      <div>
        <dt>Shares</dt>
        <dd>{formatQuantity(toNum(row.shares), 4)}</dd>
      </div>
      <div>
        <dt>Cost basis</dt>
        <dd>
          <Money amount={toNum(row.cost_basis)} currency={ccy} />
        </dd>
      </div>
      <div>
        <dt>Unrealised gain</dt>
        <dd>
          <Money amount={toNum(row.capital_gain)} currency={ccy} signed colored />
        </dd>
      </div>
      <div>
        <dt>Dividends</dt>
        <dd>
          <Money amount={toNum(row.dividends)} currency={ccy} />
        </dd>
      </div>
      <div>
        <dt>Total return (incl. dividends)</dt>
        <dd>
          <Money amount={toNum(row.total_return)} currency={ccy} signed colored />
        </dd>
      </div>
      <div>
        <dt>Growth</dt>
        <dd>
          <Percent ratio={toNum(row.total_growth)} signed colored />
        </dd>
      </div>
      <div>
        <dt>XIRR</dt>
        <dd>
          <Percent ratio={toNum(row.xirr)} signed colored />
        </dd>
      </div>
      <div>
        <dt>Weight</dt>
        <dd>
          <Percent ratio={toNum(row.weight_pct)} digits={1} />
        </dd>
      </div>
      <div>
        <dt>Expense</dt>
        <dd>
          <Percent ratio={toNum(row.expense_ratio)} />
        </dd>
      </div>
    </dl>
  );
}
