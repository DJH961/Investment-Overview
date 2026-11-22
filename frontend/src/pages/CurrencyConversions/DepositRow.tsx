import { ChevronDown, ChevronRight, Pin } from "lucide-react";
import { Link } from "react-router";
import { Button } from "../../components/Button";
import { Money } from "../../components/Money";
import { formatDate, formatNumber } from "../../lib/format";
import type { DepositMatch, FxConversion } from "../../lib/queries/manage";
import { providerLabel } from "./matching";
import { StatusChip } from "./StatusChip";

const pct = (part: number, total: number) => `${Math.min(100, Math.max(0, total > 0 ? (part / total) * 100 : 0))}%`;

/**
 * One USD deposit. Folded it is a single line: date, dollars, status chip and one bar for the
 * whole deposit (accent = your conversions, hatched ink = the ECB rate). Opened it lists every
 * slice with its own bar, and the actions.
 */
export function DepositRow({
  d,
  conversions,
  open,
  onToggle,
  onAdd,
  onPin,
}: {
  d: DepositMatch;
  conversions: ReadonlyMap<number, FxConversion>;
  open: boolean;
  onToggle: () => void;
  onAdd: (d: DepositMatch) => void;
  onPin: (d: DepositMatch) => void;
}) {
  const total = Number(d.usd);
  const matched = d.slices.reduce((sum, s) => sum + Number(s.usd), 0);
  const fallback = d.fallback_usd !== null ? Number(d.fallback_usd) : 0;
  return (
    <li className="deposit" id={`deposit-${d.transaction_id}`}>
      <button type="button" className="deposit__head" aria-expanded={open} onClick={onToggle}>
        <span className="deposit__date">{formatDate(d.date)}</span>
        <Money amount={total} currency="USD" className="deposit__usd" />
        <span className="deposit__summary" aria-hidden>
          <span className="deposit__fill" style={{ width: pct(matched, total) }} />
          {fallback > 0 && <span className="deposit__fill deposit__fill--ecb" style={{ width: pct(fallback, total) }} />}
        </span>
        <span className="deposit__status">
          <StatusChip status={d.status} pinned={d.pinned} />
        </span>
        {open ? <ChevronDown aria-hidden className="deposit__chevron" /> : <ChevronRight aria-hidden className="deposit__chevron" />}
      </button>
      {open && (
        <div className="deposit__detail">
          <p className="deposit__rate">
            {d.effective_rate ? `Your rate ${formatNumber(Number(d.effective_rate), 4)}` : "No rate for this deposit"}
          </p>
          <ul className="deposit__slices">
            {d.slices.map((s) => {
              const c = conversions.get(s.conversion_id);
              return (
                <li key={`${s.conversion_id}-${s.usd}-${s.pinned}`} className="deposit__slice">
                  <div className="deposit__slice-top">
                    <Link to={{ hash: `#conversion-${s.conversion_id}` }} className="deposit__link">
                      {[formatDate(s.conversion_date), providerLabel(c?.provider), formatNumber(Number(s.rate), 4)]
                        .filter(Boolean)
                        .join(" · ")}
                      {s.pinned && (
                        <span className="deposit__pinned" title="Pinned">
                          <Pin className="deposit__pin" aria-hidden />
                          <span className="deposit__sr">Pinned</span>
                        </span>
                      )}
                    </Link>
                    <span className="deposit__amounts">
                      <Money amount={Number(s.usd)} currency="USD" /> for <Money amount={Number(s.eur)} currency="EUR" />
                    </span>
                  </div>
                  <span className="deposit__bar" aria-hidden>
                    <span className="deposit__fill" style={{ width: pct(Number(s.usd), total) }} />
                  </span>
                </li>
              );
            })}
            {fallback > 0 && (
              <li className="deposit__slice">
                <div className="deposit__slice-top">
                  <span className="deposit__ecb">
                    ECB rate{d.fallback_rate_date ? ` of ${formatDate(d.fallback_rate_date)}` : ""}
                    {d.fallback_rate ? ` · ${formatNumber(Number(d.fallback_rate), 4)}` : ""}
                  </span>
                  <span className="deposit__amounts">
                    <Money amount={fallback} currency="USD" />
                    {d.fallback_eur ? (
                      <>
                        {" "}
                        for <Money amount={Number(d.fallback_eur)} currency="EUR" />
                      </>
                    ) : null}
                  </span>
                </div>
                <span className="deposit__bar" aria-hidden>
                  <span className="deposit__fill deposit__fill--ecb" style={{ width: pct(fallback, total) }} />
                </span>
              </li>
            )}
          </ul>
          <div className="deposit__actions">
            {d.status !== "matched" && (
              <Button size="sm" variant="secondary" onClick={() => onAdd(d)}>
                Add the conversion
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => onPin(d)}>
              {d.pinned ? "Change pin…" : "Pin a conversion…"}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
