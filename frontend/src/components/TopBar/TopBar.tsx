import clsx from "clsx";
import { LogOut, Monitor, Moon, RefreshCw, Sun, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { usePrefs, type ReportingCurrency } from "../../lib/prefs";
import { Freshness, type FreshnessStatus } from "../Freshness";
import { IconButton } from "../IconButton";
import { Menu } from "../Menu";
import { SegmentedControl } from "../SegmentedControl";
import "./TopBar.scss";

export interface TopBarProps {
  title: string;
  freshness: { status: FreshnessStatus; label: string };
  /** Phone: title, freshness and currency only. */
  compact?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  onLogout: () => void;
  /** Extra content on the left, for example breadcrumbs. */
  leading?: ReactNode;
}

const CURRENCIES = [
  { value: "EUR", label: "EUR" },
  { value: "USD", label: "USD" },
] as const;

export function TopBar({ title, freshness, compact = false, onRefresh, refreshing = false, onLogout, leading }: TopBarProps) {
  const { currency, setCurrency, theme, cycleTheme } = usePrefs();
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <header className={clsx("top-bar", compact && "top-bar--compact")}>
      {leading}
      <div className="top-bar__title-block">
        <p className="top-bar__title">{title}</p>
        <Freshness status={freshness.status} label={freshness.label} />
      </div>
      <div className="top-bar__actions">
        <SegmentedControl<ReportingCurrency>
          ariaLabel="Reporting currency"
          size="sm"
          options={[...CURRENCIES]}
          value={currency}
          onChange={setCurrency}
        />
        {!compact && (
          <>
            <IconButton
              label="Refresh data"
              icon={<RefreshCw aria-hidden className={clsx(refreshing && "top-bar__spin")} />}
              onClick={onRefresh}
              disabled={!onRefresh || refreshing}
            />
            <IconButton label={`Theme: ${theme}`} icon={<ThemeIcon aria-hidden />} onClick={cycleTheme} />
            <Menu
              trigger={<IconButton label="User menu" icon={<UserRound aria-hidden />} />}
              items={[{ label: "Sign out", icon: <LogOut aria-hidden />, onSelect: onLogout }]}
            />
          </>
        )}
      </div>
    </header>
  );
}
