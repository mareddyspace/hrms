import { useEffect, useSyncExternalStore } from "react";

/** Small global toast: call notify("Saved.") from anywhere; <ToastHost /> is mounted in the Shell. */
export type ToastTone = "ok" | "err" | "info";
type ToastItem = { id: number; text: string; tone: ToastTone };

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dismissToast(id: number) {
  items = items.filter((item) => item.id !== id);
  emit();
}

export function notify(text: string, tone: ToastTone = "ok") {
  if (!text) return;
  // Same message twice in a row: keep one.
  items = [...items.filter((item) => item.text !== text), { id: nextId++, text, tone }].slice(-4);
  emit();
}

export const notifyError = (text: string) => notify(text, "err");

function ToastRow({ item }: { item: ToastItem }) {
  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(item.id), item.tone === "err" ? 7000 : 4500);
    return () => window.clearTimeout(timer);
  }, [item.id, item.tone]);
  return (
    <div className={`toast ${item.tone}`} role={item.tone === "err" ? "alert" : "status"}>
      <span className="toast-mark" aria-hidden>
        {item.tone === "ok" ? "✓" : item.tone === "err" ? "!" : "i"}
      </span>
      <span className="toast-text">{item.text}</span>
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(item.id)}>
        ×
      </button>
    </div>
  );
}

export function ToastHost() {
  const list = useSyncExternalStore(subscribe, () => items, () => items);
  return (
    <div className="toast-host" aria-live="polite">
      {list.map((item) => (
        <ToastRow key={item.id} item={item} />
      ))}
    </div>
  );
}
