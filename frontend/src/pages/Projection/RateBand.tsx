import clsx from "clsx";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { Card } from "../../components/Card";
import { InfoTip } from "../../components/InfoTip";
import { Money } from "../../components/Money";
import { formatNumber, formatPercent } from "../../lib/format";
import { useHideAmounts } from "../../lib/hideAmounts";
import { toNum, type ProjectionOut } from "../../lib/queries/reports";
import "./RateBand.scss";

type Band = NonNullable<ProjectionOut["rate_band"]>;

/** The Currency page's What if section links here. */
export const RATE_BAND_ID = "rate-band";

/**
 * P5 (v7.2): the projection's euro result over a range of EUR/USD rates. The server
 * values the projected dollar wallet at each assumed rate (one instant each, no return
 * converted); this only places the server's three figures per row on one shared scale.
 * EUR view only (the server sends no band in the USD view).
 */
export function RateBand({ band, endLabel }: { band: Band; endLabel?: string }) {
  const { hide } = useHideAmounts();
  const ref = useRef<HTMLDivElement>(null);
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === `#${RATE_BAND_ID}`) ref.current?.scrollIntoView({ block: "start" });
  }, [hash]);

  const rows = band.rows ?? [];
  const nums = rows.flatMap((r) => [toNum(r.pessimistic), toNum(r.expected), toNum(r.optimistic)]).filter((v): v is number => v !== null);
  if (rows.length === 0 || nums.length === 0) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const span = hi - lo || 1;
  const pos = (v: number | null) => (v === null ? null : ((v - lo) / span) * 100);
  const now = toNum(band.usd_per_eur_now);
  const todayExpected = toNum(rows.find((r) => Math.abs(toNum(r.shift_pct) ?? 1) < 1e-9)?.expected ?? null);
  // Hide mode: each figure as a share of the expected result at today's rate.
  const fig = (v: number | null) =>
    hide ? (
      formatPercent(todayExpected && v !== null ? v / todayExpected : null, { digits: 0 })
    ) : (
      <Money amount={v} currency="EUR" digits={0} />
    );
  const low = toNum(band.expected_low ?? null);
  const high = toNum(band.expected_high ?? null);

  return (
    <div ref={ref} id={RATE_BAND_ID} className="rate-band__anchor">
      <Card
        className="rate-band"
        title={
          <span className="rate-band__title">
            In euros, at other exchange rates
            <InfoTip
              label="In euros, at other exchange rates"
              content="Your dollar holdings are projected at their own dollar return, then valued in euros at each assumed EUR/USD rate on the horizon. A stronger euro (rate up) means fewer euros. This is not a forecast of the rate."
            />
          </span>
        }
        collapsibleId="projection.rate-band"
      >
        <p className="rate-band__lead">
          Expected {endLabel ? `in ${endLabel}` : ""}: <strong className="rate-band__lead-figure">{fig(low)}</strong>
          <span className="rate-band__lead-sep"> to </span>
          <strong className="rate-band__lead-figure">{fig(high)}</strong>
          <span className="rate-band__lead-note">
            if EUR/USD ends {formatPercent(toNum(rows[0].shift_pct), { signed: true, digits: 0 })} to{" "}
            {formatPercent(toNum(rows[rows.length - 1].shift_pct), { signed: true, digits: 0 })} from today&apos;s{" "}
            {formatNumber(now, 4)}
          </span>
        </p>
        <table className="rate-band__table">
          <caption className="rate-band__caption">Projected euro value by EUR/USD rate at the horizon</caption>
          <thead>
            <tr>
              <th scope="col" className="rate-band__th">
                EUR/USD
              </th>
              <th scope="col" className="rate-band__th rate-band__th--bar">
                <span className="rate-band__key">
                  <span className="rate-band__key-whisker" aria-hidden /> pessimistic to optimistic
                  <span className="rate-band__key-dot" aria-hidden /> expected
                </span>
              </th>
              <th scope="col" className="rate-band__th rate-band__th--num">
                Expected
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const shift = toNum(r.shift_pct) ?? 0;
              const today = Math.abs(shift) < 1e-9;
              const a = pos(toNum(r.pessimistic));
              const b = pos(toNum(r.optimistic));
              const e = pos(toNum(r.expected));
              return (
                <tr key={r.usd_per_eur} className={clsx("rate-band__row", today && "rate-band__row--today")}>
                  <th scope="row" className="rate-band__rate">
                    <span className="rate-band__rate-value">{formatNumber(toNum(r.usd_per_eur), 4)}</span>
                    <span className="rate-band__rate-shift">
                      {today ? "today" : formatPercent(shift, { signed: true, digits: 0 })}
                    </span>
                  </th>
                  <td className="rate-band__cell">
                    <span className="rate-band__sr">
                      Pessimistic {fig(toNum(r.pessimistic))}, optimistic {fig(toNum(r.optimistic))}
                    </span>
                    <span className="rate-band__track" aria-hidden>
                      {a !== null && b !== null ? (
                        <span className="rate-band__whisker" style={{ left: `${a}%`, width: `${Math.max(b - a, 0.5)}%` }} />
                      ) : null}
                      {e !== null ? <span className="rate-band__dot" style={{ left: `${e}%` }} /> : null}
                    </span>
                  </td>
                  <td className="rate-band__num">{fig(toNum(r.expected))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
