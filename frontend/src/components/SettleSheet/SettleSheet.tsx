import { Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatDate, formatMoney } from "../../lib/format";
import { useSettle, type EstimateRow, type SettleRowBody } from "../../lib/queries/recurring";
import {
  allInRate,
  MONEY_DP,
  RATE_DP,
  relinkBuy,
  relinkConversion,
  toDp,
  type BuyField,
  type BuyValues,
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
  buy: BuyValues;
  received: string;
  rate: string;
  fee: string;
}

function draftOf(row: EstimateRow): Draft {
  const priceDp = row.price_dp;
  const qtyDp = row.quantity_dp;
  return {
    buy: {
      price: row.price ? toDp(row.price, priceDp) : "",
      quantity: row.quantity ? toDp(row.quantity, qtyDp) : "",
      total: row.total ? toDp(row.total, MONEY_DP) : "",
    },
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
 * Quick-settle: one sheet that already holds the draft's figures. Every figure has − / +
 * steppers on its last stored decimal; linked figures follow (buy: price, quantity, total
 * around the plan's fixed amount; conversion: USD received and the rate around the EUR
 * sent). One Save confirms the row (a buy's core-fund leg follows on the server) and moves
 * to the next draft, or closes after the last.
 */
export function SettleSheet({ rows, onClose }: SettleSheetProps) {
  const open = rows.length > 0;
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [mult, setMult] = useState<1 | 10>(1);
  const settle = useSettle();
  const { toast } = useToast();

  // A fresh queue starts at the first draft.
  const signature = rows.map((r) => `${r.row_type}:${r.id}`).join(",");
  useEffect(() => {
    setIndex(0);
    setDrafts({});
    setMult(1);
  }, [signature]);

  const row = rows[Math.min(index, Math.max(rows.length - 1, 0))];
  const key = row ? `${row.row_type}:${row.id}` : "";
  const original = useMemo(() => (row ? draftOf(row) : null), [row]);
  const draft = drafts[key] ?? original;

  if (!open || !row || !draft || !original) {
    return <Sheet open={false} onOpenChange={() => onClose()} title="Settle" />;
  }

  const isBuy = row.row_type === "transaction";
  const set = (next: Draft) => setDrafts((d) => ({ ...d, [key]: next }));
  const edit = (field: BuyField, value: string) =>
    set({ ...draft, buy: relinkBuy(field, { ...draft.buy, [field]: value }, "total", { priceDp: row.price_dp, quantityDp: row.quantity_dp, moneyDp: MONEY_DP }) });
  const editReceived = (received: string) =>
    set({ ...draft, received, rate: relinkConversion("received", { received, rate: draft.rate }, row.sent ?? "0").rate });
  const editRate = (rate: string) =>
    set({ ...draft, rate, received: relinkConversion("rate", { received: draft.received, rate }, row.sent ?? "0").received });

  const body = (): SettleRowBody => {
    const base = { row_type: row.row_type, id: row.id } as SettleRowBody;
    if (isBuy) {
      const changed = (Object.keys(draft.buy) as BuyField[]).some((k) => draft.buy[k] !== original.buy[k]);
      return changed ? { ...base, price: draft.buy.price, quantity: draft.buy.quantity, total: draft.buy.total } : base;
    }
    const changed = draft.received !== original.received || draft.fee !== original.fee;
    return changed ? { ...base, received: draft.received, fees: draft.fee } : base;
  };

  const last = index >= rows.length - 1;
  const next = rows[index + 1];
  const save = () =>
    settle.mutate(
      { rows: [body()] },
      {
        onSuccess: () => {
          toast({ title: "Settled", tone: "success" });
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
            ? "Estimated at that day's close. Nudge each figure to what your broker shows."
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
            <Stepper label="Price" value={draft.buy.price} dp={row.price_dp} mult={mult} onChange={(v) => edit("price", v)} />
            <Stepper label="Quantity" value={draft.buy.quantity} dp={row.quantity_dp} mult={mult} onChange={(v) => edit("quantity", v)} />
            <Stepper label="Total" value={draft.buy.total} dp={MONEY_DP} mult={mult} onChange={(v) => edit("total", v)} />
          </div>
        ) : (
          <div className="settle-sheet__fields">
            <Stepper label="USD received" value={draft.received} dp={MONEY_DP} mult={mult} onChange={editReceived} />
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
