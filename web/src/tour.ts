/**
 * Guided spotlight tour — a tiny, dependency-free overlay that walks a viewer
 * through the headline features one at a time. It is used by the demo so the
 * companion can pitch itself in an interview: highlight the hero value, the
 * FX-aware today's move, the live value chart, the risk metrics and the
 * calculator, each with a one-line caption.
 *
 * Everything here is pure DOM: a dimming backdrop, a focus ring around the
 * current target, and a small caption card with Back / Next / Done. It targets
 * elements by CSS selector and can switch dashboard tabs (by clicking the tab
 * button) so a step can point at content on another tab. Nothing is fetched and
 * no state is persisted beyond a "don't auto-open again" flag.
 */
import { h } from "./ui";

export interface TourStep {
  /** CSS selector for the element to spotlight (first match wins). */
  selector: string;
  /** Caption title. */
  title: string;
  /** Caption body (plain text). */
  body: string;
  /** Optional dashboard tab id to switch to before showing this step. */
  tab?: string;
}

const PADDING = 8;

/** True when the viewer prefers reduced motion (we then skip smooth scrolls). */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * Start the guided tour. Returns a function that stops and tears it down. Safe
 * to call in a non-DOM environment (it becomes a no-op).
 */
export function startTour(steps: TourStep[], opts: { onClose?: () => void } = {}): () => void {
  if (typeof document === "undefined" || steps.length === 0) return () => undefined;

  const reduced = prefersReducedMotion();
  let index = 0;
  let closed = false;

  const ring = h("div", { class: "tour-ring", "aria-hidden": "true" });
  const card = h("div", { class: "tour-card", role: "dialog", "aria-modal": "true", "aria-label": "Guided tour" });
  const backdrop = h("div", { class: "tour-backdrop" }, [ring, card]);

  const stop = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", reposition);
    window.removeEventListener("scroll", reposition, true);
    backdrop.remove();
    opts.onClose?.();
  };

  const go = (next: number): void => {
    if (next < 0 || next >= steps.length) {
      stop();
      return;
    }
    index = next;
    render();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      stop();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(index - 1);
    }
  };

  function currentTarget(): HTMLElement | null {
    const step = steps[index];
    if (step.tab) document.getElementById(`tab-${step.tab}`)?.click();
    return document.querySelector<HTMLElement>(step.selector);
  }

  function reposition(): void {
    const target = document.querySelector<HTMLElement>(steps[index].selector);
    if (!target) {
      // No target on screen: hide the ring and centre the card.
      ring.style.opacity = "0";
      card.style.left = "50%";
      card.style.top = "50%";
      card.style.transform = "translate(-50%, -50%)";
      return;
    }
    const rect = target.getBoundingClientRect();
    ring.style.opacity = "1";
    ring.style.left = `${rect.left - PADDING}px`;
    ring.style.top = `${rect.top - PADDING}px`;
    ring.style.width = `${rect.width + PADDING * 2}px`;
    ring.style.height = `${rect.height + PADDING * 2}px`;

    // Prefer placing the card below the target; flip above when there's no room.
    const cardRect = card.getBoundingClientRect();
    const below = rect.bottom + PADDING;
    const wantsAbove = below + cardRect.height > window.innerHeight && rect.top > cardRect.height + PADDING;
    const top = wantsAbove ? rect.top - cardRect.height - PADDING : below;
    let left = rect.left;
    left = Math.max(PADDING, Math.min(left, window.innerWidth - cardRect.width - PADDING));
    card.style.transform = "none";
    card.style.left = `${left}px`;
    card.style.top = `${Math.max(PADDING, top)}px`;
  }

  function render(): void {
    const step = steps[index];
    const target = currentTarget();
    if (target) {
      target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center", inline: "nearest" });
    }

    const isLast = index === steps.length - 1;
    const back = h("button", { class: "btn ghost tour-btn", type: "button" }, ["Back"]) as HTMLButtonElement;
    if (index === 0) back.setAttribute("disabled", "disabled");
    back.addEventListener("click", () => go(index - 1));
    const next = h("button", { class: "btn tour-btn", type: "button" }, [isLast ? "Done" : "Next"]) as HTMLButtonElement;
    next.addEventListener("click", () => go(index + 1));
    const skip = h("button", { class: "tour-skip", type: "button" }, ["Skip"]) as HTMLButtonElement;
    skip.addEventListener("click", stop);

    card.replaceChildren(
      h("div", { class: "tour-card-head" }, [
        h("span", { class: "tour-step-count" }, [`${index + 1} / ${steps.length}`]),
        skip,
      ]),
      h("h3", { class: "tour-card-title" }, [step.title]),
      h("p", { class: "tour-card-body" }, [step.body]),
      h("div", { class: "tour-card-actions" }, [back, next]),
    );

    // Position after the card is in the DOM so we can measure it. A short delay
    // lets a tab switch / scroll settle first.
    requestAnimationFrame(reposition);
    window.setTimeout(reposition, reduced ? 0 : 260);
  }

  // Clicking the dimmed backdrop (but not the card) ends the tour.
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) stop();
  });

  document.body.appendChild(backdrop);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);
  render();

  return stop;
}

/** The demo's default tour script, mapping each step to a stable dashboard hook. */
export const DEMO_TOUR_STEPS: TourStep[] = [
  {
    selector: ".hero-value",
    title: "Your portfolio at a glance",
    body: "The headline value and today's move are the hero of the screen — designed mobile-first, like a modern neobroker.",
    tab: "overview",
  },
  {
    selector: ".hero-fx",
    title: "FX-aware today's move",
    body: "For a euro investor holding dollars, part of today's move comes from the EUR/USD swing. The app splits that out instead of hiding it.",
    tab: "overview",
  },
  {
    selector: ".value-chart",
    title: "Live value over time",
    body: "The curve runs right up to a live tip computed in your browser. Flip the currency toggle and the EUR and USD lines genuinely diverge by the FX move.",
    tab: "overview",
  },
  {
    selector: ".panel-analytics",
    title: "Institutional-grade risk metrics",
    body: "Sharpe, Sortino, max drawdown, VaR, beta/alpha and an equity curve vs. a benchmark — each metric has a plain-language definition on tap.",
    tab: "analytics",
  },
  {
    selector: ".panel-calc2",
    title: "Plan ahead",
    body: "A what-if calculator projects future value from your current mix, contributions and an expected return band — all offline.",
    tab: "plan",
  },
];
