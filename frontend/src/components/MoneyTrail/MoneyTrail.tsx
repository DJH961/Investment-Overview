import clsx from "clsx";
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpFromLine,
  BadgeDollarSign,
  ChartLine,
  ChevronRight,
  Euro,
  Hourglass,
  Landmark,
  ShoppingCart,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";
import { formatDateThisYear } from "../../lib/format";
import type { StepKey, TrailOut, TrailStep } from "../../lib/journey-types";
import { Money } from "../Money";
import "./MoneyTrail.scss";

/** Every step has its own icon (and its own label): never colour alone. */
export const STEP_ICON: Record<StepKey, LucideIcon> = {
  sent: Euro,
  converted: ArrowRightLeft,
  waited: Hourglass,
  deposited: Landmark,
  bought: ShoppingCart,
  sold: BadgeDollarSign,
  withdrawn: ArrowUpFromLine,
  back: Undo2,
  worth_now: ChartLine,
};

/** "12 Sep" this year, "12 Sep 2025" before: the detail line stays short. */
export const trailDate = (iso: string) => formatDateThisYear(iso);

/** One trail: figures in a story are written alike, so a trail with a big figure drops the cents everywhere. */
function digitsFor(steps: readonly TrailStep[]): number {
  return steps.some((s) => s.figure_ccy && Math.abs(Number(s.figure)) >= 10_000) ? 0 : 2;
}

function Figure({ step, digits }: { step: TrailStep; digits: number }) {
  if (!step.figure_ccy) return <>{step.figure}</>;
  return <Money amount={Number(step.figure)} currency={step.figure_ccy} digits={digits} />;
}

/** The detail line: a signed change when the step has one (with an arrow), else date · detail. */
function Detail({ step, digits }: { step: TrailStep; digits: number }) {
  const change = step.change === null || step.change === undefined ? null : Number(step.change);
  if (change !== null && step.figure_ccy) {
    const Dir = change >= 0 ? ArrowUp : ArrowDown;
    return (
      <span className={clsx("money-trail__change", change >= 0 ? "money-trail__change--pos" : "money-trail__change--neg")}>
        <Dir aria-hidden className="money-trail__change-icon" />
        <Money amount={change} currency={step.figure_ccy} signed digits={digits} />
        <span className="u-sr-only">{change >= 0 ? " gain" : " loss"}</span>
      </span>
    );
  }
  const text = [step.date ? trailDate(step.date) : null, step.detail].filter(Boolean).join(" · ");
  return <>{text || " "}</>;
}

export interface MoneyTrailProps {
  steps: readonly TrailStep[];
  /** Accessible name ("Where these dollars came from"). */
  label: string;
  /** `full`: four aligned rows per step. `compact`: one line of icon + figure, for rows and chips. */
  variant?: "full" | "compact";
  className?: string;
}

/**
 * The money trail (7.4): € sent → $ received → deposited → bought → worth now (→ back in €).
 * Each step has four rows (icon, label, bold figure, detail) that line up across the steps
 * (a subgrid), so the bold figures sit on one line. It runs across when its box is wide
 * enough for its steps, and down as a list when not (phones, sheets), by container width.
 */
export function MoneyTrail({ steps, label, variant = "full", className }: MoneyTrailProps) {
  const digits = digitsFor(steps);
  if (variant === "compact") return <CompactTrail steps={steps} label={label} digits={digits} className={className} />;
  return (
    <div className={clsx("money-trail", className)}>
      <ol className={clsx("money-trail__steps", `money-trail__steps--n${Math.min(Math.max(steps.length, 2), 8)}`)} aria-label={label}>
        {steps.map((s, i) => {
          const Icon = STEP_ICON[s.key] ?? ChevronRight;
          const last = i === steps.length - 1;
          return (
            <li key={`${s.key}-${i}`} className={clsx("money-trail__step", `money-trail__step--${s.key}`, last && "money-trail__step--last")}>
              <span className="money-trail__mark" aria-hidden>
                <span className="money-trail__icon">
                  <Icon className="money-trail__glyph" />
                </span>
                {!last && <span className="money-trail__line" />}
              </span>
              <span className="money-trail__label">
                {s.link ? (
                  <Link to={s.link} className="money-trail__link">
                    {s.label}
                  </Link>
                ) : (
                  s.label
                )}
              </span>
              <span className="money-trail__figure">
                <Figure step={s} digits={digits} />
              </span>
              <span className="money-trail__detail">
                <Detail step={s} digits={digits} />
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** One line: the first step, then the last two, with the hidden middle counted. */
function CompactTrail({ steps, label, digits, className }: { steps: readonly TrailStep[]; label: string; digits: number; className?: string }) {
  const shown = steps.length <= 4 ? steps.map((s, i) => ({ s, i })) : [0, steps.length - 2, steps.length - 1].map((i) => ({ s: steps[i]!, i }));
  const hidden = steps.length - shown.length;
  return (
    <span className={clsx("money-trail-compact", className)} role="img" aria-label={`${label}: ${steps.map((s) => s.label).join(", then ")}`}>
      {shown.map(({ s, i }, k) => {
        const Icon = STEP_ICON[s.key] ?? ChevronRight;
        return (
          <span key={`${s.key}-${i}`} className="money-trail-compact__part" aria-hidden>
            {k > 0 && (
              <>
                <ChevronRight className="money-trail-compact__sep" />
                {k === 1 && hidden > 0 && (
                  <>
                    <span className="money-trail-compact__more">+{hidden}</span>
                    <ChevronRight className="money-trail-compact__sep" />
                  </>
                )}
              </>
            )}
            <Icon className="money-trail-compact__icon" />
            <span className="money-trail-compact__figure">
              <Figure step={s} digits={digits} />
            </span>
          </span>
        );
      })}
    </span>
  );
}

export interface TrailViewProps {
  trail: TrailOut;
  label: string;
  className?: string;
}

/** A trail answer: one trail per path (usually one), with the dollars' share when it drew on several. */
export function TrailView({ trail, label, className }: TrailViewProps) {
  const paths = trail.paths.slice(0, 3);
  const several = paths.length > 1;
  return (
    <div className={clsx("trail-view", className)}>
      {paths.map((p, i) => (
        <section key={i} className="trail-view__path" aria-label={several ? `${label}, part ${i + 1}` : label}>
          {several && (
            <p className="trail-view__share">
              {Math.round(Number(p.usd_share) * 100)}% of the dollars
            </p>
          )}
          <MoneyTrail steps={p.steps} label={label} />
        </section>
      ))}
      {trail.more_paths > 0 && <p className="trail-view__more">and {trail.more_paths} more {trail.more_paths === 1 ? "part" : "parts"}, from older deposits</p>}
    </div>
  );
}
