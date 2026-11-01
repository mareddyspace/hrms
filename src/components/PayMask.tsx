import { useSyncExternalStore } from "react";
import { Eye, EyeOff } from "lucide-react";
import { money } from "../countryPay.ts";
import { usePortal } from "../store.tsx";
import "./payMask.css";

/**
 * Pay amounts on Home start hidden ("₹ ••••••"). The eye toggle shows them for this browser session only
 * (sessionStorage, for the person who turned it on), and one toggle shows or hides every pay card at once.
 */
const KEY = "timez.home.showPay.v1";
const listeners = new Set<() => void>();
/** Who turned amounts on (another sign-in in this tab starts hidden again). */
let shownFor: string | null | undefined;

function read(): string {
  if (shownFor === undefined) {
    try {
      shownFor = sessionStorage.getItem(KEY);
    } catch {
      shownFor = null;
    }
  }
  return shownFor ?? "";
}

function setShown(ownerId: string | null) {
  shownFor = ownerId;
  try {
    if (ownerId) sessionStorage.setItem(KEY, ownerId);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* private window: stays for this page only */
  }
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function usePayVisible(): boolean {
  const { employee } = usePortal();
  const owner = useSyncExternalStore(subscribe, read, () => "");
  return Boolean(owner) && owner === employee.id;
}

function currencySymbol(currency: string): string {
  try {
    const part = new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol" })
      .formatToParts(0)
      .find((p) => p.type === "currency");
    return part?.value ?? currency;
  } catch {
    return currency;
  }
}

/** An amount that shows as "₹ ••••••" until the eye toggle is on. */
export function PayAmount({ amount, currency }: { amount: number; currency: string }) {
  const visible = usePayVisible();
  if (visible) return <>{money(amount, currency)}</>;
  return (
    <span className="pay-masked" aria-label="Amount hidden">
      {currencySymbol(currency)} ••••••
    </span>
  );
}

/** Eye button that shows or hides pay amounts on Home for this session. */
export function PayEyeToggle() {
  const { employee } = usePortal();
  const visible = usePayVisible();
  return (
    <button
      type="button"
      className="icon-btn pay-eye"
      aria-pressed={visible}
      aria-label={visible ? "Hide pay amounts" : "Show pay amounts"}
      title={visible ? "Hide amounts" : "Show amounts for this session"}
      onClick={() => setShown(visible ? null : employee.id)}
    >
      {visible ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
      <span>{visible ? "Hide" : "Show"}</span>
    </button>
  );
}
