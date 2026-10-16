import { useState } from "react";
import type { FormEvent } from "react";
import type { Employee } from "../model.ts";
import { maskMobile } from "../model.ts";
import { usePortal } from "../store.tsx";
import { Banner, Field } from "./ui.tsx";

type ProfileDraft = Pick<Employee, "fullName" | "designation" | "mobile" | "email" | "address" | "shiftName" | "shiftHours">;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Problems with the employee-editable fields, or null when they are fine. */
function validateDraft(draft: ProfileDraft): string | null {
  if (!draft.fullName.trim()) return "Enter a name.";
  if (!EMAIL_PATTERN.test(draft.email.trim())) return "Enter a valid email address (name@company.com).";
  const mobile = draft.mobile.trim();
  const digits = mobile.replace(/\D/g, "").length;
  if (!/^\+?[\d ]+$/.test(mobile) || digits < 8 || digits > 15) {
    return "Enter a valid mobile number: 8–15 digits, optionally starting with + (spaces allowed).";
  }
  return null;
}

export function ProfileEditForm({
  draft,
  setDraft,
  photoFile,
  photoError,
  onReadPhoto,
  onCancel,
  onSaved,
}: {
  draft: ProfileDraft;
  setDraft: (next: ProfileDraft | ((prev: ProfileDraft) => ProfileDraft)) => void;
  photoFile: string;
  /** Problem with the chosen photo (wrong type, too large, unreadable), shown under the picker. */
  photoError?: string;
  onReadPhoto: (file: File) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { employee, requestProfileOtp, updateProfileWithOtp } = usePortal();
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [demoHint, setDemoHint] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  function sendOtp() {
    const code = requestProfileOtp();
    setOtp("");
    setOtpSent(true);
    setDemoHint(code);
    setMessage({
      tone: "ok",
      text: `Verification code sent to ${maskMobile(employee.mobile)}. Enter it below to save.`,
    });
  }

  function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (!otpSent) {
      setMessage({ tone: "err", text: "Send a verification code before saving." });
      return;
    }
    const invalid = validateDraft(draft);
    if (invalid) {
      setMessage({ tone: "err", text: invalid });
      return;
    }
    // Designation and shift are HR-owned: always send the current values, never the draft's.
    const error = updateProfileWithOtp(
      {
        ...draft,
        designation: employee.designation,
        shiftName: employee.shiftName,
        shiftHours: employee.shiftHours,
        photo: photoFile || undefined,
      },
      otp,
    );
    if (error) {
      setMessage({ tone: "err", text: error });
      return;
    }
    setMessage({ tone: "ok", text: "Profile updated." });
    setOtp("");
    setOtpSent(false);
    setDemoHint("");
    onSaved();
  }

  return (
    <form className="identity-edit" onSubmit={saveProfile}>
      <div className="form-grid">
        <Field label="Photo">
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => event.target.files?.[0] && onReadPhoto(event.target.files[0])}
          />
          {photoError ? <span className="note err">{photoError}</span> : <span className="note">JPEG, PNG or WebP, up to 5 MB.</span>}
        </Field>
        <Field label="Name">
          <input value={draft.fullName} onChange={(event) => setDraft({ ...draft, fullName: event.target.value })} />
        </Field>
        <Field label="Mobile">
          <input
            type="tel"
            inputMode="tel"
            value={draft.mobile}
            onChange={(event) => setDraft({ ...draft, mobile: event.target.value })}
          />
        </Field>
        <Field label="Email">
          <input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} />
        </Field>
        <Field label="Address" wide>
          <input value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} />
        </Field>
      </div>

      <section className="profile-hr-owned" aria-label="Managed by HR">
        <dl>
          <div>
            <dt>Designation</dt>
            <dd>{employee.designation || "—"}</dd>
          </div>
          <div>
            <dt>Shift</dt>
            <dd>{employee.shiftName || "—"}</dd>
          </div>
          <div>
            <dt>Hours</dt>
            <dd>{employee.shiftHours || "—"}</dd>
          </div>
        </dl>
        <p className="note">Managed by HR — ask HR to change these.</p>
      </section>

      <div className="otp-box">
        <p className="otp-title">Verify before save</p>
        <p className="note">Changes to personal details need a one-time code sent to your registered mobile.</p>
        <div className="form-actions" style={{ marginTop: 10 }}>
          <button className="btn-ghost" type="button" onClick={sendOtp}>
            {otpSent ? "Resend code" : "Send OTP"}
          </button>
        </div>
        {otpSent && (
          <div className="form-grid" style={{ marginTop: 10 }}>
            <Field label="Enter OTP">
              <input
                value={otp}
                onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
              />
            </Field>
          </div>
        )}
        {demoHint && <p className="note">Demo OTP: <strong>{demoHint}</strong></p>}
      </div>

      <div className="form-actions">
        <button className="btn" type="submit" disabled={!otpSent || otp.length !== 6}>
          Save profile
        </button>
        <button className="btn-ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <Banner message={message} />
    </form>
  );
}
