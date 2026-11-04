import { Suspense, useEffect, type ComponentType, type ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import { AppShell } from "./components/AppShell";
import { Tour } from "./components/Tour";
import { setUnauthorizedHandler } from "./lib/api";
import { Skeleton } from "./components/Skeleton";
import { FormatBoundary } from "./lib/displayPrefs";
import { Pages, preloadPages, type PageName } from "./lib/routeChunks";
import { Login, RequireAuth } from "./pages/Login";
import { Overview } from "./pages/Overview";

/** Skeleton shown while a page chunk downloads (the shell around it stays put). */
function PageFallback() {
  return (
    <div aria-busy="true">
      <Skeleton height="2rem" width="40%" />
      <Skeleton height="12rem" />
    </div>
  );
}

function lazyPage(name: PageName): ReactNode {
  const Page = Pages[name] as ComponentType;
  return (
    <Suspense fallback={<PageFallback />}>
      <Page />
    </Suspense>
  );
}

export function App() {
  const navigate = useNavigate();
  useEffect(() => {
    setUnauthorizedHandler(() => navigate("/login"));
  }, [navigate]);
  // After first render, fetch the other pages' code while the browser is idle.
  useEffect(() => preloadPages(), []);

  return (
    <>
      <Tour />
      <FormatBoundary>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<Overview />} />
        <Route path="/holdings" element={lazyPage("Holdings")} />
        <Route path="/periods" element={lazyPage("Periods")} />
        <Route path="/activity" element={lazyPage("Activity")} />
        <Route path="/risk" element={lazyPage("Risk")} />
        <Route path="/projection" element={lazyPage("Projection")} />
        <Route path="/transactions" element={lazyPage("Transactions")} />
        <Route path="/import" element={lazyPage("Import")} />
        <Route path="/instruments" element={lazyPage("Instruments")} />
        <Route path="/conversions" element={lazyPage("CurrencyConversions")} />
        <Route path="/allocations" element={lazyPage("Allocations")} />
        <Route path="/diagnostics" element={lazyPage("Diagnostics")} />
        <Route path="/settings" element={lazyPage("Settings")} />
        <Route path="/help" element={lazyPage("Help")} />
        <Route path="/onboarding" element={lazyPage("Onboarding")} />
        <Route path="/_styleguide" element={lazyPage("Styleguide")} />
        <Route path="*" element={lazyPage("NotFound")} />
      </Route>
      </Route>
    </Routes>
      </FormatBoundary>
    </>
  );
}
