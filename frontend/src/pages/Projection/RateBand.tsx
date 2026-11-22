import { useEffect, useRef, useState } from "react";
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
 * P5 (v7.2): your dollar holdings' projected euro value at a rate you choose. The server
 * sends one row per assumed EUR/USD rate on the horizon (today's ± 15 %, 1 % steps), each
 * with its pessimistic, expected and optimistic value: the dollar wallet grown at its own
 * dollar return and valued at that rate (one instant each, no return converted). The
 * slider only picks a row; the band places that row's three figures on one scale shared
 * by every row, so moving the rate visibly moves the band. EUR view only.
 */
export function RateBand({ band, endLabel }: { band: Band; endLabel?: string }) {
  const { hide } = useHideAmounts();
  const ref = useRef<HTMLDivElement>(null);
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === `#${RATE_BAND_ID}`) ref.current?.scrollIntoView({ block: "start" });
  }, [hash]);

  const rows = band.rows ?? [];
  const todayIndex = Math.max(
    0,
    rows.findIndex((r) => Math.abs(toNum(r.shift_pct) ?? 1) < 1e-9),
  );
  const [picked, setPicked] = useState<number | null>(null);
  const index = Math.min(picked ?? todayIndex, Math.max(rows.length - 1, 0));

  const nums = rows.flatMap((r) => [toNum(r.pessimistic), toNum(r.optimistic)]).filter((v): v is number => v !== null);
  if (rows.length === 0 || nums.length === 0) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const span = hi - lo || 1;
  const pos = (v: number | null) => (v === null ? null : ((v - lo) / span) * 100);

  const row = rows[index];
  const shift = toNum(row.shift_pct) ?? 0;
  const isToday = index === todayIndex;
  const rate = toNum(row.usd_per_eur);
  const pess = toNum(row.pessimistic);
  const exp = toNum(row.expected);
  const opt = toNum(row.optimistic);
  const todayExpected = toNum(rows[todayIndex]?.expected ?? null);
  // Hide mode: each figure as a share of the expected result at today's rate.
  const fig = (v: number | null) =>
    hide ? formatPercent(todayExpected && v !== null ? v / todayExpected : null, { digits: 0 }) : <Money amount={v} currency="EUR" digits={0} />;
  const vsToday = exp !== null && todayExpected !== null ? exp - todayExpected : null;

  const a = pos(pess);
  const b = pos(opt);
  const e = pos(exp);
  const first = toNum(rows[0].shift_pct) ?? 0;
  const last = toNum(rows[rows.length - 1].shift_pct) ?? 0;

  return (
    <div ref={ref} id={RATE_BAND_ID} className="rate-band__anchor">
      <Card
        className="rate-band"
        title={
          <span className="rate-band__title">
            Your dollars at another exchange rate
            <InfoTip
              label="Your dollars at another exchange rate"
              content="Your dollar holdings are grown at their own dollar return, then valued in euros at the EUR/USD rate you pick for the horizon. A stronger euro (rate up) means fewer euros. The headline above grows the whole portfolio at your euro return instead, which already carries the dollar's past moves, so the two differ even at today's rate. Neither is a forecast of the rate."
            />
          </span>
        }
        collapsibleId="projection.rate-band"
      >
        <div className="rate-band__head">
          <div className="rate-band__figure-block">
            <p className="rate-band__eyebrow">Expected {endLabel ? `in ${endLabel}` : ""}</p>
            <p className="rate-band__figure">{fig(exp)}</p>
            <p className="rate-band__sub">
              {isToday ? (
                "at today's rate"
              ) : vsToday !== null ? (
                <>
                  {hide ? null : <Money amount={vsToday} currency="EUR" signed colored digits={0} />} compared with today&apos;s rate
                </>
              ) : null}
            </p>
          </div>
          <div className="rate-band__rate-block">
            <p className="rate-band__eyebrow">EUR/USD on the horizon</p>
            <p className="rate-band__rate">{formatNumber(rate, 4)}</p>
            <p className="rate-band__sub">{isToday ? "today's rate" : `${formatPercent(shift, { signed: true, digits: 0 })} from today's ${formatNumber(toNum(band.usd_per_eur_now), 4)}`}</p>
          </div>
        </div>

        <div className="rate-band__band" role="img" aria-label={`Pessimistic ${hide ? "" : pess}, expected ${hide ? "" : exp}, optimistic ${hide ? "" : opt}`}>
          <span className="rate-band__track" aria-hidden>
            {a !== null && b !== null ? <span className="rate-band__range" style={{ left: `${a}%`, width: `${Math.max(b - a, 0.5)}%` }} /> : null}
            {e !== null ? <span className="rate-band__dot" style={{ left: `${e}%` }} /> : null}
          </span>
          <dl className="rate-band__legend">
            <div className="rate-band__legend-item">
              <dt className="rate-band__legend-label">Pessimistic</dt>
              <dd className="rate-band__legend-value">{fig(pess)}</dd>
            </div>
            <div className="rate-band__legend-item rate-band__legend-item--end">
              <dt className="rate-band__legend-label">Optimistic</dt>
              <dd className="rate-band__legend-value">{fig(opt)}</dd>
            </div>
          </dl>
        </div>

        <div className="rate-band__slider">
          <label className="rate-band__slider-label" htmlFor="rate-band-slider">
            Pick a rate
            {!isToday ? (
              <button type="button" className="rate-band__reset" onClick={() => setPicked(null)}>
                Back to today
              </button>
            ) : null}
          </label>
          <input
            id="rate-band-slider"
            className="rate-band__input"
            type="range"
            min={0}
            max={rows.length - 1}
            step={1}
            value={index}
            onChange={(ev) => setPicked(Number(ev.target.value))}
            aria-valuetext={`EUR/USD ${formatNumber(rate, 4)}, ${isToday ? "today's rate" : formatPercent(shift, { signed: true, digits: 0 })}`}
          />
          <div className="rate-band__ticks" aria-hidden>
            <span>
              {formatPercent(first, { signed: true, digits: 0 })} · euro weaker
            </span>
            <span className="rate-band__tick-today" style={{ left: `${(todayIndex / Math.max(rows.length - 1, 1)) * 100}%` }}>
              today
            </span>
            <span>
              euro stronger · {formatPercent(last, { signed: true, digits: 0 })}
            </span>
          </div>
        </div>
        <p className="rate-band__note">
          Grown at their dollar return, so even at today&apos;s rate this differs from the headline, which uses your euro return.
        </p>
      </Card>
    </div>
  );
}
