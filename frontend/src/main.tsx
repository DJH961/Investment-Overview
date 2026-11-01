import "@fontsource-variable/inter";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
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

registerServiceWorker();
startLive(queryClient);

createRoot(root).render(
  <StrictMode>
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <PrefsProvider>
        <ToastProvider>
          <ShellProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </ShellProvider>
        </ToastProvider>
      </PrefsProvider>
    </PersistQueryClientProvider>
  </StrictMode>,
);
