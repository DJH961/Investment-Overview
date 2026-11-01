import clsx from "clsx";
import { Ellipsis, LogOut, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { useState } from "react";
import { NavLink, useLocation } from "react-router";
import { NAV_ITEMS } from "../../lib/nav";
import { usePrefs } from "../../lib/prefs";
import { Sheet } from "../Sheet";
import "./TabBar.scss";

export interface TabBarProps {
  onLogout: () => void;
  onRefresh?: () => void;
}

const TABS = NAV_ITEMS.filter((i) => i.tab);
const MORE = NAV_ITEMS.filter((i) => !i.tab);

export function TabBar({ onLogout, onRefresh }: TabBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const { theme, cycleTheme } = usePrefs();
  const { pathname } = useLocation();
  const moreActive = MORE.some((i) => pathname.startsWith(i.to));
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <>
      <nav className="tab-bar" aria-label="Main tabs">
        {TABS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => clsx("tab-bar__tab", isActive && "tab-bar__tab--active")}
          >
            <item.icon className="tab-bar__icon" aria-hidden />
            <span className="tab-bar__label">{item.label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          className={clsx("tab-bar__tab", moreActive && "tab-bar__tab--active")}
          aria-haspopup="dialog"
          onClick={() => setMoreOpen(true)}
        >
          <Ellipsis className="tab-bar__icon" aria-hidden />
          <span className="tab-bar__label">More</span>
        </button>
      </nav>
      <Sheet open={moreOpen} onOpenChange={setMoreOpen} title="More">
        <ul className="tab-bar__more">
          {MORE.map((item) => (
            <li key={item.to}>
              <NavLink to={item.to} className="tab-bar__more-link" onClick={() => setMoreOpen(false)}>
                <item.icon className="tab-bar__more-icon" aria-hidden />
                {item.label}
              </NavLink>
            </li>
          ))}
          <li className="tab-bar__more-sep" aria-hidden />
          <li>
            <button
              type="button"
              className="tab-bar__more-link"
              disabled={!onRefresh}
              onClick={() => {
                onRefresh?.();
                setMoreOpen(false);
              }}
            >
              <RefreshCw className="tab-bar__more-icon" aria-hidden />
              Refresh data
            </button>
          </li>
          <li>
            <button type="button" className="tab-bar__more-link" onClick={cycleTheme}>
              <ThemeIcon className="tab-bar__more-icon" aria-hidden />
              Theme: {theme}
            </button>
          </li>
          <li>
            <button type="button" className="tab-bar__more-link" onClick={onLogout}>
              <LogOut className="tab-bar__more-icon" aria-hidden />
              Sign out
            </button>
          </li>
        </ul>
      </Sheet>
    </>
  );
}
