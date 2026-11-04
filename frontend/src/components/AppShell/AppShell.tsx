/* The refresh bar is a styled div (native <progress> cannot animate the indeterminate stripe). */
/* oxlint-disable jsx-a11y/prefer-tag-over-role */
import clsx from "clsx";
import { Eye, EyeOff, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useHideAmounts } from "../../lib/hideAmounts";
import { getConnectivity } from "../../lib/network";
import { reauthLoginPath, setReauthHandler } from "../../lib/api";
import { logout as signOut } from "../../lib/auth";
import { NAV_ITEMS, titleFor } from "../../lib/nav";
import { prefetchKeyData } from "../../lib/prefetch";
import { usePrefs } from "../../lib/prefs";
import { useServerRefresh } from "../../lib/refresh";
import { useShell } from "../../lib/shell";
import { PULL_THRESHOLD, usePullToRefresh } from "../../lib/usePullToRefresh";
import { useShortcuts } from "../../lib/useShortcuts";
import { useIsDesktop, useIsPhone, useMediaQuery } from "../../lib/useMediaQuery";
import { IconButton } from "../IconButton";
import { Dialog } from "../Dialog";
import { OfflineBanner } from "../OfflineBanner";
import { useToast } from "../Toast";
import { updatingView } from "../Freshness";
import { Sidebar } from "../Sidebar";
import { TabBar } from "../TabBar";
import { TopBar } from "../TopBar";
import "./AppShell.scss";
import { useShellHealth } from "./useShellHealth";

const RAIL_KEY = "iv.sidebar.rail";

function readRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === "1";
  } catch {
    return false;
  }
}

/** Phone pull-to-refresh: its own component so finger moves only re-render the indicator. */
function PullToRefresh({ enabled, onRefresh }: { enabled: boolean; onRefresh: () => void }) {
  const { offset, armed } = usePullToRefresh({ enabled, onRefresh });
  const still = useMediaQuery("(prefers-reduced-motion: reduce)");
  if (offset <= 0) return null;
  return (
    <div
      className={clsx("app-shell__pull", armed && "app-shell__pull--armed")}
      style={{ transform: `translate(-50%, ${offset}px)` }}
      aria-hidden
    >
      <RefreshCw
        className="app-shell__pull-icon"
        style={still ? undefined : { transform: `rotate(${Math.round((offset / PULL_THRESHOLD) * 270)}deg)` }}
      />
    </div>
  );
}

/** Responsive frame: sidebar (desktop) / rail (tablet) / bottom tab bar (phone). */
/** Wait this long after the shell mounts, so the open page's own requests go first. */
const PREFETCH_DELAY_MS = 1200;

export function AppShell() {
  const queryClient = useQueryClient();
  const { currency } = usePrefs();
  // Warm every nav page (both currencies) in idle time; the server-restart banner lives in <OfflineBanner />.
  useEffect(() => {
    const ctl = new AbortController();
    const timer = setTimeout(() => void prefetchKeyData(queryClient, currency, ctl.signal), PREFETCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [queryClient, currency]);
  const phone = useIsPhone();
  const desktop = useIsDesktop();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { freshness: pageFreshness, refreshing: pageRefreshing, summary } = useShell();
  // The top-bar refresh is always a real server pull (prices, FX, intraday sample).
  const server = useServerRefresh();
  const refresh = server.state;
  const freshness = refresh.running ? updatingView(refresh) : pageFreshness;
  const { toast } = useToast();
  // Always enabled, on every page: it never depends on a page registering a handler.
  // Offline, say so instead of spinning (the cached data stays on screen).
  const startRefresh = server.start;
  const onRefresh = useCallback(() => {
    if (getConnectivity() === "offline") {
      toast({ title: "You're offline", description: "Prices refresh once the connection is back." });
      return;
    }
    startRefresh();
  }, [startRefresh, toast]);
  const health = useShellHealth();
  const { hide, toggle: toggleHide } = useHideAmounts();
  const refreshing = refresh.running || pageRefreshing;
  const determinate = refresh.historical && refresh.total > 0;
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
      await signOut();
    } finally {
      navigate("/login");
    }
  }, [navigate]);

  // A sensitive action on an old session: sign in again, then come back here.
  useEffect(() => {
    setReauthHandler(() => navigate(reauthLoginPath(window.location.pathname + window.location.search)));
  }, [navigate]);

  const rail = !phone && (!desktop || userRail);

  return (
    <div className={clsx("app-shell", phone && "app-shell--phone", rail && "app-shell--rail")}>
      {!phone && <Sidebar collapsed={rail} onToggle={desktop ? toggleRail : undefined} />}
      <div className="app-shell__main">
        {refresh.running && (
          <div
            className={clsx("app-shell__progress", !determinate && "app-shell__progress--indeterminate")}
            role="progressbar"
            aria-label={refresh.label ?? "Refreshing prices"}
            aria-valuemin={determinate ? 0 : undefined}
            aria-valuemax={determinate ? refresh.total : undefined}
            aria-valuenow={determinate ? refresh.done : undefined}
          >
            <span
              className="app-shell__progress-bar"
              style={determinate ? { width: `${Math.min(100, (refresh.done / refresh.total) * 100)}%` } : undefined}
            />
          </div>
        )}
        <TopBar
          title={titleFor(pathname)}
          freshness={freshness}
          compact={phone}
          onRefresh={onRefresh}
          refreshing={refreshing}
          onLogout={logout}
          health={health}
          summary={summary}
          privacyToggle={
            <IconButton
              label={hide ? "Show numbers" : "Hide numbers"}
              icon={hide ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              active={hide}
              aria-pressed={hide}
              onClick={toggleHide}
            />
          }
        />
        <OfflineBanner />
        <main className="app-shell__content" id="main" key={hide ? "hidden" : "shown"}>
          <Outlet />
        </main>
      </div>
      {phone && <TabBar />}
      {phone && <PullToRefresh enabled={!refresh.running} onRefresh={onRefresh} />}
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
