import clsx from "clsx";
import { Ellipsis } from "lucide-react";
import { useState } from "react";
import { NavLink, useLocation } from "react-router";
import { TAB_ITEMS, moreSections } from "../../lib/nav";
import { Sheet } from "../Sheet";
import "./TabBar.scss";

const SECTIONS = moreSections();
const MORE = SECTIONS.flatMap((s) => s.items);

/**
 * Phone bottom navigation: four tabs plus a More sheet with the remaining pages
 * as a grouped two-column grid. Refresh, theme and sign out live in the top bar.
 */
export function TabBar() {
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();
  const moreActive = MORE.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));

  return (
    <>
      <nav className="tab-bar" aria-label="Main tabs">
        {TAB_ITEMS.map((item) => (
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
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          <Ellipsis className="tab-bar__icon" aria-hidden />
          <span className="tab-bar__label">More</span>
        </button>
      </nav>
      <Sheet open={moreOpen} onOpenChange={setMoreOpen} title="More">
        {SECTIONS.map((section) => (
          <section key={section.group} className="tab-bar__section" aria-labelledby={`more-${section.group}`}>
            <h3 id={`more-${section.group}`} className="tab-bar__section-title">
              {section.group}
            </h3>
            <ul className="tab-bar__grid">
              {section.items.map((item) => (
                <li key={item.to} className="tab-bar__cell">
                  <NavLink
                    to={item.to}
                    className={({ isActive }) => clsx("tab-bar__tile", isActive && "tab-bar__tile--active")}
                    onClick={() => setMoreOpen(false)}
                  >
                    <item.icon className="tab-bar__tile-icon" aria-hidden />
                    <span className="tab-bar__tile-label">{item.label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </Sheet>
    </>
  );
}
