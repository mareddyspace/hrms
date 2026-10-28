import { useState } from "react";
import { API_ENABLED } from "../../api/client.ts";
import { apiRequestProfileOtp, apiUpdateOwnProfile, type ApiSelfProfileUpdate } from "../../api/syncProfile.ts";
import { Banner, Field } from "../../components/ui.tsx";
import type { CopilotAction, CopilotAnswer, CopilotChart as Chart, CopilotLetterDraft } from "../../data/platformData.ts";
import { requestLetter } from "../../data/letterService.ts";
import { maskAddress, maskMobile, type LeaveCode, type LeaveHalf } from "../../model.ts";
import { usePortal } from "../../store.tsx";
import { logCopilotAction } from "./assist.ts";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const GRID = { gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginTop: 8 } as const;

/** Chart, filters, letter draft and prepared action under a Copilot answer. Used by the popup and the full page. */
export function CopilotExtras({ answer }: { answer: CopilotAnswer }) {
  return (
    <>
      {answer.chart && <CopilotBarChart chart={answer.chart} />}
      {answer.filters && answer.filters.length > 0 && (
        <p className="note" style={{ marginTop: 6 }}>
          {answer.filters.join(" · ")}
        </p>
      )}
      {answer.letterDraft && <LetterDraftPanel draft={answer.letterDraft} />}
      {answer.action && <ActionPanel action={answer.action} />}
    </>
  );
}

/* ───────────── chart ───────────── */

/** Horizontal bars, inline SVG. Values are also in the table above, so the chart is decorative for screen readers. */
export function CopilotBarChart({ chart }: { chart: Chart }) {
  const bars = chart.bars.slice(0, 10);
  if (!bars.length) return null;
  const max = Math.max(...bars.map((b) => b.value), 1);
  const rowH = 22;
  const labelW = 118;
  const barW = 150;
  const height = bars.length * rowH + 6;
  const short = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s);
  return (
    <figure style={{ margin: "10px 0 0" }}>
      <figcaption className="note" style={{ marginBottom: 4 }}>
        {chart.title}
      </figcaption>
      <svg viewBox={`0 0 320 ${height}`} width="100%" style={{ maxWidth: 480, display: "block" }} role="img" aria-label={`${chart.title}: ${bars.map((b) => `${b.label} ${b.value}`).join(", ")}`}>
        {bars.map((b, i) => {
          const y = i * rowH + 4;
          const w = Math.max(2, Math.round((b.value / max) * barW));
          return (
            <g key={`${b.label}-${i}`}>
              <title>{`${b.label}: ${b.value}${chart.unit ?? ""}`}</title>
              <text x={labelW - 6} y={y + 12} textAnchor="end" fontSize="10" style={{ fill: "var(--muted)" }}>
                {short(b.label)}
              </text>
              <rect x={labelW} y={y + 2} width={w} height={rowH - 8} rx={3} style={{ fill: "var(--accent)" }} />
              <text x={labelW + w + 4} y={y + 12} fontSize="10" style={{ fill: "var(--ink)" }}>
                {`${b.value}${chart.unit ?? ""}`}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/* ───────────── letter draft ───────────── */

function LetterDraftPanel({ draft }: { draft: CopilotLetterDraft }) {
  const { demoProfile, employee } = usePortal();
  const [details, setDetails] = useState(draft.details ?? "");
  const [effective, setEffective] = useState("");
  const [state, setState] = useState<"open" | "sent" | "cancelled">("open");
  const [message, setMessage] = useState<Msg>(null);
  const stillMissing = draft.missing.filter((m) => !(draft.detailsLabel && m === draft.detailsLabel && details.trim()) && !(m === "Effective date" && effective));

  function send() {
    if (draft.detailsLabel && !details.trim()) {
      setMessage({ tone: "err", text: `Add ${draft.detailsLabel.toLowerCase()}.` });
      return;
    }
    const error = requestLetter(demoProfile, {
      employeeId: draft.employeeId,
      type: draft.type,
      note: "Prepared with Copilot",
      details: draft.detailsLabel ? details : undefined,
      effectiveDate: effective || undefined,
    });
    if (error) {
      setMessage({ tone: "err", text: error });
      return;
    }
    logCopilotAction("Confirmed", { id: employee.id, name: employee.fullName }, { letter: { ...draft, details } }, "Sent for approval");
    setState("sent");
    setMessage({ tone: "ok", text: "Draft created and sent for approval. Track it in Documents." });
  }

  return (
    <div className="otp-box" style={{ marginTop: 10 }}>
      <p className="otp-title">
        {draft.label} · {draft.employeeName}
      </p>
      <dl className="copilot-fab-metrics" style={{ marginTop: 6 }}>
        {draft.fields.map((f) => (
          <div key={f.label} className="copilot-fab-metric">
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
      {state === "open" && (draft.detailsLabel || draft.needsEffectiveDate) && (
        <div className="form-grid" style={GRID}>
          {draft.detailsLabel && (
            <Field label={draft.detailsLabel}>
              <input value={details} maxLength={200} onChange={(e) => setDetails(e.target.value)} />
            </Field>
          )}
          {draft.needsEffectiveDate && (
            <Field label="Effective date">
              <input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
            </Field>
          )}
        </div>
      )}
      {stillMissing.length > 0 && (
        <p className="note warn" style={{ marginTop: 6 }}>
          Missing: {stillMissing.join(", ")}.
        </p>
      )}
      {state === "open" && (
        <div className="row-gap" style={{ marginTop: 8 }}>
          <button type="button" className="btn" onClick={send}>
            Create draft and send for approval
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setState("cancelled");
              setMessage({ tone: "info", text: "Cancelled. Nothing was created." });
            }}
          >
            Cancel
          </button>
        </div>
      )}
      <Banner message={message} />
    </div>
  );
}

/* ───────────── prepared actions ───────────── */

function ActionPanel({ action }: { action: CopilotAction }) {
  return action.kind === "profile" ? <ProfileChange action={action} /> : <LeaveChange action={action} />;
}

const validPhone = (v: string) => /^\+?[\d ]+$/.test(v.trim()) && v.replace(/\D/g, "").length >= 8 && v.replace(/\D/g, "").length <= 15;

/** "12 MG Road, Kochi, 682016, India" -> address parts for the server; a short text stays the street line. */
function splitAddress(text: string): ApiSelfProfileUpdate {
  const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return { address_line: text };
  const country = parts.pop()!;
  const pcIndex = parts.findIndex((p, i) => i > 0 && /\d/.test(p) && /^[A-Za-z0-9 -]{3,10}$/.test(p));
  const postcode = pcIndex > 0 ? parts.splice(pcIndex, 1)[0] : null;
  const city = parts.length > 1 ? parts.pop()! : null;
  return { address_line: parts.join(", "), address_city: city, address_postcode: postcode, address_country: country };
}

function ProfileChange({ action }: { action: Extract<CopilotAction, { kind: "profile" }> }) {
  const { employee, requestProfileOtp, updateProfileWithOtp, verifyProfileOtp } = usePortal();
  const [saving, setSaving] = useState(false);
  const [value, setValue] = useState(action.proposed);
  const [otp, setOtp] = useState("");
  const [code, setCode] = useState("");
  const [state, setState] = useState<"open" | "done" | "cancelled">("open");
  const [message, setMessage] = useState<Msg>(null);
  const isMobile = action.field === "mobile";
  const label = isMobile ? "New mobile number" : "New address";

  // Backend mode: only a new mobile needs a code (sent by the server); an address change is confirmed directly.
  const needsCode = !API_ENABLED || isMobile;

  function sendCode() {
    if (API_ENABLED) {
      const next = value.trim();
      if (!validPhone(next)) return setMessage({ tone: "err", text: "Enter a valid mobile number: 8–15 digits, optionally starting with +." });
      void apiRequestProfileOtp("mobile", next).then((sent) => {
        if (sent.error) return setMessage({ tone: "err", text: sent.error });
        // "sent" marks the code step as open; the code itself is shown only when the server echoes it (dev).
        setCode(sent.devCode ?? "sent");
        setOtp("");
        setMessage({ tone: "ok", text: `Code sent to ${sent.sentTo || "your email"}.` });
      });
      return;
    }
    setCode(requestProfileOtp());
    setOtp("");
    setMessage({ tone: "ok", text: `Code sent to ${maskMobile(employee.mobile)}.` });
  }

  function confirm() {
    const next = value.trim();
    if (!next) return setMessage({ tone: "err", text: `Enter the ${isMobile ? "new number" : "new address"}.` });
    if (isMobile && !validPhone(next)) return setMessage({ tone: "err", text: "Enter a valid mobile number: 8–15 digits, optionally starting with +." });
    if (API_ENABLED) {
      // Backend mode: the server checks the code, saves (PATCH /people/me) and audits the change.
      if (needsCode) {
        const otpError = verifyProfileOtp(otp);
        if (otpError) return setMessage({ tone: "err", text: otpError });
      }
      setSaving(true);
      void apiUpdateOwnProfile(isMobile ? { mobile: next, otp_code: otp } : splitAddress(next)).then((failed) => {
        setSaving(false);
        if (failed) return setMessage({ tone: "err", text: failed });
        logCopilotAction("Confirmed", { id: employee.id, name: employee.fullName }, { action: { ...action, proposed: next } }, "Profile updated");
        setState("done");
        setCode("");
        setMessage({ tone: "ok", text: `${isMobile ? "Mobile number" : "Address"} updated.` });
      });
      return;
    }
    const error = updateProfileWithOtp(
      {
        fullName: employee.fullName,
        designation: employee.designation,
        email: employee.email,
        shiftName: employee.shiftName,
        shiftHours: employee.shiftHours,
        mobile: isMobile ? next : employee.mobile,
        address: isMobile ? employee.address : next,
      },
      otp,
    );
    if (error) return setMessage({ tone: "err", text: error });
    logCopilotAction("Confirmed", { id: employee.id, name: employee.fullName }, { action: { ...action, proposed: next } }, "Profile updated");
    setState("done");
    setCode("");
    setMessage({ tone: "ok", text: `${isMobile ? "Mobile number" : "Address"} updated.` });
  }

  return (
    <div className="otp-box" style={{ marginTop: 10 }}>
      <p className="otp-title">{isMobile ? "Change mobile number" : "Change address"}</p>
      <p className="note">Current: {isMobile ? maskMobile(action.current) : maskAddress(action.current)}</p>
      {state === "open" && (
        <>
          <div className="form-grid" style={GRID}>
            <Field label={label}>
              {isMobile ? (
                <input type="tel" inputMode="tel" value={value} onChange={(e) => setValue(e.target.value)} />
              ) : (
                <textarea rows={2} value={value} onChange={(e) => setValue(e.target.value)} />
              )}
            </Field>
            {code && (
              <Field label="Verification code">
                <input
                  value={otp}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="6-digit code"
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                />
              </Field>
            )}
          </div>
          {code && code !== "sent" && <p className="note">Code: <strong>{code}</strong></p>}
          <div className="row-gap" style={{ marginTop: 8 }}>
            {!needsCode ? (
              <button type="button" className="btn" onClick={confirm} disabled={!value.trim() || saving}>
                Confirm change
              </button>
            ) : !code ? (
              <button type="button" className="btn" onClick={sendCode} disabled={!value.trim()}>
                Send code to confirm
              </button>
            ) : (
              <>
                <button type="button" className="btn" onClick={confirm} disabled={otp.length !== 6 || saving}>
                  Confirm change
                </button>
                <button type="button" className="btn-ghost" onClick={sendCode}>
                  Resend code
                </button>
              </>
            )}
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setState("cancelled");
                logCopilotAction("Cancelled", { id: employee.id, name: employee.fullName }, { action });
                setMessage({ tone: "info", text: "Cancelled. Nothing was changed." });
              }}
            >
              Cancel
            </button>
          </div>
        </>
      )}
      <Banner message={message} />
    </div>
  );
}

const WFH = new Set(["wfh", "emergency_wfh"]);

function LeaveChange({ action }: { action: Extract<CopilotAction, { kind: "leave" }> }) {
  const { applyLeave, employee, hasApprover } = usePortal();
  const [code, setCode] = useState<LeaveCode>(action.code);
  const [from, setFrom] = useState(action.from);
  const [to, setTo] = useState(action.to);
  const [half, setHalf] = useState<LeaveHalf | "">(action.half ?? "");
  const [reason, setReason] = useState(action.reason);
  const [state, setState] = useState<"open" | "busy" | "done" | "cancelled">("open");
  const [message, setMessage] = useState<Msg>(null);
  const singleDay = Boolean(from) && from === to;
  const canHalf = singleDay && !WFH.has(code);
  const name = action.options.find((o) => o.code === code)?.name ?? action.codeName;

  async function confirm() {
    if (!from || !to) return setMessage({ tone: "err", text: "Choose the from and to dates." });
    if (!reason.trim()) return setMessage({ tone: "err", text: "Add a reason." });
    setState("busy");
    const error = await applyLeave({ code, from, to, reason, half: canHalf && half ? half : undefined });
    if (error) {
      setState("open");
      return setMessage({ tone: "err", text: error });
    }
    logCopilotAction(
      "Confirmed",
      { id: employee.id, name: employee.fullName },
      { action: { ...action, code, codeName: name, from, to, half: canHalf && half ? half : undefined, reason } },
      "Leave applied",
    );
    setState("done");
    setMessage({ tone: "ok", text: hasApprover ? "Leave applied and sent to your manager." : "Leave applied. With nobody above you, it's approved automatically." });
  }

  return (
    <div className="otp-box" style={{ marginTop: 10 }}>
      <p className="otp-title">Apply for leave</p>
      {state !== "done" && state !== "cancelled" && (
        <>
          <div className="form-grid" style={GRID}>
            <Field label="Type">
              <select value={code} onChange={(e) => setCode(e.target.value as LeaveCode)}>
                {action.options.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.name} · {o.available} available
                  </option>
                ))}
              </select>
            </Field>
            <Field label="From">
              <input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  if (!to || to < e.target.value) setTo(e.target.value);
                }}
              />
            </Field>
            <Field label="To">
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </Field>
            {canHalf && (
              <Field label="Day">
                <select value={half} onChange={(e) => setHalf(e.target.value as LeaveHalf | "")}>
                  <option value="">Full day</option>
                  <option value="first">First half</option>
                  <option value="second">Second half</option>
                </select>
              </Field>
            )}
            <Field label="Reason">
              <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
          <div className="row-gap" style={{ marginTop: 8 }}>
            <button type="button" className="btn" onClick={confirm} disabled={state === "busy"}>
              Confirm and apply
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setState("cancelled");
                setMessage({ tone: "info", text: "Cancelled. No leave was applied." });
              }}
            >
              Cancel
            </button>
          </div>
        </>
      )}
      <Banner message={message} />
    </div>
  );
}
