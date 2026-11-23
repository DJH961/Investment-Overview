import { Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatDate, formatMoney, formatNumber } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import { useSettle, type EstimateRow, type SettleRowBody } from "../../lib/queries/recurring";
import {
  allInRate,
  derivePrice,
  effectiveDp,
  MONEY_DP,
  RATE_DP,
  relinkConversion,
  toDp,
} from "../../lib/settleMath";
import { Button } from "../Button";
import { Sheet } from "../Sheet";
import { Stepper } from "../Stepper";
import { useToast } from "../Toast";
import "./SettleSheet.scss";

export interface SettleSheetProps {
  /** The drafts to work through, in order (one plan or one due date). Empty = closed. */
  rows: readonly EstimateRow[];
  onClose: () => void;
}

interface Draft {
  total: string;
  quantity: string;
  /** A typed price that replaces the derived one (it never drives total or shares). */
  priceOverride: string | null;
  /** Total or shares were nudged: the price shown is derived from them. */
  touched: boolean;
  received: string;
  rate: string;
  fee: string;
}

const PRICE_SHOWN_DP = 4;

/** The currency's symbol as the app formats it ("US$", "€"), for a prefix on a figure. */
function symbolOf(currency: "USD" | "EUR"): string {
  return formatMoney(0, currency, { digits: 0 }).replace(/[\d\s.,]/g, "");
}

/** What the steppers move: the ledger's precision, without the padding zeros of a long draft. */
function dpsOf(row: EstimateRow): { priceDp: number; qtyDp: number } {
  return {
    // Shown and stepped at the usual price precision (4); the stored price keeps full precision.
    priceDp: Math.min(effectiveDp(row.price ?? "", row.price_dp), PRICE_SHOWN_DP),
    qtyDp: effectiveDp(row.quantity ?? "", row.quantity_dp),
  };
}

function draftOf(row: EstimateRow): Draft {
  const { qtyDp } = dpsOf(row);
  return {
    total: row.total ? toDp(row.total, MONEY_DP) : "",
    quantity: row.quantity ? toDp(row.quantity, qtyDp) : "",
    priceOverride: null,
    touched: false,
    received: row.received ? toDp(row.received, MONEY_DP) : "",
    rate: row.sent && row.received ? relinkConversion("received", { received: row.received, rate: "" }, row.sent).rate : "",
    fee: toDp(row.fees ?? "0", MONEY_DP),
  };
}

/** What the drafted row says it is, for the "Next: ..." line. */
function titleOf(row: EstimateRow): string {
  return row.row_type === "fx_conversion"
    ? `${row.label ? row.label[0]!.toUpperCase() + row.label.slice(1) : "Conversion"} conversion ${formatDate(row.date)}`
    : `${row.symbol ?? "Buy"} ${formatDate(row.date)}`;
}

/**
 * Quick-settle: one sheet that already holds the draft's figures. For a buy the two figures
 * the broker reports exactly, the total taken from the account and the shares received, are
 * the big steppers; the price per share is derived (total / shares) and shown smaller, with
 * an "Edit" to override it. For a conversion, USD received and the rate move around the EUR
 * sent. One Save confirms the row (a buy's core-fund leg follows on the server) and moves on
 * to the next draft, or closes after the last.
 */
export function SettleSheet({ rows, onClose }: SettleSheetProps) {
  const open = rows.length > 0;
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [mult, setMult] = useState<1 | 10>(1);
  const [editingPrice, setEditingPrice] = useState(false);
  const settle = useSettle();
  const { toast } = useToast();
  // EUR display mode only: a muted "about" line under the total, at the rate the server
  // sends with the row (the dollars' own conversion, else the ECB rate).
  const { currency: display } = usePrefs();

  // A fresh queue starts at the first draft.
  const signature = rows.map((r) => `${r.row_type}:${r.id}`).join(",");
  useEffect(() => {
    setIndex(0);
    setDrafts({});
    setMult(1);
    setEditingPrice(false);
  }, [signature]);

  const row = rows[Math.min(index, Math.max(rows.length - 1, 0))];
  const key = row ? `${row.row_type}:${row.id}` : "";
  const original = useMemo(() => (row ? draftOf(row) : null), [row]);
  const draft = drafts[key] ?? original;

  if (!open || !row || !draft || !original) {
    return <Sheet open={false} onOpenChange={() => onClose()} title="Settle" />;
  }

  const isBuy = row.row_type === "transaction";
  const ccy = (row.currency === "EUR" ? "EUR" : "USD") as "USD" | "EUR";
  const sym = symbolOf(ccy);
  const totalIn = Number(draft.total);
  const rate = Number(row.eur_rate);
  const aboutTotal =
    display === "EUR" && ccy === "USD" && rate > 0 && totalIn > 0
      ? `≈ ${formatMoney(totalIn / rate, "EUR")} ${
          row.eur_rate_source === "conversion"
            ? `at your ${formatDate(row.eur_rate_date ?? "")} conversion (${formatNumber(rate, 4)})`
            : "at the ECB rate"
        }`
      : undefined;
  const dps = dpsOf(row);
  const set = (next: Draft) => setDrafts((d) => ({ ...d, [key]: next }));
  // Full precision is what gets stored; the line below shows it rounded to `priceDp`.
  const fullPrice =
    draft.priceOverride ?? (draft.touched ? derivePrice(draft.total, draft.quantity, row.price_dp) : (row.price ?? ""));
  const price = fullPrice ? toDp(fullPrice, dps.priceDp) : "";
  const editReceived = (received: string) =>
    set({ ...draft, received, rate: relinkConversion("received", { received, rate: draft.rate }, row.sent ?? "0").rate });
  const editRate = (rate: string) =>
    set({ ...draft, rate, received: relinkConversion("rate", { received: draft.received, rate }, row.sent ?? "0").received });

  // Every row is saved with the figures shown: nothing is confirmed unseen.
  const body = (): SettleRowBody => {
    const base = { row_type: row.row_type, id: row.id } as SettleRowBody;
    // Net is the total; the stored price is the derived (or overridden) one.
    if (isBuy) return { ...base, price: fullPrice || undefined, quantity: draft.quantity, total: draft.total };
    return { ...base, received: draft.received, fees: draft.fee };
  };

  const last = index >= rows.length - 1;
  const next = rows[index + 1];
  const save = () =>
    settle.mutate(
      { rows: [body()] },
      {
        onSuccess: () => {
          toast({ title: "Settled", tone: "success" });
          setEditingPrice(false);
          if (last) onClose();
          else setIndex(index + 1);
        },
        onError: (e) => toast({ title: "Could not settle", description: e.message, tone: "error" }),
      },
    );

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={isBuy ? "Settle this buy" : "Settle this conversion"}>
      <div className="settle-sheet">
        <p className="settle-sheet__head">
          <strong>{titleOf(row)}</strong>
          <span className="settle-sheet__count">
            {index + 1} of {rows.length}
          </span>
        </p>
        <p className="settle-sheet__note">
          {isBuy
            ? "Estimated at that day's close. Set the total and the shares to what your broker shows."
            : `${formatMoney(Number(row.sent ?? 0), "EUR")} sent, from your plan. Type what you received.`}
        </p>
        <button
          type="button"
          className="settle-sheet__mult"
          aria-pressed={mult === 10}
          onClick={() => setMult(mult === 1 ? 10 : 1)}
        >
          Step ×10
        </button>
        {isBuy ? (
          <div className="settle-sheet__fields">
            <Stepper
              label="Total"
              value={draft.total}
              dp={MONEY_DP}
              mult={mult}
              prefix={sym}
              hint={aboutTotal}
              onChange={(v) => set({ ...draft, total: v, touched: true })}
            />
            <Stepper
              label="Shares"
              value={draft.quantity}
              dp={dps.qtyDp}
              mult={mult}
              onChange={(v) => set({ ...draft, quantity: v, touched: true })}
            />
            <div className="settle-sheet__price">
              {editingPrice ? (
                <>
                  <Stepper
                    label="Price per share (typed)"
                    prefix={sym}
                    value={price}
                    dp={dps.priceDp}
                    mult={mult}
                    onChange={(v) => set({ ...draft, priceOverride: v })}
                  />
                  <Button
                    className="settle-sheet__small"
                    variant="ghost"
                    onClick={() => {
                      set({ ...draft, priceOverride: null });
                      setEditingPrice(false);
                    }}
                  >
                    Use total ÷ shares
                  </Button>
                </>
              ) : (
                <>
                  <span className="settle-sheet__price-text">
                    Price per share <strong className="money">{price ? `${sym} ${price}` : "–"}</strong>
                    <span className="settle-sheet__price-hint">{draft.touched ? " (total ÷ shares)" : ""}</span>
                  </span>
                  <Button className="settle-sheet__small" variant="ghost" onClick={() => setEditingPrice(true)}>
                    Edit price
                  </Button>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="settle-sheet__fields">
            <Stepper label="USD received" value={draft.received} dp={MONEY_DP} mult={mult} prefix={symbolOf("USD")} onChange={editReceived} />
            <Stepper
              label="Rate"
              value={draft.rate}
              dp={RATE_DP}
              mult={mult}
              onChange={editRate}
              hint={`All-in ${allInRate(row.sent ?? "0", draft.fee, draft.received) || "–"} with the fee`}
            />
            <Stepper
              label="Fee (EUR)"
              prefix={symbolOf("EUR")}
              value={draft.fee}
              dp={MONEY_DP}
              mult={mult}
              onChange={(fee) => set({ ...draft, fee })}
            />
          </div>
        )}
        <div className="settle-sheet__actions">
          <Button variant="primary" size="lg" fullWidth leftIcon={<Check aria-hidden />} loading={settle.isPending} onClick={save}>
            {last ? "Save" : `Save, next: ${titleOf(next!)}`}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
