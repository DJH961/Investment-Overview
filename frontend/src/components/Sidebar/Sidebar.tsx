import clsx from "clsx";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { NavLink } from "react-router";
import { BRAND_ICON, NAV_GROUPS, NAV_ITEMS } from "../../lib/nav";
import { IconButton } from "../IconButton";
import "./Sidebar.scss";

export interface SidebarProps {
  /** Icon-only rail (forced on tablet, user-toggled on desktop). */
  collapsed: boolean;
  /** Provide to show the collapse toggle (desktop only). */
  onToggle?: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const Brand = BRAND_ICON;
  return (
    <aside className={clsx("sidebar", collapsed && "sidebar--rail")}>
      <div className="sidebar__brand">
        <span className="sidebar__logo">
          <Brand aria-hidden />
        </span>
        <span className="sidebar__brand-text">Investment Overview</span>
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
      {onToggle && (
        <div className="sidebar__footer">
          <IconButton
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            icon={collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
            onClick={onToggle}
          />
        </div>
      )}
    </aside>
  );
}
