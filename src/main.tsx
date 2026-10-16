import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { LocaleProvider } from "./locale/LocaleContext.tsx";
import { PortalProvider } from "./store.tsx";
import "./styles.css";

document.documentElement.dataset.theme =
  localStorage.getItem("kastech.ess.theme") === "night" ? "night" : "light";

const root = document.getElementById("root");
if (!root) throw new Error("Root element missing");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
    <BrowserRouter>
      <PortalProvider>
        <LocaleProvider>
          <App />
        </LocaleProvider>
      </PortalProvider>
    </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
