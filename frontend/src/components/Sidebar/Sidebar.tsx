import clsx from "clsx";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Link, NavLink } from "react-router";
import { APP_VERSION } from "../../lib/appVersion";
import { NAV_GROUPS, NAV_ITEMS, type NavGroup } from "../../lib/nav";
import type { ShellSummary } from "../../lib/shell";
import { BrandMark } from "../BrandMark";
import { DeltaBadge } from "../DeltaBadge";
import { IconButton } from "../IconButton";
import { Money } from "../Money";
import "./Sidebar.scss";

export interface SidebarProps {
  /** Icon-only rail (forced on tablet, user-toggled on desktop). */
  collapsed: boolean;
  /** Provide to show the collapse toggle (desktop only). */
  onToggle?: () => void;
  /**
   * The portfolio's value and day move (server figures, shared with the top bar).
   * Shown as the sidebar's "pocket" card when expanded; the top bar carries it otherwise.
   */
  summary?: ShellSummary;
}

/** The groups in the main list; System sits at the foot of the spine. */
const MAIN_GROUPS = NAV_GROUPS.filter((g) => g !== "System");

function NavList({ group, collapsed, compact = false }: { group: NavGroup; collapsed: boolean; compact?: boolean }) {
  return (
    <ul className={clsx("sidebar__list", compact && "sidebar__list--compact")}>
      {NAV_ITEMS.filter((i) => i.group === group).map((item) => (
        <li key={item.to}>
          <NavLink
            to={item.to}
            title={collapsed ? item.label : undefined}
            aria-label={collapsed ? item.label : undefined}
            className={({ isActive }) => clsx("sidebar__link", isActive && "sidebar__link--active")}
          >
            <item.icon className="sidebar__icon" aria-hidden />
            <span className="sidebar__label">{item.label}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

/** The portfolio at a glance, at the head of the spine: a link back to the Overview. */
function Pocket({ summary }: { summary?: ShellSummary }) {
  const label = summary?.estimated ? "Portfolio summary, estimated" : "Portfolio summary";
  return (
    <Link to="/overview" className="sidebar__pocket" aria-label={label} aria-busy={!summary || undefined}>
      <span className="sidebar__pocket-label">
        Portfolio{summary?.estimated && <span className="sidebar__pocket-est" title="Estimated: an ETF twin stands in for a fund whose NAV is not out yet"> ≈ estimate</span>}
      </span>
      <span className="sidebar__pocket-value">
        {summary ? <Money amount={summary.value} currency={summary.currency} /> : "…"}
      </span>
      {summary && (
        <span className="sidebar__pocket-move">
          <DeltaBadge value={summary.pct} />
          <Money amount={summary.move} currency={summary.currency} signed colored className="sidebar__pocket-money" />
          <span className="sidebar__pocket-day">{summary.dayLabel}</span>
        </span>
      )}
    </Link>
  );
}

/**
 * The navigation spine: light in the light theme, deep ink in the dark (`.u-ink`), grouped by what the owner
 * is doing (Portfolio, Dig in, Manage), the System pages at its foot, and the
 * portfolio at a glance at its head. Collapses to an icon rail (tablet, or by choice).
 * Sized to fit without a scroll bar; short windows get denser rows (Sidebar.scss).
 */
export function Sidebar({ collapsed, onToggle, summary }: SidebarProps) {
  const toggle = onToggle && (
    <IconButton
      className="sidebar__toggle"
      size={collapsed ? "md" : "sm"}
      label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      icon={collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
      onClick={onToggle}
    />
  );
  return (
    <aside className={clsx("sidebar", "u-ink", collapsed && "sidebar--rail")}>
      <div className="sidebar__brand">
        <BrandMark className="sidebar__logo" size={32} />
        <span className="sidebar__brand-text">
          <span className="sidebar__brand-line">Investment</span>{" "}
          <span className="sidebar__brand-line">Overview</span>
        </span>
        {!collapsed && toggle}
      </div>
      {!collapsed && <Pocket summary={summary} />}
      <nav className="sidebar__nav" aria-label="Primary">
        {MAIN_GROUPS.map((group) => (
          <div className="sidebar__group" key={group}>
            <p className="sidebar__group-title">{group}</p>
            <NavList group={group} collapsed={collapsed} />
          </div>
        ))}
      </nav>
      <nav className="sidebar__foot" aria-label="System">
        <NavList group="System" collapsed={collapsed} compact />
        {APP_VERSION && <p className="sidebar__meta">Investment Overview {APP_VERSION}</p>}
        {collapsed && toggle && <div className="sidebar__footer">{toggle}</div>}
      </nav>
    </aside>
  );
}
