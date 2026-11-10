import "@fontsource-variable/inter";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import { PrefsProvider } from "./lib/prefs";
import { startLive } from "./lib/live";
import { persistOptions, queryClient } from "./lib/queries";
import { registerServiceWorker } from "./pwa/register";
import { ShellProvider } from "./lib/shell";
import "./styles/index.scss";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// Fixture mode (build flag): fake data, no backend. Dropped from normal builds.
if (import.meta.env.VITE_FIXTURES === "1") await (await import("./fixtures/install")).installFixtures();

registerServiceWorker();
startLive(queryClient);

// A data router (not BrowserRouter) so pages can block navigation while work is unsaved.
const router = createBrowserRouter([{ path: "*", element: <App /> }]);

createRoot(root).render(
  <StrictMode>
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <PrefsProvider>
        <ToastProvider>
          <ShellProvider>
            <RouterProvider router={router} />
          </ShellProvider>
        </ToastProvider>
      </PrefsProvider>
    </PersistQueryClientProvider>
  </StrictMode>,
);
