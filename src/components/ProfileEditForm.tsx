import { useState } from "react";
import type { FormEvent } from "react";
import type { Employee } from "../model.ts";
import { maskMobile } from "../model.ts";
import { usePortal } from "../store.tsx";
import { Banner, Field } from "./ui.tsx";

type ProfileDraft = Pick<Employee, "fullName" | "designation" | "mobile" | "email" | "address" | "shiftName" | "shiftHours">;

export function ProfileEditForm({
  draft,
  setDraft,
  photoFile,
  onReadPhoto,
  onCancel,
  onSaved,
}: {
  draft: ProfileDraft;
  setDraft: (next: ProfileDraft | ((prev: ProfileDraft) => ProfileDraft)) => void;
  photoFile: string;
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
    const error = updateProfileWithOtp({ ...draft, photo: photoFile || undefined }, otp);
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
          <input type="file" accept="image/*" onChange={(event) => event.target.files?.[0] && onReadPhoto(event.target.files[0])} />
        </Field>
        <Field label="Name">
          <input value={draft.fullName} onChange={(event) => setDraft({ ...draft, fullName: event.target.value })} />
        </Field>
        <Field label="Designation">
          <input value={draft.designation} onChange={(event) => setDraft({ ...draft, designation: event.target.value })} />
        </Field>
        <Field label="Mobile">
          <input value={draft.mobile} onChange={(event) => setDraft({ ...draft, mobile: event.target.value })} />
        </Field>
        <Field label="Email">
          <input value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} />
        </Field>
        <Field label="Address" wide>
          <input value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} />
        </Field>
        <Field label="Shift">
          <input value={draft.shiftName} onChange={(event) => setDraft({ ...draft, shiftName: event.target.value })} />
        </Field>
        <Field label="Hours">
          <input value={draft.shiftHours} onChange={(event) => setDraft({ ...draft, shiftHours: event.target.value })} />
        </Field>
      </div>

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
