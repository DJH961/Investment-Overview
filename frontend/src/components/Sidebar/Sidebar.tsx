import clsx from "clsx";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { NavLink } from "react-router";
import { APP_VERSION } from "../../lib/appVersion";
import { NAV_GROUPS, NAV_ITEMS } from "../../lib/nav";
import { BrandMark } from "../BrandMark";
import { IconButton } from "../IconButton";
import "./Sidebar.scss";

export interface SidebarProps {
  /** Icon-only rail (forced on tablet, user-toggled on desktop). */
  collapsed: boolean;
  /** Provide to show the collapse toggle (desktop only). */
  onToggle?: () => void;
}

/**
 * Desktop sidebar / tablet rail. Sized to fit without a scroll bar: the
 * collapse toggle sits in the brand row, and on short screens the rows get
 * denser and the group titles turn into thin dividers (see Sidebar.scss).
 */
export function Sidebar({ collapsed, onToggle }: SidebarProps) {
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
    <aside className={clsx("sidebar", collapsed && "sidebar--rail")}>
      <div className="sidebar__brand">
        <BrandMark className="sidebar__logo" size={32} />
        <span className="sidebar__brand-text">Investment Overview</span>
        {!collapsed && toggle}
      </div>
      <nav className="sidebar__nav" aria-label="Primary">
        {NAV_GROUPS.map((group) => (
          <div className="sidebar__group" key={group}>
            <p className="sidebar__group-title">{group}</p>
            <ul className="sidebar__list">
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
          </div>
        ))}
      </nav>
      {APP_VERSION && <p className="sidebar__meta">Investment Overview {APP_VERSION}</p>}
      {collapsed && toggle && <div className="sidebar__footer">{toggle}</div>}
    </aside>
  );
}
