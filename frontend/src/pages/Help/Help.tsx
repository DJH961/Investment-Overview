import { PlayCircle } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { TOUR_STEPS } from "../../components/Tour/steps";
import { PageHeader } from "../../components/PageHeader";
import { GLOSSARY } from "../../lib/glossary";
import { NAV_ITEMS } from "../../lib/nav";
import "./Help.scss";

/** What each page is for, keyed by route (the list itself comes from NAV_ITEMS). */
const PAGE_GUIDE: Record<string, string> = {
  "/overview": "Headline value, today's move, the FX box, the value chart, movers and warnings. Pull down on a phone to refresh prices.",
  "/holdings": "Every position with value, cost and gain. Tap a row for its detail; sort and search from the header.",
  "/periods": "Monthly and yearly growth (TWR), contributions and gain side by side. Folding cards explain how each figure is computed.",
  "/activity": "Contributions and dividends over time, with filters.",
  "/risk": "Risk, return and attribution for a lookback from 1M to 5Y, compared with a benchmark fed with the same deposits.",
  "/projection": "A what-if calculator that projects future value from your mix, contributions and an expected return band.",
  "/transactions": "The full ledger. Add a trade by hand, correct a row or override which instrument a row points to.",
  "/import": "Load a broker export, review the preview, confirm. Past imports are listed and each can be undone.",
  "/conversions": "Record real currency conversions so they replace the ECB daily rate for the matching deposits.",
  "/allocations": "Compare your mix with a target and plan a rebalance or a new investment.",
  "/diagnostics": "Health and repair: missing or stale prices, failed providers, repair jobs, manual price fixes and logs.",
  "/settings": "Display, data sources, passkeys and other preferences.",
  "/help": "This page.",
};

const QUICK_START: string[] = [
  "Open Import and load your broker export. Review the preview, then confirm: nothing changes until you do.",
  "Check Instruments (from Transactions or Import) so every symbol maps to the right security.",
  "Record real currency conversions on the Currency conversions page if you made any.",
  "Set your targets on Allocations to see how far your mix has drifted.",
  "Add a passkey in Settings so you can sign in with your device.",
];

const SETTINGS_GUIDE: { id: string; title: string; body: string }[] = [
  {
    id: "in-app",
    title: "In-app settings",
    body: "Settings holds display preferences (reporting currency, default risk lookback, timezone), data options and security. Changes apply at once and are remembered on the server unless marked as per device.",
  },
  {
    id: "sources",
    title: "Where a value comes from",
    body: "Each setting shows its source: app (you changed it in Settings), env (set by the server's environment file) or default (built-in). A value you set in the app wins over the server's environment file; the environment value is the fallback, and the built-in default comes last. Where the environment file sets limits, the app cannot go beyond them.",
  },
  {
    id: "repair",
    title: "Repair jobs",
    body: "On Health & Repair you can run repair jobs such as refetching prices or rebuilding history. Each job explains what it does and asks for confirmation. Most can be re-run safely.",
  },
  {
    id: "price-fix",
    title: "Manual price fixes",
    body: "If a provider returns a wrong or missing price, enter the correct one for that instrument and date on Health & Repair. Your value is kept and used instead of the provider's.",
  },
  {
    id: "undo-import",
    title: "Undo an import",
    body: "Import lists past batches. Undo removes the transactions that batch created, so a wrong file can be taken back without touching anything else.",
  },
];

const PHONE_TIPS: { id: string; title: string; body: string }[] = [
  {
    id: "topbar",
    title: "Phone top bar",
    body: "The top bar shows the page title, the data-health badge and a refresh action. Tap the badge to open Health & Repair. Pages not on the bottom tabs are under More.",
  },
  {
    id: "pull",
    title: "Pull to refresh",
    body: "On a phone, pull down from the top of a page to refresh its data and live prices.",
  },
  {
    id: "folding",
    title: "Folding sections",
    body: "Cards with a chevron in the header can be folded. Each page remembers which ones you folded on this device.",
  },
];

const FAQ: { id: string; title: string; body: string }[] = [
  {
    id: "wrong",
    title: "A number looks wrong or out of date",
    body: "Open Health & Repair: it lists missing prices, stale data and failed providers, and lets you refresh now or fix a price by hand.",
  },
  {
    id: "start-over",
    title: "How do I start over?",
    body: "Undo the import batches on the Import page, or delete rows on Transactions. Your settings are kept.",
  },
  {
    id: "return-kinds",
    title: "XIRR, TWR or CAGR?",
    body: "TWR judges the investments regardless of when you deposited. XIRR reflects your own deposit timing. CAGR is the steady yearly rate between two values. See the glossary below.",
  },
  {
    id: "privacy",
    title: "Where is my data?",
    body: "Everything lives in your own encrypted database on your server. Prices and exchange rates are fetched from public providers; your holdings are never sent to them.",
  },
  {
    id: "currency-fx",
    title: "Currency and FX",
    body: "Every amount is stored in its own currency. When reporting, cashflows use the rate of their own date and valuations use the rate of the valuation moment. A return is never computed in one currency and converted into another.",
  },
  {
    id: "freshness",
    title: "Freshness and market hours",
    body: "The status chip shows whether prices are live, from the last close, stale or still loading. Mutual fund prices are published once a day, around 18:30 US Eastern time.",
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
      <Card title="Quick start" collapsibleId="help.quick-start">
        <ol className="help__tour">
          {QUICK_START.map((t) => (
            <li key={t} className="help__step">
              <span className="help__text">{t}</span>
            </li>
          ))}
        </ol>
      </Card>
      <Card title="Tour" collapsibleId="help.tour">
        <ol className="help__tour">
          {TOUR_STEPS.map((s) => (
            <li key={s.title} className="help__step">
              <div>
                <h3 className="help__heading">{s.title}</h3>
                <p className="help__text">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>
      <Card title="Page guide" collapsibleId="help.pages">
        <dl className="help__list">
          {NAV_ITEMS.map((i) => (
            <div key={i.to} className="help__item" data-testid="guide-entry">
              <dt className="help__heading">{i.label}</dt>
              <dd className="help__text">{PAGE_GUIDE[i.to] ?? ""}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title="On your phone" collapsibleId="help.phone" defaultOpen={false}>
        <HelpList items={PHONE_TIPS} />
      </Card>
      <Card title="Settings explained" collapsibleId="help.settings" defaultOpen={false}>
        <HelpList items={SETTINGS_GUIDE} />
      </Card>
      <Card title="FAQ" collapsibleId="help.faq" defaultOpen={false}>
        <HelpList items={FAQ} />
      </Card>
      <Card title="Glossary" collapsibleId="help.glossary" defaultOpen={false}>
        <dl className="help__list">
          {GLOSSARY.map((g) => (
            <div key={g.key} className="help__item">
              <dt className="help__heading">{g.term}</dt>
              <dd className="help__text">{g.definition}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}

function HelpList({ items }: { items: { id: string; title: string; body: string }[] }) {
  return (
    <dl className="help__list">
      {items.map((i) => (
        <div key={i.id} id={i.id} className="help__item">
          <dt className="help__heading">{i.title}</dt>
          <dd className="help__text">{i.body}</dd>
        </div>
      ))}
    </dl>
  );
}
