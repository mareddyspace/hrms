import { Component, type ErrorInfo, type ReactNode } from "react";

/** Keys this app saves in the browser. Clearing them restores the demo's starting data. */
const SAVED_DATA_PREFIXES = ["kastech.", "timez."];

function clearSavedData() {
  for (const key of Object.keys(localStorage)) {
    if (SAVED_DATA_PREFIXES.some((prefix) => key.startsWith(prefix))) localStorage.removeItem(key);
  }
}

/**
 * Shows a recovery screen instead of a blank page when something crashes while rendering —
 * for example saved browser data from an older version of the app.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-screen" role="alert">
        <div className="crash-card">
          <h1>Something went wrong</h1>
          <p>This page couldn't load. Reloading usually fixes it.</p>
          <details>
            <summary>Error details</summary>
            <pre>{error.message}</pre>
          </details>
          <div className="crash-actions">
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Reload page
            </button>
            <button type="button" className="btn-ghost" onClick={() => window.location.assign("/")}>
              Go to Home
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                if (!window.confirm("Reset saved data? Your local changes in this browser will be cleared and you'll be signed out.")) return;
                clearSavedData();
                window.location.assign("/");
              }}
            >
              Reset saved data
            </button>
          </div>
        </div>
      </div>
    );
  }
}
