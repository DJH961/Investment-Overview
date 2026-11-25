import { ChevronDown, ChevronRight, Route, Undo2, Wallet } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { CashOutCard } from "../../components/CashOutCard";
import { Chip } from "../../components/Chip";
import { TrailPanel } from "../../components/MoneyTrail";
import type { CashOutOut, ConversionDirection } from "../../lib/journey-types";
import { Money } from "../../components/Money";
import { formatDate, formatMoney, formatNumber, getFormatPrefs } from "../../lib/format";
import type { FxConversion } from "../../lib/queries/manage";
import { EstChip } from "../Transactions/EstChip";
import { ecbCell, offPctText, offPctWords, providerLabel } from "./matching";

/** "20 Oct": the short day a deposit chip shows (the year is the fold's title). */
function shortDay(iso: string): string {
  return new Intl.DateTimeFormat(getFormatPrefs().locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

/**
 * The deposits a conversion paid for. Wide: pills that jump to them (under the "Paid for deposits"
 * column). Phones: one labelled line of plain links ("Paid for deposits on 20 Oct · 22 Sep +1 more").
 */
function PaidChips({ c }: { c: FxConversion }) {
  const n = c.used_by.length;
  const left = Number(c.remaining_usd);
  return (
    <span className="conv__chips">
      {n === 0 ? (
        <>
          <span className="conv__paid-label">Not used yet ·</span>
          <span className="conv__paid-date conv__paid-date--pool">In the pool</span>
        </>
      ) : (
        <>
          <span className="conv__paid-label">Paid for deposits on</span>
          {c.used_by.slice(0, 2).map((u, i) => (
            <span key={`${u.deposit_id}-${u.pinned}`} className="conv__paid-item">
              {i > 0 && <span className="conv__paid-sep"> · </span>}
              <Link to={{ hash: `#deposit-${u.deposit_id}` }} className="conv__chip-link">
                <span className="conv__paid-date">{shortDay(u.date)}</span>
              </Link>
            </span>
          ))}
        </>
      )}
      {n > 2 && <span className="conv__sub">+{n - 2} more</span>}
      {n > 0 && left > 0.005 && (
        <span className="conv__sub">
          · <Money amount={left} currency="USD" /> left
        </span>
      )}
    </span>
  );
}

/**
 * Dollars kept outside investing: the received dollars as a track (accent = paid for deposits, plain =
 * still in the pool, dotted ink = kept in your USD account) and the labelled amount. Never pool.
 */
function KeptSplit({ c }: { c: FxConversion }) {
  const total = Number(c.usd_received);
  const kept = Number(c.kept_usd);
  const left = Number(c.remaining_usd);
  const used = Math.max(0, total - kept - left);
  const pct = (n: number) => `${total > 0 ? (n / total) * 100 : 0}%`;
  return (
    <span className="conv__kept">
      <span className="conv__kept-text">
        <Wallet aria-hidden className="conv__kept-icon" />
        <span className="conv__kept-label">
          Kept in your USD account: <Money amount={kept} currency="USD" />
        </span>
      </span>
      <span className="conv__split" aria-hidden>
        <span className="conv__seg conv__seg--used" style={{ width: pct(used) }} />
        <span className="conv__seg conv__seg--pool" style={{ width: pct(left) }} />
        <span className="conv__seg conv__seg--kept" style={{ width: pct(kept) }} />
      </span>
    </span>
  );
}

function Fact({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="conv__fact" title={title}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * One conversion. Wide screens: a single line of columns (labels sit in the list's header
 * row). Narrower: the title line (date, provider, dollars, menu), one summary line that opens
 * the rest (all-in rate, the ECB fixing, fees, note), and the chips of the deposits it paid for.
 */
/** 7.4: the conversion's direction (the server sends it; older answers: from the currencies). */
export function directionOf(c: FxConversion): ConversionDirection {
  const d = (c as FxConversion & { direction?: ConversionDirection }).direction;
  return d ?? (c.from_ccy === "USD" ? "to_eur" : "to_usd");
}

export function ConversionRow({
  c,
  menu,
  onSettle,
  cashOut,
  initialTrail = false,
}: {
  c: FxConversion;
  menu: ReactNode;
  onSettle?: () => void;
  /** A conversion back to euros: its result (from the journey), shown when the row opens its trail. */
  cashOut?: CashOutOut | null;
  /** Open with the trail (or result) showing: a `?trail=<id>` link. */
  initialTrail?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [trail, setTrail] = useState(initialTrail);
  const back = directionOf(c) === "to_eur";
  const e = ecbCell(c);
  // An estimate already wears the "est." chip: the plan's own "est. (recurring plan)" note would say it twice.
  const note = c.is_estimate && c.note?.startsWith("est.") ? null : c.note;
  const fees = c.fees_eur && Number(c.fees_eur) > 0 ? Number(c.fees_eur) : 0;
  const allIn = Number(c.all_in_rate) !== Number(c.rate);
  // Shown as what it took from you: negative (one sign rule on every currency figure).
  const cost = c.cost_eur === null || c.cost_eur === undefined ? null : -Number(c.cost_eur);
  const kept = Number(c.kept_usd);
  return (
    <li className="conv" id={`conversion-${c.id}`}>
      <div className="conv__id">
        <span className="conv__date">{formatDate(c.date)}</span>
        <div className="conv__tags">
          {back && (
            <Chip size="sm" outline icon={<Undo2 aria-hidden />}>
              Back to euros
            </Chip>
          )}
          {c.provider && (
            <Chip size="sm" outline>
              {providerLabel(c.provider)}
            </Chip>
          )}
          {c.is_estimate && onSettle && <EstChip onOpen={onSettle} />}
          {note && (
            <span className="conv__note conv__note--wide" title={note} data-truncate-ok>
              {note}
            </span>
          )}
        </div>
      </div>
      <div className="conv__hero">
        {/* Back to euros: the euros received lead, from the dollars sent (amounts keep their currency). */}
        <Money amount={Number(back ? c.eur_sent : c.usd_received)} currency={back ? "EUR" : "USD"} className="conv__usd" />
        <span className="conv__sent conv__sent--wide">
          from <Money amount={Number(back ? c.usd_received : c.eur_sent)} currency={back ? "USD" : "EUR"} />
          {fees > 0 && (
            <>
              {" "}
              + <Money amount={fees} currency="EUR" /> fees
            </>
          )}
        </span>
      </div>
      <div className="conv__menu">{menu}</div>
      {kept > 0 && <KeptSplit c={c} />}

      <div className="conv__cell conv__cell--rate">
        {formatNumber(Number(c.rate), 4)}
        {allIn && <span className="conv__sub">all-in {formatNumber(Number(c.all_in_rate), 4)}</span>}
      </div>
      <div className="conv__cell conv__cell--ecb" title={e.title}>
        {e.text}
        {e.from && <span className="conv__sub">{e.from}</span>}
      </div>
      <div className="conv__cell conv__cell--off" title={offPctWords(c.off_pct) ?? undefined}>
        {offPctText(c.off_pct)}
        {cost !== null && <span className="conv__sub">cost <Money amount={cost} currency="EUR" signed /></span>}
      </div>

      <div className="conv__paid">
        <button
          type="button"
          className="conv__brief"
          aria-expanded={open}
          aria-label={`Details of the ${formatDate(c.date)} conversion`}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="conv__brief-text">
            <span className="conv__nobreak">
              <Money amount={Number(c.eur_sent)} currency="EUR" />
            </span>
            {" · "}
            <span className="conv__nobreak">{formatNumber(Number(c.rate), 4)}</span>
            {c.off_pct !== null && (
              <>
                {" · "}
                <span className="conv__nobreak">{offPctText(c.off_pct)}</span>
              </>
            )}
            {cost !== null && (
              <>
                {" · "}
                <span className="conv__nobreak">cost {formatMoney(cost, "EUR", { signed: true })}</span>
              </>
            )}
          </span>
          {open ? <ChevronDown aria-hidden className="conv__chevron" /> : <ChevronRight aria-hidden className="conv__chevron" />}
        </button>
        <span className="conv__paid-row">
          {back ? (
            <span className="conv__chips">
              <span className="conv__paid-label">Dollars from</span>
              <span className="conv__paid-date conv__paid-date--pool">USD account</span>
            </span>
          ) : (
            <PaidChips c={c} />
          )}
          <button
            type="button"
            className="conv__trail-toggle"
            aria-expanded={trail}
            aria-label={back ? "Result of this cash-out" : "Where these dollars went"}
            onClick={() => setTrail((t) => !t)}
          >
            <Route aria-hidden className="conv__trail-icon" />
            {back ? "Result" : "Trail"}
          </button>
        </span>
      </div>

      {trail && (
        <div className="conv__trail">
          {back ? (
            cashOut ? (
              <CashOutCard out={cashOut} />
            ) : (
              <p className="conv__sub">The result shows once the server has matched these dollars.</p>
            )
          ) : (
            <TrailPanel kind="conversion" id={c.id} label="Where these dollars went" />
          )}
        </div>
      )}

      {open && (
        <dl className="conv__detail">
          <Fact label="Sent">
            <Money amount={Number(c.eur_sent)} currency="EUR" />
            {fees > 0 && (
              <span className="conv__sub">
                + <Money amount={fees} currency="EUR" /> fees
              </span>
            )}
          </Fact>
          <Fact label="Rate">
            {formatNumber(Number(c.rate), 4)}
            {allIn && <span className="conv__sub">all-in {formatNumber(Number(c.all_in_rate), 4)}</span>}
          </Fact>
          <Fact label="ECB that day" title={e.title}>
            {e.text}
            {e.from && <span className="conv__sub">{e.from}</span>}
          </Fact>
          <Fact label="vs ECB" title={offPctWords(c.off_pct) ?? undefined}>
            {offPctText(c.off_pct)}
            {cost !== null && <span className="conv__sub">cost <Money amount={cost} currency="EUR" signed /></span>}
          </Fact>
          {kept > 0 && (
            <Fact label="Kept in your USD account">
              <Money amount={kept} currency="USD" />
            </Fact>
          )}
          {note && <p className="conv__note conv__note--detail">{note}</p>}
        </dl>
      )}
    </li>
  );
}

/** Column labels above a month's rows; only shown on wide screens, where the rows are one line. */
export function ConversionHead() {
  return (
    <div className="conv-head" aria-hidden>
      <span>Date</span>
      <span>Received</span>
      <span>Rate</span>
      <span>ECB that day</span>
      <span>vs ECB</span>
      <span>Paid for deposits</span>
      <span />
    </div>
  );
}
