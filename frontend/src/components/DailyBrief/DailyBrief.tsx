import { CalendarRange, Newspaper, Repeat } from "lucide-react";
import type { ReactNode } from "react";
import { Callout } from "../Callout";
import { DeltaBadge } from "../DeltaBadge";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { formatDayLabel, formatDayTime } from "../../lib/format";
import type { ReportingCurrency } from "../../lib/prefs";
import { toNum } from "../../lib/queries/portfolio";
import { useAckBrief, useBrief, type BriefDto, type BriefEventDto, type BriefMoveDto } from "../../lib/queries/brief";
import { useTimeZone } from "../../lib/timezone";
import "./DailyBrief.scss";

export interface DailyBriefProps {
  currency: ReportingCurrency;
}

const EVENT_LABEL: Record<string, string> = {
  buy: "Buy",
  sell: "Sell",
  dividend_cash: "Dividend",
  dividend_reinvest: "Div. reinvest",
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  interest: "Interest",
  fee: "Fee",
  split: "Split",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
};

/** "Dividend FAKEB", "Interest": one ledger row in a few words. */
export function eventLabel(e: BriefEventDto): string {
  const word = EVENT_LABEL[e.kind] ?? e.kind.replace(/_/g, " ");
  return e.symbol ? `${word} ${e.symbol}` : word;
}

function Events({ brief }: { brief: BriefDto }) {
  if (brief.events.length === 0) return null;
  const more = Math.max(0, brief.events_total - brief.events.length);
  return (
    <p className="daily-brief__line" data-testid="brief-events">
      <span className="daily-brief__key">In the ledger</span>
      <span className="daily-brief__events">
        {brief.events.map(eventLabel).join(", ")}
        {more > 0 && ` and ${more} more`}
      </span>
    </p>
  );
}

function SessionBody({ move, currency }: { move: BriefMoveDto; currency: ReportingCurrency }) {
  const winner = move.movers?.winners[0];
  const loser = move.movers?.losers[0];
  // The euro view splits the move into the market and the dollar; the dollar view has
  // no currency leg, so it says so on the same line (one shape in both views).
  const fx = toNum(move.currency_move ?? null);
  return (
    <>
      <p className="daily-brief__line" data-testid="brief-split">
        <span className="daily-brief__pair">
          <span className="daily-brief__key">Market</span>
          <Money amount={toNum(move.price_move ?? null)} currency={currency} signed colored />
        </span>
        <span className="daily-brief__pair">
          <span className="daily-brief__key">Currency</span>
          {/* The dollar book has no currency leg: the figure exists in one view only. */}
          <span className="daily-brief__fx" data-ccy-specific>
            {currency === "EUR" && fx !== null ? <Money amount={fx} currency={currency} signed colored /> : `none in ${currency}`}
          </span>
        </span>
      </p>
      {(winner || loser) && (
        <p className="daily-brief__line" data-testid="brief-movers">
          {winner && (
            <span className="daily-brief__pair">
              <span className="daily-brief__key">Led by</span>
              {winner.symbol} {winner.twin ? "≈ " : ""}
              <Percent ratio={toNum(winner.pct ?? null)} signed colored />
            </span>
          )}
          {loser && (
            <span className="daily-brief__pair">
              <span className="daily-brief__key">Held back by</span>
              {loser.symbol} {loser.twin ? "≈ " : ""}
              <Percent ratio={toNum(loser.pct ?? null)} signed colored />
            </span>
          )}
        </p>
      )}
    </>
  );
}

/** Title, figure and body for one kind of window. */
function content(brief: BriefDto, currency: ReportingCurrency): { icon: ReactNode; title: ReactNode; figure?: ReactNode; body: ReactNode } {
  const move = brief.move?.[currency] ?? null;
  if (brief.kind === "session" && move) {
    return {
      icon: <Newspaper aria-hidden />,
      title: (
        <>
          Session of {formatDayLabel(move.session_date)}
          {move.estimated && <span className="daily-brief__est"> ≈ est.</span>}
        </>
      ),
      figure: (
        <span className="daily-brief__figure" data-testid="brief-figure">
          <Money amount={toNum(move.day_move ?? null)} currency={currency} signed colored />
          <DeltaBadge value={toNum(move.day_move_pct ?? null)} />
        </span>
      ),
      body: <SessionBody move={move} currency={currency} />,
    };
  }
  if (brief.kind === "fx_reopen") {
    const fx = brief.fx_move?.[currency] ?? null;
    return {
      icon: <Repeat aria-hidden />,
      title: "The currency market reopened",
      body: (
        <p className="daily-brief__line" data-testid="brief-fx">
          <span className="daily-brief__key">{fx?.pair ?? "EUR/USD"}</span>
          <span>{fx?.spot_display ?? "–"}</span>
          {fx?.pct != null && <Percent ratio={toNum(fx.pct)} signed colored />}
          <span>stocks did not trade</span>
        </p>
      ),
    };
  }
  // Several sessions (or a single one without figures): an honest count, no totals yet.
  const n = Math.max(brief.sessions_passed, brief.sessions.length);
  return {
    icon: <CalendarRange aria-hidden />,
    title: n === 1 ? "1 session passed" : `${n} sessions passed`,
    body: (
      <p className="daily-brief__line" data-testid="brief-sessions">
        <span>{brief.sessions.map((d) => formatDayLabel(d)).join(" · ")}</span>
        <span className="daily-brief__note">No totals across several sessions yet; the graph below covers them.</span>
      </p>
    ),
  };
}

/**
 * The Daily Brief (plan §3.1): what happened since the owner last looked, above the
 * Overview stage, only when the server says one is due. Every figure is the server's
 * (copied from the Overview payload of that currency). Dismiss posts the
 * acknowledgement; the card goes at once and stays gone (back only if the write fails).
 */
export function DailyBrief({ currency }: DailyBriefProps) {
  const timeZone = useTimeZone();
  const brief = useBrief();
  const ack = useAckBrief();
  const b = brief.data;
  if (!b || !b.due) return null;
  const { icon, title, figure, body } = content(b, currency);
  return (
    <Callout
      className="daily-brief"
      label="Daily brief"
      eyebrow={b.last_ack_at ? `Since you looked · ${formatDayTime(b.last_ack_at, timeZone)}` : "Since you last looked"}
      icon={icon}
      title={title}
      figure={figure}
      onDismiss={() => ack.mutate(b.now)}
      dismissLabel="Dismiss the brief"
    >
      <div className="daily-brief__body">
        {body}
        <Events brief={b} />
      </div>
    </Callout>
  );
}
