import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { LocaleProvider } from "./locale/LocaleContext.tsx";
import { PortalProvider } from "./store.tsx";
import "./styles.css";

// A new hosted build replaces sample data saved by an older version, so the site matches the code.
// Personal settings, notes and the signed-in session are kept.
const BUILD_KEY = "kastech.build";
const KEEP_KEYS = /^(kastech\.prefs\.|kastech\.notes|kastech\.ess\.(user|session|theme|last-active|remember)|kastech\.build$|kastech\.migrate\.)/;
function clearSavedSampleData() {
  for (const key of Object.keys(localStorage)) {
    if (!/^(kastech|timez|hrms|infotech)\./.test(key) || KEEP_KEYS.test(key)) continue;
    localStorage.removeItem(key);
  }
}
if (import.meta.env.PROD && localStorage.getItem(BUILD_KEY) !== __APP_BUILD__) {
  clearSavedSampleData();
  localStorage.setItem(BUILD_KEY, __APP_BUILD__);
}

// One-time reset after the company was renamed to TimeZ, so saved records don't keep the old name.
const BRAND_KEY = "kastech.migrate.timez-brand";
if (!localStorage.getItem(BRAND_KEY)) {
  clearSavedSampleData();
  localStorage.setItem(BRAND_KEY, "1");
}

// One-time rename in data saved by earlier versions: "Isha Reddy" was replaced by "Riya Kapoor"
// (and the generated directory entry by "Isha Kapoor").
const RENAME_KEY = "kastech.migrate.isha-reddy";
if (localStorage.getItem(RENAME_KEY) !== "1") {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith("kastech.") && !key.startsWith("timez.")) continue;
    const value = localStorage.getItem(key);
    if (!value || !/Isha Reddy|isha\.reddy/i.test(value)) continue;
    localStorage.setItem(
      key,
      value
        // The generated directory employee TZ0216 becomes "Isha Kapoor"; everyone else named Isha Reddy is the joiner.
        .replace(/"id":"wf-TZ0216"[^{}]*?"Isha Reddy"/g, (m) => m.replace("Isha Reddy", "Isha Kapoor"))
        .replace(/Isha Reddy/g, "Riya Kapoor")
        .replace(/isha\.reddy\.tz0216/gi, "isha.kapoor.tz0216")
        .replace(/isha\.reddy/gi, "riya.kapoor"),
    );
  }
  localStorage.setItem(RENAME_KEY, "1");
}

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
