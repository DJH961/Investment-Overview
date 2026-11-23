import clsx from "clsx";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { Link } from "react-router";
import { Card } from "../../../../components/Card";
import { KindTag } from "../../../../components/CurrencySection";
import { InfoTip } from "../../../../components/InfoTip";
import { Money } from "../../../../components/Money";
import { formatDate, formatNumber } from "../../../../lib/format";
import type { CurrencyEffectDto } from "../../../../lib/queries/currencyEffect";
import { toNum } from "../../../../lib/queries/portfolio";
import { gapWords, RETURNS_TIP } from "./impactFormat";

/**
 * The USD view's investing perspective (`investing`, server-computed): your euros
 * become dollars, and a stronger euro buys more of them. The same cards as the EUR
 * view, each built on what the rate did to the euros you sent in.
 */
export type Investing = NonNullable<CurrencyEffectDto["investing"]>;
type DepositRow = NonNullable<Investing["deposits"]>[number];

/** A rate in dollars per euro ("$1.1641"). */
const rateText = (v: number | null) => (v === null ? "–" : `$${formatNumber(v, 4)}`);

const SOURCE_WORDS: Record<DepositRow["source"], string> = {
  matched: "your conversion",
  partly: "partly your conversion",
  ecb: "ECB rate",
};

/** The EUR view's cards, fed with the investing figures (same shapes on the server). */
export function investingView(data: CurrencyEffectDto): CurrencyEffectDto {
  const inv = data.investing;
  if (!inv) return data;
  return { ...data, months: inv.months, years: inv.years, grid: inv.grid, rolling: inv.rolling, records: inv.records, run: null };
}

/**
 * A currency effect as a bar from a centre line, on one scale shared by every row:
 * right of the line it helped, left it cost (the side and the sign carry it, not color
 * alone), in the gold hatch used for the currency effect across the page.
 */
export function CurrencyBar({ v, max }: { v: number | null; max: number }) {
  const w = v === null || max === 0 ? 0 : (Math.abs(v) / max) * 50;
  return (
    <span className="fx-bar" aria-hidden>
      <span className="fx-bar__zero" />
      {w > 0 ? (
        <span className={clsx("fx-bar__seg", v! > 0 ? "fx-bar__seg--up" : "fx-bar__seg--down")} style={{ width: `${Math.max(w, 0.8)}%` }} />
      ) : null}
    </span>
  );
}

/** What the euro did to your deposits, in dollars; the rate alone when you sent nothing. */
export function InvestingHeadline({ data, inv }: { data: CurrencyEffectDto; inv: Investing }) {
  const pp = toNum(data.headline.effect_pp ?? null);
  const none = inv.deposit_count === 0;
  const ro = inv.rate_only;
  const change = toNum(ro.change);
  return (
    <div className="impact__headline">
      <p className="impact__fig-label">
        What the euro did to your deposits
        <InfoTip
          label="What the euro did to your deposits"
          content={`Each dollar deposit cost euros at the rate you got: your recorded conversions where they match, otherwise that day's ECB rate. The figure is the dollars you received minus what the same euros would have bought at the start rate (${rateText(toNum(inv.start_rate))}). Above zero your euros bought more dollars. ${RETURNS_TIP}`}
        />
      </p>
      <p className="impact__headline-value">
        <Money amount={toNum(none ? ro.change : inv.effect)} currency="USD" signed colored digits={0} />
      </p>
      <p className="impact__lede">
        {none ? (
          <>
            No deposits in this range. <Money amount={toNum(ro.amount_eur)} currency="EUR" digits={0} /> buys{" "}
            <Money amount={toNum(ro.usd_now)} currency="USD" digits={0} /> now, {change !== null && change < 0 ? "fewer" : "more"} dollars
            than at the start.
          </>
        ) : (
          <>
            {inv.deposit_count} {inv.deposit_count === 1 ? "deposit" : "deposits"}: <Money amount={toNum(inv.eur_sent)} currency="EUR" digits={0} />{" "}
            became <Money amount={toNum(inv.usd_received)} currency="USD" digits={0} />, at {rateText(toNum(inv.average_rate ?? null))} against{" "}
            {rateText(toNum(inv.start_rate))} at the start.
          </>
        )}
      </p>
      <p className="impact__fig-line">
        <KindTag kind={none ? ro.kind : inv.kind} />
        {pp !== null ? <span>{gapWords(pp)}</span> : null}
      </p>
    </div>
  );
}

/**
 * Dollars at the start rate + currency effect = dollars received (exact on the server),
 * one scale; the euros sent named above it.
 */
export function InvestingBridgeCard({ inv }: { inv: Investing }) {
  const atStart = toNum(inv.usd_at_start) ?? 0;
  const cur = toNum(inv.effect) ?? 0;
  const got = toNum(inv.usd_received) ?? atStart + cur;
  const none = inv.deposit_count === 0;
  const hi = Math.max(atStart, got);
  const lo = Math.min(atStart, got);
  const base = lo - (hi - lo) * 1.5 > 0 ? lo - (hi - lo) * 1.5 : 0;
  const pos = (v: number) => (hi === base ? 0 : ((v - base) / (hi - base)) * 100);
  const rows = [
    { id: "start", label: "At the start rate", from: base, to: atStart, part: "level", amount: <Money amount={atStart} currency="USD" digits={0} /> },
    { id: "currency", label: "Currency", from: atStart, to: got, part: "currency", amount: <Money amount={cur} currency="USD" signed colored digits={0} /> },
    { id: "end", label: "Dollars received", from: base, to: got, part: "level", amount: <Money amount={got} currency="USD" digits={0} /> },
  ];
  return (
    <Card
      className="impact__bridge"
      title={
        <span className="impact__title">
          From euros to dollars
          <InfoTip
            label="From euros to dollars"
            content="The euros you sent, what they would have bought at the start rate, what the exchange rate added or took, and the dollars you received."
          />
        </span>
      }
    >
      <p className="impact__note">
        <Money amount={toNum(inv.eur_sent)} currency="EUR" digits={0} /> sent from {formatDate(inv.start_on)} to {formatDate(inv.end_on)} · start rate{" "}
        {rateText(toNum(inv.start_rate))}
      </p>
      {none ? (
        <p className="impact__note">No deposits in this range, so nothing was converted.</p>
      ) : (
        <ul className="bridge" aria-label="At the start rate, currency, dollars received">
          {rows.map((r) => {
            const a = pos(Math.min(r.from, r.to));
            const w = Math.max(0.6, Math.abs(pos(r.to) - pos(r.from)));
            const step = r.to - r.from;
            const Dir = step > 0 ? ArrowUp : ArrowDown;
            return (
              <li key={r.id} className={clsx("bridge__row", `bridge__row--${r.part}`)} data-part={r.id}>
                <span className="bridge__label">{r.label}</span>
                <span className="bridge__track" aria-hidden>
                  <span className={clsx("bridge__bar", `bridge__bar--${r.part}`)} style={{ left: `${a}%`, width: `${w}%` }} />
                </span>
                <span className="bridge__amount">
                  {r.id === "currency" && Math.round(step) !== 0 ? <Dir aria-hidden className="bridge__dir" /> : null}
                  {r.amount}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Each deposit: dollars received, euros sent, your rate against the start's, the effect. */
export function DepositsTable({ rows }: { rows: DepositRow[] }) {
  const max = Math.max(0, ...rows.map((d) => Math.abs(toNum(d.effect) ?? 0)));
  return (
    <div className="holding-split">
      <div className="holding-split__row holding-split__row--head" aria-hidden>
        <span className="holding-split__name">Deposit</span>
        <span className="holding-split__bar holding-split__bar--head">
          <span>fewer</span>
          <span>more</span>
        </span>
        <span className="holding-split__fig holding-split__fig--fx">Currency</span>
        <span className="holding-split__fig holding-split__fig--price">Received</span>
        <span className="holding-split__fig holding-split__fig--div">Sent</span>
        <span className="holding-split__fig holding-split__fig--total">Your rate</span>
      </div>
      <ul className="holding-split__list" aria-label="Each deposit: currency effect, dollars received, euros sent and your rate">
        {rows.map((d) => {
          const v = toNum(d.effect);
          return (
            <li key={d.transaction_id} className="holding-split__row" data-deposit={d.on}>
              <span className="holding-split__name">
                <span className="holding-split__symbol">{formatDate(d.on)}</span>
                <span className="holding-split__long">{SOURCE_WORDS[d.source]}</span>
              </span>
              <span className="holding-split__bar">
                <CurrencyBar v={v} max={max} />
              </span>
              <span className="holding-split__fig holding-split__fig--fx">
                <span className="holding-split__label">Currency</span>
                <Money amount={v} currency="USD" signed colored digits={0} />
              </span>
              <span className="holding-split__fig holding-split__fig--price">
                <span className="holding-split__label">Received</span>
                <Money amount={toNum(d.usd)} currency="USD" digits={0} />
              </span>
              <span className="holding-split__fig holding-split__fig--div">
                <span className="holding-split__label">Sent</span>
                <Money amount={toNum(d.eur)} currency="EUR" digits={0} />
              </span>
              <span className="holding-split__fig holding-split__fig--total">
                <span className="holding-split__label">Your rate</span>
                {rateText(toNum(d.rate))} <span className="holding-split__long">vs {rateText(toNum(d.start_rate))}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export const TOP_DEPOSITS = 5;

export function DepositsCard({ inv, range }: { inv: Investing; range: string }) {
  const rows = inv.deposits ?? [];
  const more = rows.length > TOP_DEPOSITS;
  return (
    <Card
      className="impact__holdings"
      title={
        <span className="impact__title">
          Per deposit
          <InfoTip
            label="Per deposit"
            content="Each deposit's dollars against what its euros would have bought at the start rate. The rate is your recorded conversion where it matches, otherwise that day's ECB rate."
          />
        </span>
      }
      meta={more ? `Top ${TOP_DEPOSITS} of ${rows.length} by currency effect` : undefined}
    >
      {rows.length ? (
        <DepositsTable rows={rows.slice(0, TOP_DEPOSITS)} />
      ) : (
        <p className="impact__note">No deposits in this range.</p>
      )}
      {more ? (
        <Link className="impact__more" to={`/currency/holdings?range=${range}`}>
          Show all {rows.length} <ArrowRight aria-hidden className="impact__more-icon" />
        </Link>
      ) : null}
    </Card>
  );
}
