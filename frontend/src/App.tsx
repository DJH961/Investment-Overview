import { useEffect } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import { AppShell } from "./components/AppShell";
import { setUnauthorizedHandler } from "./lib/api";
import { Activity } from "./pages/Activity";
import { Allocations } from "./pages/Allocations";
import { CurrencyConversions } from "./pages/CurrencyConversions";
import { Diagnostics } from "./pages/Diagnostics";
import { Help } from "./pages/Help";
import { Holdings } from "./pages/Holdings";
import { Import } from "./pages/Import";
import { Login } from "./pages/Login";
import { NotFound } from "./pages/NotFound";
import { Onboarding } from "./pages/Onboarding";
import { Overview } from "./pages/Overview";
import { Periods } from "./pages/Periods";
import { Projection } from "./pages/Projection";
import { Risk } from "./pages/Risk";
import { Settings } from "./pages/Settings";
import { Styleguide } from "./pages/Styleguide";
import { Transactions } from "./pages/Transactions";

export function App() {
  const navigate = useNavigate();
  useEffect(() => {
    setUnauthorizedHandler(() => navigate("/login"));
  }, [navigate]);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/overview" replace />} />
        <Route path="/overview" element={<Overview />} />
        <Route path="/holdings" element={<Holdings />} />
        <Route path="/periods" element={<Periods />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/risk" element={<Risk />} />
        <Route path="/projection" element={<Projection />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/import" element={<Import />} />
        <Route path="/conversions" element={<CurrencyConversions />} />
        <Route path="/allocations" element={<Allocations />} />
        <Route path="/diagnostics" element={<Diagnostics />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/help" element={<Help />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/_styleguide" element={<Styleguide />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
