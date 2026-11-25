import { ArrowUpFromLine, Pin, Undo2, Wallet } from "lucide-react";
import { Link } from "react-router";
import { Money } from "../../components/Money";
import type { StatItem } from "../../components/StatStrip";
import { formatDate } from "../../lib/format";
import type { BackInEuros, ConversionBackFunding } from "../../lib/journey-types";
import type { FxConversion } from "../../lib/queries/manage";
import { providerLabel } from "./matching";

/** The two cash-out tiles; none until the first conversion back (the strip stays at six). */
export function backStatItems(back: BackInEuros | null): StatItem[] {
  if (!back) return [];
  return [
    {
      key: "back",
      label: "Back in euros",
      tip: "Euros you received converting dollars back, all cash-outs together.",
      value: <Money amount={Number(back.eur_received)} currency="EUR" digits={0} />,
      note: `${back.count} ${back.count === 1 ? "cash-out" : "cash-outs"}`,
    },
    {
      key: "realised",
      label: "Realized in euros",
      tip: "Euros received minus the euros that first bought those dollars: market, currency and conversion cost together.",
      value: <Money amount={Number(back.realised_eur)} currency="EUR" signed colored digits={0} />,
      note: (
        <>
          on <Money amount={Number(back.orig_eur)} currency="EUR" digits={0} /> put in
        </>
      ),
    },
  ];
}

/** One conversion back: which withdrawals paid for it, then the rest from the USD account. */
export function BackFundingRow({ c }: { c: FxConversion }) {
  const f = c as FxConversion & ConversionBackFunding;
  const slices = f.funded_by ?? [];
  const rest = Number(f.rest_usd ?? 0);
  return (
    <li className="conversions__back" id={`back-${c.id}`}>
      <div className="conversions__back-head">
        <Undo2 aria-hidden className="conversions__back-icon" />
        <Link to={{ hash: `#conversion-${c.id}` }} className="conversions__back-link">
          {formatDate(c.date)}
          {c.provider ? ` · ${providerLabel(c.provider)}` : ""}
        </Link>
        <span className="conversions__back-figure">
          <Money amount={Number(c.usd_received)} currency="USD" /> → <Money amount={Number(c.eur_sent)} currency="EUR" />
        </span>
      </div>
      <ul className="conversions__back-slices">
        {slices.map((s) => (
          <li key={s.withdrawal_id} className="conversions__back-slice">
            <ArrowUpFromLine aria-hidden className="conversions__back-slice-icon" />
            <span className="conversions__back-slice-text">
              Withdrawal of {formatDate(s.date)}
              {s.pinned && (
                <>
                  <Pin aria-hidden className="conversions__back-pin" />
                  <span className="u-sr-only">Pinned</span>
                </>
              )}
            </span>
            <Money amount={Number(s.usd)} currency="USD" />
          </li>
        ))}
        {(rest > 0.005 || slices.length === 0) && (
          <li className="conversions__back-slice">
            <Wallet aria-hidden className="conversions__back-slice-icon" />
            <span className="conversions__back-slice-text">
              {slices.length === 0 ? "From the USD account at its cost" : "Rest from the USD account at its cost"}
            </span>
            <Money amount={slices.length === 0 ? Number(c.usd_received) : rest} currency="USD" />
          </li>
        )}
      </ul>
    </li>
  );
}
