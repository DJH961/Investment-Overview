import clsx from "clsx";
import { Card } from "../../components/Card";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { formatNumber, formatQuantity } from "../../lib/format";
import type { BuilderPlan, BuilderPlanRow, PlanCategory } from "../../lib/queries/allocations";
import { orderTrades, tradeTotals } from "./builderState";

const num = (s: string | null | undefined) => (s === null || s === undefined ? null : Number(s));

/** A fund row that actually buys or sells something. */
const moves = (r: BuilderPlanRow) => (num(r.add_value) ?? 0) !== 0;

/** Before → after bar: the held part, the added (or sold) slice, and a target marker. */
export function ShiftBar({ before, after, target, label }: { before: number; after: number; target: number; label: string }) {
  const lo = Math.min(before, after) * 100;
  const hi = Math.max(before, after) * 100;
  return (
    <div className="allocations__shift" title={label} aria-hidden>
      <span className="allocations__shift-held" style={{ width: `${lo}%` }} />
      <span
        className={after >= before ? "allocations__shift-add" : "allocations__shift-add allocations__shift-add--sell"}
        style={{ left: `${lo}%`, width: `${hi - lo}%` }}
      />
      <span className="allocations__shift-target" style={{ left: `${Math.min(target * 100, 100)}%` }} />
    </div>
  );
}

function shiftLabel(name: string, r: { current_pct: string; after_pct: string; target_pct: string }) {
  const p = (s: string) => `${formatNumber(Number(s) * 100, 1)} %`;
  return `${name}: now ${p(r.current_pct)}, after ${p(r.after_pct)}, target ${p(r.target_pct)}`;
}

/** "12.3 % → 14.0 %" with the target after it. */
function NowAfter({ r }: { r: { current_pct: string; after_pct: string; target_pct: string } }) {
  return (
    <span className="allocations__nowafter">
      <Percent ratio={Number(r.current_pct)} digits={1} />
      <span className="allocations__nowafter-arrow" aria-label="becomes">
        →
      </span>
      <strong>
        <Percent ratio={Number(r.after_pct)} digits={1} />
      </strong>
      <span className="allocations__nowafter-target">
        target <Percent ratio={Number(r.target_pct)} digits={1} />
      </span>
    </span>
  );
}

/** Whole shares read "182", fractional ones "1.2345". */
const shareText = (s: string) => {
  const n = Math.abs(Number(s));
  return formatQuantity(n, Number.isInteger(n) ? 0 : 4);
};

/** One trade: a Buy / Sell word (never colour alone), the fund, shares and the amount, in aligned columns. */
function TradeRow({ r, ccy }: { r: BuilderPlanRow; ccy: string }) {
  const add = num(r.add_value) ?? 0;
  const sell = add < 0;
  return (
    <li className={clsx("allocations__trade", sell && "allocations__trade--sell")}>
      <span className={clsx("allocations__action", sell ? "allocations__action--sell" : "allocations__action--buy")}>
        {sell ? "Sell" : "Buy"}
      </span>
      <span className="allocations__trade-who">
        <span className="allocations__trade-symbol">{r.symbol}</span>
        <span className="allocations__trade-name" title={r.name}>
          {r.name}
        </span>
      </span>
      <span className="allocations__trade-shift">
        <NowAfter r={r} />
      </span>
      <span className="allocations__trade-shares">{shareText(r.add_shares)} sh</span>
      <span className="allocations__trade-amount">
        <Money amount={Math.abs(add)} currency={ccy} />
      </span>
    </li>
  );
}

/** "Buy €1,200", "Sell €300" or both, in words. */
function Totals({ rows, ccy }: { rows: BuilderPlanRow[]; ccy: string }) {
  const { buy, sell } = tradeTotals(rows);
  return (
    <span className="allocations__cat-total">
      {buy > 0 && (
        <span className="allocations__cat-buy">
          Buy <Money amount={buy} currency={ccy} />
        </span>
      )}
      {sell > 0 && (
        <span className="allocations__cat-sell">
          Sell <Money amount={sell} currency={ccy} />
        </span>
      )}
    </span>
  );
}

function CategoryPlan({ c, rows, ccy }: { c: PlanCategory; rows: BuilderPlanRow[]; ccy: string }) {
  const trades = orderTrades(rows.filter(moves));
  const kept = rows.filter((r) => !moves(r));
  return (
    <section className="allocations__plan-cat" aria-label={c.name}>
      <header className="allocations__plan-cat-head">
        <h3 className="allocations__group-title">{c.name}</h3>
        <NowAfter r={c} />
        <Totals rows={rows} ccy={ccy} />
      </header>
      <ShiftBar
        before={Number(c.before_pct)}
        after={Number(c.after_pct)}
        target={Number(c.target_pct)}
        label={shiftLabel(c.name, c)}
      />
      <ul className="allocations__trades">
        {trades.map((r) => (
          <TradeRow key={r.instrument_id} r={r} ccy={ccy} />
        ))}
      </ul>
      {kept.length > 0 && (
        <p className="allocations__plan-note">
          No new money:{" "}
          {kept.map((r) => (
            <span key={r.instrument_id} className="allocations__kept">
              {r.symbol}
              {r.held_unticked ? " (held)" : r.no_buy ? " (no buy)" : ""}
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

export function PlanResult({ plan, stale = false }: { plan: BuilderPlan; stale?: boolean }) {
  const s = plan.summary;
  const other = (v: string | null | undefined) =>
    v === null || v === undefined ? undefined : <Money amount={Number(v)} currency={s.other_ccy} />;
  const selling = Number(s.selling ?? 0) > 0;
  const groups = plan.categories.map((c) => ({ c, rows: plan.rows.filter((r) => r.category === c.name) }));
  // Only categories that buy (or sell) get a section; the rest collapse into
  // one "Already on target" line instead of a list of "€0.00" rows.
  const active = groups.filter(({ rows }) => rows.some(moves));
  const idle = groups.filter(({ rows }) => !rows.some(moves));

  return (
    <>
      {stale && (
        <output className="allocations__notice">
          The mix changed since this plan was computed. Compute again to update it.
        </output>
      )}
      <Card title="Plan summary" collapsibleId="allocations.summary">
        <dl className="allocations__summary">
          <div className="allocations__stat">
            <dt className="allocations__stat-label">Investing</dt>
            <dd className="allocations__stat-value">
              <Money amount={num(s.cash)} currency={plan.ccy} digits={0} />
            </dd>
            <dd className="allocations__stat-sub">
              {s.pct_of_wealth ? (
                <>
                  <Percent ratio={Number(s.pct_of_wealth)} digits={1} /> of wealth
                </>
              ) : (
                other(s.other_cash)
              )}
            </dd>
          </div>
          <div className="allocations__stat">
            <dt className="allocations__stat-label">Buying</dt>
            <dd className="allocations__stat-value">
              <Money amount={num(s.buying)} currency={plan.ccy} digits={0} />
            </dd>
            <dd className="allocations__stat-sub">{other(s.other_buying)}</dd>
          </div>
          {selling && (
            <div className="allocations__stat">
              <dt className="allocations__stat-label">Selling</dt>
              <dd className="allocations__stat-value">
                <Money amount={num(s.selling)} currency={plan.ccy} digits={0} />
              </dd>
              <dd className="allocations__stat-sub">{other(s.other_selling)}</dd>
            </div>
          )}
          <div className="allocations__stat">
            <dt className="allocations__stat-label">Left over</dt>
            <dd className="allocations__stat-value">
              <Money amount={num(s.leftover)} currency={plan.ccy} digits={0} />
            </dd>
            <dd className="allocations__stat-sub">{selling ? "cash + sales − buys" : other(s.other_leftover)}</dd>
          </div>
        </dl>
        {s.from_held_cash != null && (
          <p className="allocations__notice" role="note">
            You hold <Money amount={num(s.held_cash)} currency={plan.ccy} digits={0} /> in cash (money-market).
            Investing <Money amount={num(s.from_held_cash)} currency={plan.ccy} digits={0} /> of it per your
            targets
            {Number(s.held_cash ?? 0) - Number(s.from_held_cash) > 0.5 ? (
              <>
                ; <Money amount={Number(s.held_cash ?? 0) - Number(s.from_held_cash)} currency={plan.ccy} digits={0} /> stays in
                cash.
              </>
            ) : (
              "."
            )}
          </p>
        )}
        {plan.extras.length > 0 && (
          <p className="allocations__notice" role="note">
            Held, no new money: {plan.extras.join(", ")}. Their value counts toward their category
            {plan.allow_sell ? " and they are neither bought nor sold." : ", so they are not bought."}
          </p>
        )}
      </Card>

      <Card
        title={plan.allow_sell ? "Rebalance plan" : "Buy plan"}
        subtitle={plan.allow_sell ? "Buys and sells per category, largest first" : "What to buy per category, largest first"}
        collapsibleId="allocations.plan"
      >
        <div className="allocations__plan">
          {active.length === 0 && <p className="allocations__plan-note">Nothing to trade: your mix is already on target.</p>}
          {active.map(({ c, rows }) => (
            <CategoryPlan key={c.name} c={c} rows={rows} ccy={plan.ccy} />
          ))}
          {idle.length > 0 && (
            <p className="allocations__idle">
              <span className="allocations__idle-label">Already on target</span>
              {idle.map(({ c }) => (
                <span key={c.name} className="allocations__idle-item">
                  {c.name} <Percent ratio={Number(c.after_pct)} digits={1} />
                </span>
              ))}
            </p>
          )}
        </div>
      </Card>
    </>
  );
}
