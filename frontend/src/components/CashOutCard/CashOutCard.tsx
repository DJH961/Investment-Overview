import clsx from "clsx";
import { Info, TriangleAlert, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { formatDate } from "../../lib/format";
import type { CashOutOut } from "../../lib/journey-types";
import { Chip } from "../Chip";
import { Money } from "../Money";
import { Percent } from "../Percent";
import "./CashOutCard.scss";

const n = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

/** A cell only euros have (currency, conversion cost): a quiet dash, named for screen readers. */
function EurOnly() {
  return (
    <span className="cash-out-card__none">
      <span aria-hidden>–</span>
      <span className="u-sr-only">only in euros</span>
    </span>
  );
}

interface Row {
  key: string;
  label: string;
  eur: ReactNode;
  usd: ReactNode;
  total?: boolean;
}

/**
 * The result of one cash-out (7.4): what came back in euros against the euros that first
 * bought those dollars, euros beside dollars. Currency and conversion cost exist only in
 * euros. Under it, the server's one sentence on how far the euro result trails or beats the
 * dollar one. Every figure is the server's.
 */
export function CashOutCard({ out, title, className }: { out: CashOutOut; title?: ReactNode; className?: string }) {
  const e = out.eur;
  const u = out.usd;
  const rows: Row[] = [
    {
      key: "put_in",
      label: "Put in",
      eur: <Money amount={n(e.put_in)} currency="EUR" />,
      usd: <Money amount={n(u.put_in)} currency="USD" />,
    },
    {
      key: "market",
      label: "Market",
      eur: <Money amount={n(e.market)} currency="EUR" signed colored />,
      usd: <Money amount={n(u.market)} currency="USD" signed colored />,
    },
    { key: "currency", label: "Currency", eur: <Money amount={n(e.currency)} currency="EUR" signed colored />, usd: <EurOnly /> },
    {
      key: "conversion_cost",
      label: "Conversion cost",
      eur: <Money amount={n(e.conversion_cost)} currency="EUR" signed colored />,
      usd: <EurOnly />,
    },
    {
      key: "realised",
      label: "Realized",
      total: true,
      eur: (
        <span className="cash-out-card__pair">
          <Money amount={n(e.realised)} currency="EUR" signed colored />
          <Percent className="cash-out-card__pct" ratio={n(e.realised_pct)} signed digits={1} />
        </span>
      ),
      usd: (
        <span className="cash-out-card__pair">
          <Money amount={n(u.realised)} currency="USD" signed colored />
          <Percent className="cash-out-card__pct" ratio={n(u.realised_pct)} signed digits={1} />
        </span>
      ),
    },
    {
      key: "xirr",
      label: "A year",
      eur: e.xirr === null ? <span className="cash-out-card__none">–</span> : <Percent ratio={n(e.xirr)} signed colored digits={1} />,
      usd: u.xirr === null ? <span className="cash-out-card__none">–</span> : <Percent ratio={n(u.xirr)} signed colored digits={1} />,
    },
  ];
  return (
    <section className={clsx("cash-out-card", className)} aria-label="Cash-out result">
      <header className="cash-out-card__head">
        <span className="cash-out-card__icon" aria-hidden>
          <Undo2 className="cash-out-card__glyph" />
        </span>
        <div className="cash-out-card__headline">
          <p className="cash-out-card__title">
            {title ?? (
              <>
                <Money amount={n(out.eur_received)} currency="EUR" /> back in euros
              </>
            )}
          </p>
          <p className="cash-out-card__sub">
            {formatDate(out.date)} · <Money amount={n(out.usd_sent)} currency="USD" /> sent
            {n(out.fees_eur) ? (
              <>
                {" "}
                · fees <Money amount={n(out.fees_eur)} currency="EUR" />
              </>
            ) : null}
          </p>
        </div>
        {out.flagged && (
          <Chip size="sm" tone="warn" icon={<TriangleAlert aria-hidden />} className="cash-out-card__flag">
            Part at the ECB rate
          </Chip>
        )}
      </header>
      <table className="cash-out-card__table">
        <thead>
          <tr className="cash-out-card__row cash-out-card__row--head">
            <th className="cash-out-card__label" scope="col">
              <span className="u-sr-only">Part</span>
            </th>
            <th className="cash-out-card__cell" scope="col">
              In euros
            </th>
            <th className="cash-out-card__cell" scope="col">
              In dollars
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={clsx("cash-out-card__row", r.total && "cash-out-card__row--total")}>
              <th className="cash-out-card__label" scope="row">
                {r.label}
              </th>
              <td className="cash-out-card__cell">{r.eur}</td>
              <td className="cash-out-card__cell">{r.usd}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {out.note && (
        <p className="cash-out-card__note">
          <Info aria-hidden className="cash-out-card__note-icon" />
          {out.note}
        </p>
      )}
    </section>
  );
}
