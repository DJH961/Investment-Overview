import clsx from "clsx";
import { ChevronDown, Route, Undo2 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { CashOutCard } from "../../components/CashOutCard";
import { Money } from "../../components/Money";
import { TrailPanel } from "../../components/MoneyTrail";
import type { CashOutOut } from "../../lib/journey-types";
import { Link } from "react-router";
import { formatDate, formatNumber, getFormatPrefs } from "../../lib/format";
import type { FxConversion } from "../../lib/queries/manage";
import { EstChip } from "../Transactions/EstChip";
import { directionOf } from "./ConversionRow";
import "./PhoneConversions.scss";
import { ecbCell, offPctText, offPctWords, providerLabel } from "./matching";

/** A year group on a phone: chevron + year left, the received dollars right, one muted summary line. */
export function PhoneFold({
  open,
  onToggle,
  title,
  meta,
  figureLabel,
  figure,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: ReactNode;
  meta: ReactNode;
  figureLabel?: string;
  figure?: ReactNode;
  children: ReactNode;
}) {
  const bodyId = useId();
  return (
    <section className={clsx("phone-fold", open && "phone-fold--open")}>
      <button type="button" className="phone-fold__head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <ChevronDown aria-hidden className="phone-fold__chevron" />
        <span className="phone-fold__title">{title}</span>
        {figure && (
          <span className="phone-fold__figure">
            {figureLabel && <span className="phone-fold__label">{figureLabel}</span>}
            <span className="phone-fold__amount">{figure}</span>
          </span>
        )}
        <span className="phone-fold__meta">{meta}</span>
      </button>
      <div id={bodyId} hidden={!open}>
        {open ? children : null}
      </div>
    </section>
  );
}

/** "20 Oct": a deposit's short day. */
function shortDay(iso: string): string {
  return new Intl.DateTimeFormat(getFormatPrefs().locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

/** The deposits this conversion paid for as date links ("Oct 29 · Sep 30"). */
function PaidDates({ c }: { c: FxConversion }) {
  const n = c.used_by.length;
  if (n === 0) return <>Not used yet</>;
  return (
    <>
      {c.used_by.slice(0, 4).map((u, i) => (
        <span key={`${u.deposit_id}-${u.pinned}`}>
          {i > 0 && " · "}
          <Link to={{ hash: `#deposit-${u.deposit_id}` }} className="conv__paid-date">
            {shortDay(u.date)}
          </Link>
        </span>
      ))}
      {n > 4 && ` +${n - 4} more`}
    </>
  );
}

function Cell({ label, children, span, end, mid }: { label: string; children: ReactNode; span?: 2 | 3; end?: boolean; mid?: boolean }) {
  return (
    <div className={clsx("phone-conv__cell", span === 2 && "phone-conv__cell--span2", span === 3 && "phone-conv__cell--wide", end && "phone-conv__cell--end", mid && "phone-conv__cell--mid")}>
      <dt className="phone-conv__label">{label}</dt>
      <dd className="phone-conv__value">{children}</dd>
    </div>
  );
}

function PhoneConversionRow({
  c,
  menu,
  open,
  onToggle,
  onSettle,
  cashOut,
  initialTrail,
}: {
  c: FxConversion;
  menu: ReactNode;
  open: boolean;
  onToggle: () => void;
  onSettle?: () => void;
  cashOut?: CashOutOut | null;
  initialTrail: boolean;
}) {
  const [trail, setTrail] = useState(initialTrail);
  const back = directionOf(c) === "to_eur";
  const e = ecbCell(c);
  const note = c.is_estimate && c.note?.startsWith("est.") ? null : c.note;
  const fees = c.fees_eur && Number(c.fees_eur) > 0 ? Number(c.fees_eur) : 0;
  const feesUsd = c.fee_ccy === "USD" && c.fees_usd ? Number(c.fees_usd) : 0;
  const allIn = Number(c.all_in_rate) !== Number(c.rate);
  const cost = c.cost_eur === null || c.cost_eur === undefined ? null : -Number(c.cost_eur);
  const kept = Number(c.kept_usd);
  const mainCcy = back ? "EUR" : "USD";
  const fromCcy = back ? "USD" : "EUR";
  const mainAmt = Number(back ? c.eur_sent : c.usd_received);
  const fromAmt = Number(back ? c.usd_received : c.eur_sent);
  const date = formatDate(c.date);
  return (
    <li className={clsx("phone-conv", open && "phone-conv--open")} id={`conversion-${c.id}`}>
      <button
        type="button"
        className="phone-conv__row"
        aria-expanded={open}
        aria-label={`Details of the ${date} conversion`}
        onClick={onToggle}
      >
        <span className="phone-conv__date">{date}</span>
        <span className="phone-conv__main">
          <Money amount={mainAmt} currency={mainCcy} />
        </span>
        <span className="phone-conv__rate">{formatNumber(Number(c.rate), 4)}</span>
        <span className="phone-conv__who">
          {back && (
            <span className="phone-conv__tag">
              <Undo2 aria-hidden className="phone-conv__tag-icon" />
              Back to euros
            </span>
          )}
          {!back && c.provider && providerLabel(c.provider)}
          {!back && !c.provider && "Conversion"}
          {c.is_estimate && " · est."}
        </span>
        <span className="phone-conv__from">
          from <Money amount={fromAmt} currency={fromCcy} />
        </span>
        <span className="phone-conv__sub">
          {cost !== null ? <Money amount={cost} currency="EUR" signed colored /> : offPctText(c.off_pct)}
        </span>
      </button>
      {open && (
        <div className="phone-conv__detail">
          <dl className="phone-conv__grid">
            <Cell label={back ? "Received" : "Sent"}>
              <Money amount={Number(c.eur_sent)} currency="EUR" />
            </Cell>
            <Cell label="Fees" mid>
              {fees > 0 ? <Money amount={fees} currency="EUR" /> : feesUsd > 0 ? <Money amount={feesUsd} currency="USD" /> : "–"}
            </Cell>
            <Cell label="Cost" end>{cost !== null ? <Money amount={cost} currency="EUR" signed /> : "–"}</Cell>
            <Cell label="Rate">
              {formatNumber(Number(c.rate), 4)}
              {allIn && <span className="phone-conv__muted">all-in {formatNumber(Number(c.all_in_rate), 4)}</span>}
            </Cell>
            <Cell label="ECB that day" mid>
              <span title={e.title}>{e.text}</span>
              {e.from && <span className="phone-conv__muted">{e.from}</span>}
            </Cell>
            <Cell label="vs ECB" end>
              <span title={offPctWords(c.off_pct) ?? undefined}>{offPctText(c.off_pct)}</span>
            </Cell>
            {kept > 0 && (
              <Cell label="Kept in USD">
                <Money amount={kept} currency="USD" />
              </Cell>
            )}
            <Cell label={back ? "Dollars from" : "Paid for"} span={kept > 0 ? 2 : undefined}>
              {back ? "USD account" : <PaidDates c={c} />}
            </Cell>
            {/* The actions share the last row, in the third column. */}
            <div className="phone-conv__actions">
            <button
              type="button"
              className="phone-conv__trail"
              aria-expanded={trail}
              aria-label={back ? "Result of this cash-out" : "Where these dollars went"}
              onClick={() => setTrail((t) => !t)}
            >
              <Route aria-hidden className="phone-conv__trail-icon" />
              {back ? "Result" : "Trail"}
            </button>
            {c.is_estimate && onSettle && <EstChip onOpen={onSettle} />}
            <span className="phone-conv__menu">{menu}</span>
            </div>
          </dl>
          {note && <p className="phone-conv__note">{note}</p>}
          {trail &&
            (back ? (
              cashOut ? (
                <CashOutCard out={cashOut} />
              ) : (
                <p className="phone-conv__muted">The result shows once the server has matched these dollars.</p>
              )
            ) : (
              <TrailPanel kind="conversion" id={c.id} label="Where these dollars went" />
            ))}
        </div>
      )}
    </li>
  );
}

/** Phone list of one year's conversions: two-line rows, one open at a time. */
export function PhoneConversionList({
  rows,
  menuFor,
  onSettle,
  cashOuts,
  trailId,
}: {
  rows: readonly FxConversion[];
  menuFor: (c: FxConversion) => ReactNode;
  onSettle: (id: number) => void;
  cashOuts: Map<number | null, CashOutOut>;
  trailId: string | null;
}) {
  const [openId, setOpenId] = useState<number | null>(() => {
    const t = rows.find((r) => String(r.id) === trailId);
    return t ? t.id : null;
  });
  return (
    <ul className="phone-convs" aria-label="Currency conversions">
      {rows.map((c) => (
        <PhoneConversionRow
          key={c.id}
          c={c}
          menu={menuFor(c)}
          open={openId === c.id}
          onToggle={() => setOpenId((cur) => (cur === c.id ? null : c.id))}
          onSettle={() => onSettle(c.id)}
          cashOut={cashOuts.get(c.id) ?? null}
          initialTrail={trailId === String(c.id)}
        />
      ))}
    </ul>
  );
}
