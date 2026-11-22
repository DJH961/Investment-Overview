import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Chip } from "../../components/Chip";
import { Money } from "../../components/Money";
import { formatDate, formatMoney, formatNumber } from "../../lib/format";
import type { FxConversion } from "../../lib/queries/manage";
import { EstChip } from "../Transactions/EstChip";
import { ecbCell, offPctText, offPctWords, providerLabel } from "./matching";

/** The deposits a conversion paid for, as chips that jump to them; "In the pool" when none. */
function PaidChips({ c }: { c: FxConversion }) {
  const n = c.used_by.length;
  const left = Number(c.remaining_usd);
  return (
    <span className="conv__chips">
      {n === 0 ? (
        <Chip size="sm">In the pool</Chip>
      ) : (
        c.used_by.slice(0, 2).map((u) => (
          <Link key={`${u.deposit_id}-${u.pinned}`} to={{ hash: `#deposit-${u.deposit_id}` }} className="conv__chip-link">
            <Chip size="sm" outline>
              {formatDate(u.date)}
            </Chip>
          </Link>
        ))
      )}
      {n > 2 && <span className="conv__sub">+{n - 2} more</span>}
      {n > 0 && left > 0.005 && (
        <span className="conv__sub">
          <Money amount={left} currency="USD" /> left
        </span>
      )}
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
export function ConversionRow({ c, menu, onSettle }: { c: FxConversion; menu: ReactNode; onSettle?: () => void }) {
  const [open, setOpen] = useState(false);
  const e = ecbCell(c);
  const fees = c.fees_eur && Number(c.fees_eur) > 0 ? Number(c.fees_eur) : 0;
  const allIn = Number(c.all_in_rate) !== Number(c.rate);
  const cost = c.cost_eur === null || c.cost_eur === undefined ? null : Number(c.cost_eur);
  return (
    <li className="conv" id={`conversion-${c.id}`}>
      <div className="conv__id">
        <span className="conv__date">{formatDate(c.date)}</span>
        {c.provider && (
          <Chip size="sm" outline>
            {providerLabel(c.provider)}
          </Chip>
        )}
        {c.is_estimate && onSettle && <EstChip onOpen={onSettle} />}
        {c.note && (
          <span className="conv__note conv__note--wide" title={c.note}>
            {c.note}
          </span>
        )}
      </div>
      <div className="conv__hero">
        <Money amount={Number(c.usd_received)} currency="USD" className="conv__usd" />
        <span className="conv__sent conv__sent--wide">
          from <Money amount={Number(c.eur_sent)} currency="EUR" />
          {fees > 0 && (
            <>
              {" "}
              + <Money amount={fees} currency="EUR" /> fees
            </>
          )}
        </span>
      </div>
      <div className="conv__menu">{menu}</div>

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
            <Money amount={Number(c.eur_sent)} currency="EUR" />
            {" · "}
            {formatNumber(Number(c.rate), 4)}
            {c.off_pct !== null && ` · ${offPctText(c.off_pct)}`}
            {cost !== null && ` · cost ${formatMoney(cost, "EUR", { signed: true })}`}
          </span>
          {open ? <ChevronDown aria-hidden className="conv__chevron" /> : <ChevronRight aria-hidden className="conv__chevron" />}
        </button>
        <PaidChips c={c} />
      </div>

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
          {c.note && <p className="conv__note conv__note--detail">{c.note}</p>}
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
      <span>Paid for</span>
      <span />
    </div>
  );
}
