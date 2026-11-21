import { ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";

export function BackLink({ to = "/holdings", label = "Holdings" }: { to?: string; label?: string }) {
  return (
    <Link to={to} className="holding-page__back">
      <ChevronLeft aria-hidden size={16} />
      {label}
    </Link>
  );
}

export interface HoldingHeaderProps {
  symbol: string;
  name: string;
  /** Meta chips: account, category, currency, type, flags. */
  chips: ReactNode;
  /** The headline value (or the price on a lookup). */
  value: ReactNode;
  /** Today's move under / beside it. */
  today?: ReactNode;
  /** Back link target and label (Holdings, or Back for a lookup). */
  back?: { to: string; label: string };
}

/**
 * The deep-dive header: back link; symbol and name on ONE line (the name ellipsised,
 * the full name in its title); meta chips; value and today on the right (under the
 * symbol on a phone). On a phone it collapses to one sticky line once scrolled past.
 */
export function HoldingHeader({ symbol, name, chips, value, today, back }: HoldingHeaderProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [past, setPast] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setPast(!e.isIntersecting && e.boundingClientRect.top < 0), {
      threshold: 0,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <>
      <BackLink to={back?.to} label={back?.label} />
      <header ref={ref} className="holding-page__head">
        <h1 className="holding-page__title" title={`${symbol} · ${name}`}>
          <span className="holding-page__symbol">{symbol}</span>
          <span className="holding-page__name">{name}</span>
        </h1>
        <div className="holding-page__figures">
          <span className="holding-page__value">{value}</span>
          {today && <span className="holding-page__today">{today}</span>}
        </div>
        <div className="holding-page__chips">{chips}</div>
      </header>
      {/* Phone only (CSS): one sticky line once the header has scrolled away. */}
      {past && (
      <div className="holding-page__sticky" aria-hidden>
        <span className="holding-page__sticky-symbol">{symbol}</span>
        <span className="holding-page__sticky-value">{value}</span>
        {today && <span className="holding-page__sticky-today">{today}</span>}
      </div>
      )}
    </>
  );
}
