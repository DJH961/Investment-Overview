import { ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";

export interface BackTarget {
  to: string;
  label: string;
}

export interface HoldingRouteState {
  from?: BackTarget;
}

export function backTargetFromState(
  state: unknown,
  fallback: BackTarget = { to: "/holdings", label: "Holdings" },
): BackTarget {
  if (state && typeof state === "object" && "from" in state) {
    const from = (state as HoldingRouteState).from;
    if (
      from &&
      typeof from.to === "string" &&
      from.to.startsWith("/") &&
      !from.to.startsWith("//") &&
      typeof from.label === "string" &&
      from.label.trim() !== ""
    ) {
      return { to: from.to, label: from.label };
    }
  }
  return fallback;
}

export function BackLink({ to = "/holdings", label = "Holdings" }: Partial<BackTarget>) {
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
  /** Meta chips: account, category, currency, type (one line; the account truncates). */
  chips: ReactNode;
  /** Status pills on the symbol line: live, NAV / CASH, ≈ est., warnings, Not held. */
  pills?: ReactNode;
  /** The headline value (or the price on a lookup). */
  value: ReactNode;
  /** Today's move under / beside it. */
  today?: ReactNode;
  /** Current price per share (native currency): a second hero figure beside the value. */
  price?: ReactNode;
  /** Under the price: today's move, as-of time. */
  priceMeta?: ReactNode;
  /** Back link target and label (Holdings, Overview, or another origin). */
  back?: BackTarget;
}

/**
 * The deep-dive header: back link; symbol and name on ONE line (the name ellipsised,
 * the full name in its title); meta chips; value and today on the right (under the
 * symbol on a phone). On a phone it collapses to one sticky line once scrolled past.
 */
export function HoldingHeader({ symbol, name, chips, pills, value, today, price, priceMeta, back }: HoldingHeaderProps) {
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
          {pills && <span className="holding-page__pills">{pills}</span>}
          <span className="holding-page__name">{name}</span>
        </h1>
        <div className="holding-page__figures">
          <div className="holding-page__figure">
            {price && <span className="holding-page__figure-label">Value</span>}
            <span className="holding-page__value">{value}</span>
            {today && <span className="holding-page__today">{today}</span>}
          </div>
          {price && (
            <div className="holding-page__figure holding-page__figure--price">
              <span className="holding-page__figure-label">Price per share</span>
              <span className="holding-page__value holding-page__value--price">{price}</span>
              {priceMeta && <span className="holding-page__today">{priceMeta}</span>}
            </div>
          )}
        </div>
        <div className="holding-page__chips">{chips}</div>
      </header>
      {/* Phone only (CSS): one sticky line once the header has scrolled away. */}
      {past && (
      <div className="holding-page__sticky" aria-hidden>
        <span className="holding-page__sticky-symbol">{symbol}</span>
        <span className="holding-page__sticky-value">{value}</span>
        {price && <span className="holding-page__sticky-price">{price}</span>}
        {today && <span className="holding-page__sticky-today">{today}</span>}
      </div>
      )}
    </>
  );
}
