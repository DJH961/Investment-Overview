import { Suspense, lazy, useEffect, type ComponentType, type ReactElement } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import { AppShell } from "./components/AppShell";
import { Tour } from "./components/Tour";
import { setUnauthorizedHandler } from "./lib/api";
import { Skeleton } from "./components/Skeleton";
import { FormatBoundary } from "./lib/displayPrefs";
import { RerenderOnHide } from "./lib/RerenderOnHide";
import { Pages, preloadPages, type PageName } from "./lib/routeChunks";
import { RequireAuth } from "./pages/Login/RequireAuth";
import { Overview } from "./pages/Overview";

// Login (and the WebAuthn library it pulls in) stays out of the main bundle.
const Login = lazy(() => import("./pages/Login/Login").then((m) => ({ default: m.Login })));

/** Skeleton shown while a page chunk downloads (the shell around it stays put). */
function PageFallback() {
  return (
    <div aria-busy="true">
      <Skeleton height="2rem" width="40%" />
      <Skeleton height="12rem" />
    </div>
  );
}

/** A page re-renders (not remounts) when "Hide numbers" flips, so edits and scroll survive. */
function withHide(page: ReactElement): ReactElement {
  return <RerenderOnHide>{page}</RerenderOnHide>;
}

function lazyPage(name: PageName): ReactElement {
  const Page = Pages[name] as ComponentType;
  return (
    <Suspense fallback={<PageFallback />}>
      {withHide(<Page />)}
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
          <Route
            path="/login"
            element={
              <Suspense fallback={<PageFallback />}>
                <Login />
              </Suspense>
            }
          />
          <Route element={<RequireAuth />}>
            <Route element={<AppShell />}>
              <Route index element={<Navigate to="/overview" replace />} />
              <Route path="/overview" element={withHide(<Overview />)} />
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
              {import.meta.env.DEV && <Route path="/_styleguide" element={lazyPage("Styleguide")} />}
              <Route path="*" element={lazyPage("NotFound")} />
            </Route>
          </Route>
        </Routes>
      </FormatBoundary>
    </>
  );
}
