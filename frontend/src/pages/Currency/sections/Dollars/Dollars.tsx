import { Hourglass, Undo2, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Callout } from "../../../../components/Callout";
import { Card } from "../../../../components/Card";
import { CurrencySection } from "../../../../components/CurrencySection";
import { DivergingBar } from "../../../../components/DivergingBar";
import { InfoTip } from "../../../../components/InfoTip";
import { Money } from "../../../../components/Money";
import { StatStrip, type StatItem } from "../../../../components/StatStrip";
import { formatDate, formatNumber } from "../../../../lib/format";
import type { BridgeKey, JourneyView } from "../../../../lib/journey-types";
import { useJourney } from "../../../../lib/queries/journey";
import type { CurrencySectionComponentProps } from "../../sections";
import "./Dollars.scss";

const n = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

/** The bridge lines, in the order of the journey. Each says in a few words where it happened. */
export const BRIDGE_LINES: Record<BridgeKey, { label: string; tip: string }> = {
  conversion_cost: {
    label: "Conversion cost",
    tip: "What your conversions cost against the ECB rate of their day, both ways: the provider's spread plus fees.",
  },
  waiting: {
    label: "While waiting",
    tip: "The rate's move on dollars that sat in your USD account between the conversion and the deposit.",
  },
  cash: {
    label: "Broker cash",
    tip: "The rate's move on dollars at the broker that are not invested, sale proceeds included, at what they cost you.",
  },
  holdings: {
    label: "Holdings",
    tip: "The rate's move on the dollars in your holdings, against what those dollars cost you. Realized only when you convert back.",
  },
  realised: {
    label: "Back in euros",
    tip: "Realized: the rate's move on dollars you converted back to euros, against what they cost you.",
  },
};

/** Two quiet lines under each figure, the same count in both views, so nothing jumps on a switch. */
function Lines({ a, b }: { a: ReactNode; b: ReactNode }) {
  return (
    <span className="dollars__lines">
      <span className="dollars__line">{a}</span>
      <span className="dollars__line">{b}</span>
    </span>
  );
}

function eurLines(nowEur: string | null, costEur: string | null) {
  return (
    <Lines
      a={
        <>
          <Money amount={n(nowEur)} currency="EUR" digits={0} /> now
        </>
      }
      b={
        <>
          cost <Money amount={n(costEur)} currency="EUR" digits={0} />
        </>
      }
    />
  );
}

export function dollarStats(view: JourneyView, usdView: boolean): StatItem[] {
  const s = view.stats;
  const rate = s.your_rate;
  const oldest = view.idle[0];
  return [
    {
      key: "usd_account",
      label: "USD account",
      tip: "Dollars you converted and have not sent to the broker yet.",
      value: <Money amount={n(s.usd_account.usd)} currency="USD" digits={0} />,
      note: usdView ? (
        <Lines a="not at the broker" b={oldest ? `oldest ${oldest.days} days` : "none waiting long"} />
      ) : (
        eurLines(s.usd_account.eur_now, s.usd_account.eur_cost)
      ),
    },
    {
      key: "broker_cash",
      label: "Broker cash",
      tip: "Dollars at the broker that are not invested: the money-market fund and sale proceeds.",
      value: <Money amount={n(s.broker_cash.usd)} currency="USD" digits={0} />,
      note: usdView ? <Lines a="not invested" b="sale proceeds included" /> : eurLines(s.broker_cash.eur_now, s.broker_cash.eur_cost),
    },
    {
      key: "invested",
      label: "Invested",
      tip: "Your holdings' dollars today, against what those dollars cost you.",
      value: <Money amount={n(s.invested.usd)} currency="USD" digits={0} />,
      note: usdView ? (
        <Lines
          a={
            <>
              cost <Money amount={n(s.invested.usd_cost)} currency="USD" digits={0} />
            </>
          }
          b={
            <>
              market <Money amount={n(s.invested.market_usd)} currency="USD" signed digits={0} />
            </>
          }
        />
      ) : (
        eurLines(s.invested.eur_now, s.invested.eur_cost)
      ),
    },
    {
      key: "your_rate",
      label: "Your rate",
      tip: "The EUR/USD you really paid for the dollars you hold, blended over your conversions, with the ECB rate of the same days beside it.",
      value: formatNumber(n(rate.rate), 4),
      note: <Lines a={`ECB ${formatNumber(n(rate.ecb_avg), 4)}`} b={`now ${formatNumber(n(rate.now), 4)}`} />,
    },
  ];
}

/** Where the lifetime currency effect came from, stage by stage (EUR view only). */
export function JourneyBridgeCard({ view }: { view: JourneyView }) {
  const bridge = view.bridge;
  if (!bridge) return null;
  // "Back in euros" is a line only once there has been a cash-out; other zero lines stay
  // (a stage the money passed through that cost nothing is still an answer).
  const lines = bridge.lines.filter((l) => l.key !== "realised" || view.back_in_euros);
  const back = view.back_in_euros;
  return (
    <Card
      className="dollars__bridge"
      title={
        <span className="dollars__title">
          Where your currency effect came from
          <InfoTip
            label="Where your currency effect came from"
            content="Each stage your dollars passed through, valued against what those dollars cost you in euros. Together they make your lifetime currency effect."
          />
        </span>
      }
    >
      <DivergingBar
        className="dollars__bars"
        ariaLabel="Currency effect by stage"
        rows={lines.map((l) => ({
          id: l.key,
          label: BRIDGE_LINES[l.key].label,
          value: Number(l.eur),
          display: <Money amount={Number(l.eur)} currency="EUR" signed colored digits={0} />,
        }))}
      />
      <div className="dollars__total">
        <span className="dollars__total-label">
          Currency effect, lifetime
          <span className="dollars__total-note">same as the Overview card</span>
        </span>
        <Money className="dollars__total-value" amount={Number(bridge.total_eur)} currency="EUR" signed colored digits={0} />
      </div>
      {back ? (
        <p className="dollars__back">
          <Undo2 aria-hidden className="dollars__back-icon" />
          <span>
            {back.count === 1 ? "One cash-out" : `${back.count} cash-outs`}: <Money amount={Number(back.eur_received)} currency="EUR" digits={0} /> back in euros,
            realized <Money amount={Number(back.realised_eur)} currency="EUR" signed colored digits={0} />.{" "}
            <Link to="/conversions?direction=to_eur" className="dollars__link">
              See them
            </Link>
          </span>
        </p>
      ) : null}
    </Card>
  );
}

/** Idle dollars (over 30 days in the USD account): a calm note, not a warning. */
export function IdleCallout({ view }: { view: JourneyView }) {
  const idle = view.idle;
  if (idle.length === 0) return null;
  const total = idle.reduce((t, i) => t + Number(i.usd), 0);
  const oldest = idle[0]!;
  return (
    <Callout
      label="Idle dollars"
      tone="neutral"
      icon={<Hourglass aria-hidden />}
      title={
        <>
          <Money amount={total} currency="USD" digits={0} /> {idle.length === 1 ? "has" : "have"} waited over 30 days
        </>
      }
      actions={
        <Link to={`/conversions#conversion-${oldest.conversion_id}`} className="dollars__link">
          Open the conversion
        </Link>
      }
    >
      {idle.length === 1
        ? `Since your conversion of ${formatDate(oldest.date)}, ${oldest.days} days in the USD account. `
        : `From ${idle.length} conversions, the oldest of ${formatDate(oldest.date)} (${oldest.days} days). `}
      Waiting dollars earn nothing and still move with the rate.
    </Callout>
  );
}

/** "Your dollars" (7.4): where your dollars are now, and where the currency effect came from. */
export function Dollars({ id, label, currency }: CurrencySectionComponentProps) {
  const q = useJourney(currency);
  const view = q.data;
  const usdView = currency === "USD";
  const empty =
    view &&
    Number(view.stats.usd_account.usd) === 0 &&
    Number(view.stats.broker_cash.usd) === 0 &&
    Number(view.stats.invested.usd) === 0;
  const state = q.isError && !view ? "error" : !view ? "loading" : empty ? "empty" : "ready";
  return (
    <CurrencySection
      id={id}
      title={label}
      explainer={
        usdView
          ? "Where your dollars are now, from the USD account to your holdings, and the rate you paid for them."
          : "Where your dollars are now, what they cost you in euros, and where your currency effect came from."
      }
      state={state}
      onRetry={() => void q.refetch()}
      busy={q.isFetching && !q.isPending}
      emptyIcon={<Wallet aria-hidden />}
      emptyTitle="No dollars yet"
      emptyDescription="Once you convert euros to dollars, this shows where they went."
      skeleton={["6.5rem", "14rem"]}
      className="dollars"
    >
      {view ? (
        <>
          <StatStrip four label="USD cash & holdings at a glance" items={dollarStats(view, usdView)} className="dollars__strip" />
          {usdView ? null : <JourneyBridgeCard view={view} />}
          <IdleCallout view={view} />
        </>
      ) : null}
    </CurrencySection>
  );
}
