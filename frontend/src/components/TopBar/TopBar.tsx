import clsx from "clsx";
import { CircleHelp, HeartPulse, ListChecks, LogOut, Monitor, Moon, RefreshCw, Settings, Sun, TriangleAlert, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { restartSetupGuide } from "../../lib/setupGuide";
import { usePrefs, type ReportingCurrency } from "../../lib/prefs";
import type { ShellSummary } from "../../lib/shell";
import { DeltaBadge } from "../DeltaBadge";
import { Freshness, type FreshnessStatus } from "../Freshness";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { IconButton } from "../IconButton";
import { Menu, type MenuItem } from "../Menu";
import { SegmentedControl } from "../SegmentedControl";
import { LookupSearch } from "../LookupSearch";
import { DESKTOP_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import "./TopBar.scss";

/** What the data-health badge shows (fed by the diagnostics status hook). */
export interface HealthSummary {
  severity: "ok" | "warn" | "error";
  /** Number of checks that are not OK. */
  count: number;
  /** Optional tooltip text, for example "2 warnings: prices stale". */
  label?: string;
}

export interface TopBarProps {
  title: string;
  freshness: { status: FreshnessStatus; label: string; short?: string; updated?: string };
  /** The portfolio's value and day move: the same place on every view (phone: under the title). */
  summary?: ShellSummary;
  /** Show the desktop summary pill (default). Off while the expanded sidebar shows the same figures. */
  showSummary?: boolean;
  /** Phone layout: title + freshness on the left, the essential actions on the right. */
  compact?: boolean;
  /** Server refresh; always available (disabled only while one runs). */
  onRefresh: () => void;
  refreshing?: boolean;
  /**
   * The app is updating by itself (a tick, a scheduled pull): only the refresh icon
   * spins and "Updating…" shows beside it; nothing else on the bar changes.
   */
  quietUpdating?: boolean;
  onLogout: () => void;
  /** Data-health badge. On phone it only shows when something is wrong. */
  health?: HealthSummary;
  /** Slot for the future "hide numbers" eye toggle, shown before the currency switch on every width. */
  privacyToggle?: ReactNode;
  /** Extra content on the left, for example breadcrumbs. */
  leading?: ReactNode;
  /**
   * The market clock slot (v7): a `<Chip size="sm">` such as "Opens 15:30". It sits
   * beside the freshness chip on every width (phones: give it the short form).
   */
  clock?: ReactNode;
}

const CURRENCIES = [
  { value: "EUR", label: "EUR" },
  { value: "USD", label: "USD" },
] as const;

function healthLabel(h: HealthSummary | undefined): string {
  if (!h) return "Health & Repair";
  if (h.label) return h.label;
  if (h.severity === "ok") return "Health & Repair: all checks OK";
  const kind = h.severity === "error" ? "problem" : "warning";
  return `Health & Repair: ${h.count} ${kind}${h.count === 1 ? "" : "s"}`;
}

const EST_TITLE =
  "Estimated: a fund's NAV has not been published yet, so its ETF twin stands in for it. The Overview explains which.";

/** The "≈" that marks every estimated figure in the bar (the label says so for screen readers). */
function EstMark() {
  return (
    <span className="top-bar__est" title={EST_TITLE} aria-hidden>
      ≈
    </span>
  );
}

function summaryLabel(estimated: boolean): string {
  return estimated ? "Portfolio summary, estimated" : "Portfolio summary";
}

function HealthBadge({ health }: { health?: HealthSummary }) {
  const bad = health && health.severity !== "ok";
  const Icon = bad ? TriangleAlert : HeartPulse;
  const label = healthLabel(health);
  return (
    <Link
      to="/diagnostics"
      className={clsx("top-bar__health", health && `top-bar__health--${health.severity}`)}
      aria-label={label}
      title={label}
    >
      <Icon className="top-bar__health-icon" aria-hidden />
      {bad && health.count > 0 && (
        <span className="top-bar__health-count" aria-hidden>
          {health.count > 9 ? "9+" : health.count}
        </span>
      )}
    </Link>
  );
}

export function TopBar({
  title,
  freshness,
  compact = false,
  onRefresh,
  refreshing = false,
  quietUpdating = false,
  onLogout,
  health,
  privacyToggle,
  leading,
  summary,
  showSummary = true,
  clock,
}: TopBarProps) {
  const { currency, setCurrency, theme, cycleTheme } = usePrefs();
  const navigate = useNavigate();
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const showHealth = !compact || (health !== undefined && health.severity !== "ok");
  // Phones use the chip's short form ("Closed", "Open · 15:42"); wider screens stack
  // the state over its detail ("Closed" / "Prices 22:00 (close)"): two clean lines.
  const shortChip = compact && Boolean(freshness.short);
  // The lookup box only fits beside the summary and the actions on desktop; below that it
  // lives in the Holdings page header instead (the tablet top bar must not overflow).
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  const accountItems: MenuItem[] = [
    ...(compact ? [{ label: `Theme: ${theme}`, icon: <ThemeIcon aria-hidden />, onSelect: cycleTheme }] : []),
    { label: "Settings", icon: <Settings aria-hidden />, onSelect: () => navigate("/settings") },
    { label: "Help", icon: <CircleHelp aria-hidden />, onSelect: () => navigate("/help") },
    {
      label: "Restart setup guide",
      icon: <ListChecks aria-hidden />,
      onSelect: () => {
        restartSetupGuide();
        navigate("/overview");
      },
    },
    { label: "Sign out", icon: <LogOut aria-hidden />, onSelect: onLogout, danger: true, separatorBefore: true },
  ];

  return (
    <header className={clsx("top-bar", compact && "top-bar--compact")}>
      {leading}
      <div className="top-bar__title-block">
        <div className="top-bar__title-line">
          <p className="top-bar__title" data-truncate-ok>{title}</p>
          {compact && summary && (
            <span className="top-bar__mini" aria-label={summaryLabel(summary.estimated)}>
              {summary.estimated && <EstMark />}
              <Money amount={summary.value} currency={summary.currency} compact className="top-bar__mini-value" />
              <Percent ratio={summary.pct} signed colored className="top-bar__mini-pct" />
            </span>
          )}
        </div>
        {(freshness.label || clock) && (
          <div className="top-bar__status">
            {freshness.label && (
              <Freshness
                className="top-bar__freshness"
                status={freshness.status}
                label={shortChip ? freshness.short! : freshness.label}
                title={shortChip ? freshness.label : freshness.updated}
                // Phone: ONE status line ("● Live · Today 21:57"), never stacked: the bar
                // stays at three lines at most (title, figures, status), clock included.
                stacked={!compact}
              />
            )}
            {clock && <span className="top-bar__clock">{clock}</span>}
          </div>
        )}
        {!compact && freshness.updated && (
          <span className="top-bar__updated" title="When the app last fetched prices">
            <RefreshCw aria-hidden className="top-bar__updated-icon" />
            {freshness.updated}
          </span>
        )}
      </div>
      {!compact && showSummary && (
        // Always rendered (a placeholder until the figures load), so the bar's
        // items never shift between views.
        <div
          className="top-bar__summary"
          aria-label={summaryLabel(summary?.estimated ?? false)}
          aria-busy={!summary || undefined}
        >
          {summary ? (
            <>
              <span className="top-bar__summary-value">
                {summary.estimated && <EstMark />}
                <Money amount={summary.value} currency={summary.currency} className="top-bar__summary-full" />
                <Money amount={summary.value} currency={summary.currency} compact className="top-bar__summary-short" />
              </span>
              <DeltaBadge value={summary.pct} />
              <span className="top-bar__summary-move">
                <Money amount={summary.move} currency={summary.currency} signed colored />
              </span>
              <span className="top-bar__summary-day">{summary.dayLabel}</span>
            </>
          ) : (
            <span className="top-bar__summary-day">Portfolio…</span>
          )}
        </div>
      )}
      {/* Desktop: look up any instrument (phone: in the Holdings page header). */}
      {!compact && isDesktop && <LookupSearch className="top-bar__lookup" />}
      <div className="top-bar__actions">
        {/* First, so it is the quickest action to reach. */}
        <span className="top-bar__refresh">
          {quietUpdating && !refreshing && (
            <output className="top-bar__quiet">Updating…</output>
          )}
          <IconButton
            label="Refresh data"
            icon={<RefreshCw aria-hidden className={clsx((refreshing || quietUpdating) && "top-bar__spin")} />}
            onClick={onRefresh}
            disabled={refreshing}
            aria-busy={refreshing || quietUpdating || undefined}
          />
        </span>
        {showHealth && <HealthBadge health={health} />}
        {privacyToggle}
        {compact ? (
          // Phone: one tap swaps the currency (half the width of the two-option switch,
          // which leaves the title, the portfolio figures and the price time room to show in full).
          <span className="top-bar__ccy">
            <button
              type="button"
              className="top-bar__ccy-button"
              aria-label={`Showing ${currency}, switch to ${currency === "EUR" ? "USD" : "EUR"}`}
              onClick={() => setCurrency(currency === "EUR" ? "USD" : "EUR")}
            >
              {currency}
            </button>
          </span>
        ) : (
          <SegmentedControl<ReportingCurrency>
            ariaLabel="Reporting currency"
            size="sm"
            options={[...CURRENCIES]}
            value={currency}
            onChange={setCurrency}
          />
        )}
        {!compact && <IconButton label={`Theme: ${theme}`} icon={<ThemeIcon aria-hidden />} onClick={cycleTheme} />}
        <Menu
          heading={compact ? "Account" : undefined}
          trigger={<IconButton label="Account and sign out" icon={<UserRound aria-hidden />} />}
          items={accountItems}
        />
        {/* Desktop: Sign out is the right-most action (owner, 7.0.1). */}
        {!compact && <IconButton label="Sign out" icon={<LogOut aria-hidden />} onClick={onLogout} />}
      </div>
    </header>
  );
}
