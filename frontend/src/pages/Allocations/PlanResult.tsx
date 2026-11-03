import { Card } from "../../components/Card";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { formatNumber, formatQuantity } from "../../lib/format";
import type { BuilderPlan, BuilderPlanRow } from "../../lib/queries/allocations";

const num = (s: string | null | undefined) => (s === null || s === undefined ? null : Number(s));

/** A fund row that actually buys or sells something. */
const moves = (r: BuilderPlanRow) => (num(r.add_value) ?? 0) !== 0;

/** Before → after bar: the held part, the added slice highlighted, and a target marker. */
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

function FundRow({ r, ccy }: { r: BuilderPlanRow; ccy: string }) {
  const add = num(r.add_value) ?? 0;
  return (
    <li className="allocations__plan-row">
      <div className="allocations__plan-head">
        <span className="allocations__row-label" title={r.name}>
          {r.symbol}
          {r.no_buy && <span className="allocations__tag">{r.held_unticked ? "held, not ticked" : "no buy"}</span>}
        </span>
        <span className="allocations__plan-amount">
          {add !== 0 ? <Money amount={add} currency={ccy} signed colored /> : "–"}
          {add !== 0 && <span className="allocations__plan-shares">{formatQuantity(Number(r.add_shares), 4)} sh</span>}
        </span>
      </div>
      <ShiftBar
        before={Number(r.before_pct)}
        after={Number(r.after_pct)}
        target={Number(r.target_pct)}
        label={shiftLabel(r.symbol, r)}
      />
      <p className="allocations__plan-note">
        <Percent ratio={Number(r.current_pct)} digits={1} /> → <Percent ratio={Number(r.after_pct)} digits={1} /> (target{" "}
        <Percent ratio={Number(r.target_pct)} digits={1} />)
      </p>
    </li>
  );
}

export function PlanResult({ plan }: { plan: BuilderPlan }) {
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
      <Card title="Plan summary" collapsibleId="allocations.summary">
        {/* Three figures side by side (four when selling): compact, no lone tile. */}
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
            <dd className="allocations__stat-sub">{other(s.other_leftover)}</dd>
          </div>
        </dl>
        {plan.extras.length > 0 && (
          <p className="allocations__notice" role="note">
            Held but not ticked: {plan.extras.join(", ")}. Their value counts toward their category, so they
            are not bought.
          </p>
        )}
      </Card>

      <Card title={plan.allow_sell ? "Rebalance plan" : "Buy plan"} collapsibleId="allocations.plan">
        <div className="allocations__groups">
          {active.length === 0 && <p className="allocations__plan-note">Nothing to buy: your mix is already on target.</p>}
          {active.map(({ c, rows }) => (
            <section key={c.name} className="allocations__group" aria-label={c.name}>
              <div className="allocations__plan-head">
                <h3 className="allocations__group-title">{c.name}</h3>
                <span className="allocations__plan-amount">
                  <Money amount={num(c.add_value)} currency={plan.ccy} signed colored />
                </span>
              </div>
              <ShiftBar
                before={Number(c.before_pct)}
                after={Number(c.after_pct)}
                target={Number(c.target_pct)}
                label={shiftLabel(c.name, c)}
              />
              <ul className="allocations__plan-list">
                {rows.filter(moves).map((r) => (
                  <FundRow key={r.instrument_id} r={r} ccy={plan.ccy} />
                ))}
              </ul>
              {rows.some((r) => !moves(r)) && (
                <p className="allocations__plan-note">
                  No change:{" "}
                  {rows
                    .filter((r) => !moves(r))
                    .map((r) => r.symbol)
                    .join(", ")}
                </p>
              )}
            </section>
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
