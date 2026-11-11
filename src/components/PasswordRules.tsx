import { Check, X } from "lucide-react";
import "../styles/calendar-people.css";

/** The server's rules (backend/app/routers/auth.py password_problem), checked as you type. */
export function passwordChecks(next: string, confirm: string, current?: string, email?: string) {
  const local = (email ?? "").split("@")[0].toLowerCase();
  return [
    { id: "length", label: "At least 8 characters", ok: next.length >= 8 },
    { id: "mix", label: "Letters and at least one number", ok: /[a-z]/i.test(next) && /\d/.test(next) },
    ...(current !== undefined ? [{ id: "new", label: "Different from your current password", ok: next.length > 0 && next !== current }] : []),
    ...(local ? [{ id: "email", label: "Doesn't contain your email name", ok: next.length > 0 && !next.toLowerCase().includes(local) }] : []),
    { id: "match", label: "Both new passwords match", ok: next.length > 0 && next === confirm },
  ];
}

/** First rule not met, as an error message; null when the new password is fine. */
export function passwordRuleError(next: string, confirm: string, current?: string, email?: string): string | null {
  const miss = passwordChecks(next, confirm, current, email).find((c) => !c.ok);
  return miss ? (miss.id === "match" ? "Confirmation does not match." : `${miss.label}.`) : null;
}

export function PasswordRules({ next, confirm, current, email }: { next: string; confirm: string; current?: string; email?: string }) {
  const checks = passwordChecks(next, confirm, current, email);
  const strong = next.length >= 12 && /[A-Z]/.test(next) && /[a-z]/.test(next) && /\d/.test(next) && /[^A-Za-z0-9]/.test(next);
  const met = checks.filter((c) => c.ok).length;
  const level = !next ? "" : strong && met === checks.length ? "strong" : met === checks.length ? "good" : "weak";
  return (
    <div className="pw-rules">
      {level && (
        <p className={`pw-meter ${level}`} aria-live="polite">
          Strength: {level === "strong" ? "Strong" : level === "good" ? "Good" : "Too weak"}
        </p>
      )}
      <ul>
        {checks.map((c) => (
          <li key={c.id} className={c.ok ? "ok" : ""}>
            {c.ok ? <Check size={13} aria-hidden /> : <X size={13} aria-hidden />}
            {c.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
