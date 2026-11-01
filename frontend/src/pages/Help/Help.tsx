import { PlayCircle } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { PageHeader } from "../../components/PageHeader";
import "./Help.scss";

/** Ported from web/src/tour.ts DEMO_TOUR_STEPS (v6 adds Holdings, Import and Allocations). */
export const TOUR_STEPS: { id: string; title: string; body: string }[] = [
  {
    id: "hero",
    title: "Your portfolio at a glance",
    body: "The headline value and today's move are the hero of the screen, designed mobile-first, like a modern neobroker.",
  },
  {
    id: "currency",
    title: "FX-aware currency box",
    body: "For a euro investor holding dollars, part of today's move comes from the EUR/USD swing. This box splits that out. In USD view it is honest that the rate changes nothing about your dollar value.",
  },
  {
    id: "chart",
    title: "Live value over time",
    body: "The curve runs right up to a live tip. Flip the currency toggle and the EUR and USD lines genuinely diverge by the FX move.",
  },
  {
    id: "risk",
    title: "Institutional-grade risk metrics",
    body: "Sharpe, Sortino, max drawdown, VaR, beta/alpha and an equity curve versus a benchmark. Each metric has a plain-language definition on tap.",
  },
  {
    id: "plan",
    title: "Plan ahead",
    body: "A what-if calculator projects future value from your current mix, contributions and an expected return band.",
  },
  {
    id: "holdings",
    title: "Holdings, Import and Allocations",
    body: "Holdings lists every position, Import loads broker files, and Allocations compares your mix with a target and plans a rebalance.",
  },
];

const SECTIONS: { id: string; title: string; body: string }[] = [
  {
    id: "currency-fx",
    title: "Currency and FX",
    body: "Every amount is stored in its own currency. When reporting, cashflows use the rate of their own date and valuations use the rate of the valuation moment. A return is never computed in one currency and converted into another. Real conversions you record on the Currency conversions page replace the ECB daily rate for the matching deposits.",
  },
  {
    id: "freshness",
    title: "Freshness and market hours",
    body: "The status chip shows whether prices are live, from the last close, stale or still loading. Mutual fund prices are published once a day, around 18:30 US Eastern time.",
  },
  {
    id: "import",
    title: "Importing",
    body: "Upload a broker export on the Import page, review the preview, then confirm. Nothing changes until you confirm.",
  },
  {
    id: "faq",
    title: "A number looks wrong or out of date",
    body: "Open Diagnostics: it lists missing prices, stale data and failed providers, and lets you refresh now.",
  },
];

export function startTourFlag(): void {
  try {
    localStorage.setItem("iv.tour.replay", "1");
  } catch {
    /* ignore */
  }
}

export function Help() {
  const navigate = useNavigate();
  return (
    <div className="help">
      <PageHeader
        title="Help"
        subtitle="A guided tour and plain-language notes."
        actions={
          <Button
            variant="secondary"
            leftIcon={<PlayCircle aria-hidden />}
            onClick={() => {
              startTourFlag();
              navigate("/overview");
            }}
          >
            Replay tour
          </Button>
        }
      />
      <Card title="Tour">
        <ol className="help__tour">
          {TOUR_STEPS.map((s) => (
            <li key={s.id} className="help__tour-step">
              <h3 className="help__heading">{s.title}</h3>
              <p className="help__text">{s.body}</p>
            </li>
          ))}
        </ol>
      </Card>
      {SECTIONS.map((s) => (
        <Card key={s.id} title={s.title} id={s.id}>
          <p className="help__text">{s.body}</p>
        </Card>
      ))}
    </div>
  );
}
