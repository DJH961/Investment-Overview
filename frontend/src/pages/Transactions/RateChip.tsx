import { Banknote, Landmark, Pin, Wallet } from "lucide-react";
import { Link } from "react-router";
import { Chip } from "../../components/Chip";
import { Money } from "../../components/Money";
import { Sheet } from "../../components/Sheet";
import { formatDate, formatMoney, formatNumber } from "../../lib/format";
import type { DepositMatch, FxConversion } from "../../lib/queries/manage";
import { providerLabel, rateChipLabel } from "../CurrencyConversions/matching";

/** Tap target on a USD deposit row: which rate paid for it. Icon plus word, never colour alone. */
export function RateChip({ match, onOpen }: { match: DepositMatch; onOpen: (m: DepositMatch) => void }) {
  const label = rateChipLabel(match.status);
  return (
    <button
      type="button"
      className="transactions-page__rate-chip"
      aria-label={`${label}: how this deposit was converted`}
      onClick={() => onOpen(match)}
    >
      <Chip size="sm" outline tone="neutral" icon={label === "ECB" ? <Landmark aria-hidden /> : label === "USD" ? <Banknote aria-hidden /> : <Wallet aria-hidden />}>
        {label}
      </Chip>
    </button>
  );
}

/** "Paid for by" slices, each linked to the Conversions page. */
export function RateSheet({
  match,
  conversions,
  onClose,
}: {
  match: DepositMatch | null;
  conversions: readonly FxConversion[];
  onClose: () => void;
}) {
  const byId = new Map(conversions.map((c) => [c.id, c]));
  return (
    <Sheet open={match !== null} onOpenChange={(o) => !o && onClose()} title="How this deposit was converted">
      {match && (
        <div className="transactions-page__rate-sheet">
          <p>
            {formatDate(match.date)} · <Money amount={Number(match.usd)} currency="USD" />
          </p>
          {match.slices.length > 0 && <h3 className="transactions-page__rate-heading">Paid for by</h3>}
          <ul className="transactions-page__rate-list">
            {match.slices.map((s) => {
              const c = byId.get(s.conversion_id);
              const detail = [
                `${formatMoney(Number(s.eur), "EUR")} at ${formatNumber(Number(s.rate), 4)}`,
                c?.fees_eur && Number(c.fees_eur) > 0 ? `fees ${formatMoney(Number(c.fees_eur), "EUR")}` : null,
                c?.ecb_rate ? `ECB ${formatNumber(Number(c.ecb_rate), 4)}` : null,
              ].filter(Boolean);
              return (
                <li key={`${s.conversion_id}-${s.pinned}-${s.usd}`} className="transactions-page__rate-slice">
                  <span className="transactions-page__rate-slice-head">
                    <Link to={`/conversions#conversion-${s.conversion_id}`} className="transactions-page__rate-link">
                      {[formatDate(s.conversion_date), providerLabel(c?.provider)].filter(Boolean).join(" · ")}
                    </Link>
                    {s.pinned && <><Pin className="transactions-page__rate-pin" aria-hidden /><span className="u-sr-only">Pinned</span></>}
                    <Money amount={Number(s.usd)} currency="USD" className="transactions-page__rate-usd" />
                  </span>
                  <span className="transactions-page__rate-slice-detail">{detail.join(" · ")}</span>
                </li>
              );
            })}
            {match.fallback_usd && Number(match.fallback_usd) > 0 && (
              <li>
                ECB rate{match.fallback_rate_date ? ` of ${formatDate(match.fallback_rate_date)}` : ""}
                {match.fallback_rate ? ` (${formatNumber(Number(match.fallback_rate), 4)})` : ""}:{" "}
                {formatMoney(Number(match.fallback_usd), "USD")}
              </li>
            )}
          </ul>
          <Link to="/conversions" className="transactions-page__rate-link">
            Open Currency conversions
          </Link>
        </div>
      )}
    </Sheet>
  );
}
