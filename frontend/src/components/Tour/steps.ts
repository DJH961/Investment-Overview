/** Guided tour content (adapted from the v5 companion's web/src/tour.ts). */
export interface TourStep {
  /** CSS selector of the nav item to anchor to; omitted = centred dialog. */
  selector?: string;
  title: string;
  body: string;
  /** Phone overrides: the nav item may sit in the More sheet, and there are no arrow keys. */
  phone?: { selector?: string; body?: string };
}

/** The More tab of the phone tab bar (pages that are not in the bar live behind it). */
const MORE_TAB = '[data-tour="more"]';

export const TOUR_STEPS: TourStep[] = [
  {
    title: "Welcome to Investment Overview",
    body: "A quick tour of the main areas. Use the arrow keys to move, or Escape to skip.",
    phone: { body: "A quick tour of the main areas. Tap Next to move on, or Skip to leave." },
  },
  {
    selector: 'a[href="/overview"]',
    title: "Your portfolio at a glance",
    body: "The headline value and today's move. The currency toggle converts valuations at the current rate and cashflows at their own date's rate.",
  },
  {
    selector: 'a[href="/holdings"]',
    title: "Holdings",
    body: "Every position in its native currency, with weights and gains.",
  },
  {
    selector: 'a[href="/risk"]',
    title: "Risk and analytics",
    body: "Sharpe, Sortino, drawdown, VaR and beta against a benchmark, each with a plain-language definition.",
    phone: { selector: MORE_TAB, body: "Under More: Sharpe, Sortino, drawdown, VaR and beta against a benchmark, each with a plain-language definition." },
  },
  {
    selector: 'a[href="/projection"]',
    title: "Plan ahead",
    body: "A what-if calculator projects future value from your current mix, contributions and an expected return band.",
    phone: { selector: MORE_TAB, body: "Under More: a what-if calculator projects future value from your current mix, contributions and an expected return band." },
  },
  {
    selector: 'a[href="/import"]',
    title: "Bring in your data",
    body: "Upload a broker export, preview it, then confirm. Nothing is written until you confirm.",
    phone: { selector: MORE_TAB, body: "Under More: upload a broker export, preview it, then confirm. Nothing is written until you confirm." },
  },
  {
    title: "That is it",
    body: "You can replay this tour any time from Help.",
  },
];
