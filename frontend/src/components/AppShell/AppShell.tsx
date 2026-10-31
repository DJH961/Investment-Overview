import clsx from "clsx";
import { useCallback, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { api } from "../../lib/api";
import { NAV_ITEMS, titleFor } from "../../lib/nav";
import { useShell } from "../../lib/shell";
import { useShortcuts } from "../../lib/useShortcuts";
import { useIsDesktop, useIsPhone } from "../../lib/useMediaQuery";
import { Dialog } from "../Dialog";
import { Sidebar } from "../Sidebar";
import { TabBar } from "../TabBar";
import { TopBar } from "../TopBar";
import "./AppShell.scss";

const RAIL_KEY = "iv.sidebar.rail";

function readRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === "1";
  } catch {
    return false;
  }
}

/** Responsive frame: sidebar (desktop) / rail (tablet) / bottom tab bar (phone). */
export function AppShell() {
  const phone = useIsPhone();
  const desktop = useIsDesktop();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { freshness, onRefresh, refreshing } = useShell();
  const [userRail, setUserRail] = useState(readRail);
  const [helpOpen, setHelpOpen] = useState(false);
  const openHelp = useCallback(() => setHelpOpen(true), []);

  useShortcuts(openHelp, !phone);

  const toggleRail = () => {
    setUserRail((prev) => {
      try {
        localStorage.setItem(RAIL_KEY, prev ? "0" : "1");
      } catch {
        /* not persisted */
      }
      return !prev;
    });
  };

  const logout = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST", skipAuthRedirect: true });
    } finally {
      navigate("/login");
    }
  }, [navigate]);

  const rail = !phone && (!desktop || userRail);

  return (
    <div className={clsx("app-shell", phone && "app-shell--phone", rail && "app-shell--rail")}>
      {!phone && <Sidebar collapsed={rail} onToggle={desktop ? toggleRail : undefined} />}
      <div className="app-shell__main">
        <TopBar
          title={titleFor(pathname)}
          freshness={freshness}
          compact={phone}
          onRefresh={onRefresh}
          refreshing={refreshing}
          onLogout={logout}
        />
        <main className="app-shell__content" id="main">
          <Outlet />
        </main>
      </div>
      {phone && <TabBar onLogout={logout} onRefresh={onRefresh} />}
      <Dialog open={helpOpen} onOpenChange={setHelpOpen} title="Keyboard shortcuts" description="Press g, then a letter.">
        <ul className="app-shell__shortcuts">
          {NAV_ITEMS.filter((i) => i.shortcut).map((i) => (
            <li key={i.to} className="app-shell__shortcut">
              <span>{i.label}</span>
              <kbd className="app-shell__kbd">g {i.shortcut}</kbd>
            </li>
          ))}
          <li className="app-shell__shortcut">
            <span>Search</span>
            <kbd className="app-shell__kbd">/</kbd>
          </li>
          <li className="app-shell__shortcut">
            <span>This help</span>
            <kbd className="app-shell__kbd">?</kbd>
          </li>
        </ul>
      </Dialog>
    </div>
  );
}
