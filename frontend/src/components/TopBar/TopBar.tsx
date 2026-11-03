import clsx from "clsx";
import { CircleHelp, HeartPulse, LogOut, Monitor, Moon, RefreshCw, Settings, Sun, TriangleAlert, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { usePrefs, type ReportingCurrency } from "../../lib/prefs";
import { Freshness, type FreshnessStatus } from "../Freshness";
import { IconButton } from "../IconButton";
import { Menu, type MenuItem } from "../Menu";
import { SegmentedControl } from "../SegmentedControl";
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
  freshness: { status: FreshnessStatus; label: string };
  /** Phone layout: title + freshness on the left, the essential actions on the right. */
  compact?: boolean;
  /** Server refresh; always available (disabled only while one runs). */
  onRefresh: () => void;
  refreshing?: boolean;
  onLogout: () => void;
  /** Data-health badge. On phone it only shows when something is wrong. */
  health?: HealthSummary;
  /** Slot for the future "hide numbers" eye toggle, shown before the currency switch on every width. */
  privacyToggle?: ReactNode;
  /** Extra content on the left, for example breadcrumbs. */
  leading?: ReactNode;
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
  onLogout,
  health,
  privacyToggle,
  leading,
}: TopBarProps) {
  const { currency, setCurrency, theme, cycleTheme } = usePrefs();
  const navigate = useNavigate();
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const showHealth = !compact || (health !== undefined && health.severity !== "ok");

  const accountItems: MenuItem[] = [
    ...(compact ? [{ label: `Theme: ${theme}`, icon: <ThemeIcon aria-hidden />, onSelect: cycleTheme }] : []),
    { label: "Settings", icon: <Settings aria-hidden />, onSelect: () => navigate("/settings") },
    { label: "Help", icon: <CircleHelp aria-hidden />, onSelect: () => navigate("/help") },
    { label: "Sign out", icon: <LogOut aria-hidden />, onSelect: onLogout, danger: true, separatorBefore: true },
  ];

  return (
    <header className={clsx("top-bar", compact && "top-bar--compact")}>
      {leading}
      <div className="top-bar__title-block">
        <p className="top-bar__title">{title}</p>
        {freshness.label && <Freshness className="top-bar__freshness" status={freshness.status} label={freshness.label} />}
      </div>
      <div className="top-bar__actions">
        {showHealth && <HealthBadge health={health} />}
        {privacyToggle}
        <SegmentedControl<ReportingCurrency>
          ariaLabel="Reporting currency"
          size="sm"
          options={[...CURRENCIES]}
          value={currency}
          onChange={setCurrency}
        />
        <IconButton
          label="Refresh data"
          icon={<RefreshCw aria-hidden className={clsx(refreshing && "top-bar__spin")} />}
          onClick={onRefresh}
          disabled={refreshing}
          aria-busy={refreshing || undefined}
        />
        {!compact && <IconButton label={`Theme: ${theme}`} icon={<ThemeIcon aria-hidden />} onClick={cycleTheme} />}
        <Menu
          heading={compact ? "Account" : undefined}
          trigger={<IconButton label="Account and sign out" icon={<UserRound aria-hidden />} />}
          items={accountItems}
        />
      </div>
    </header>
  );
}
