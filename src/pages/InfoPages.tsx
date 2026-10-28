export { HelpPage } from "./CollabModules.tsx";
import { useEffect, useState } from "react";
import { DEMO_MODE } from "../demoMode.ts";
import type { FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Eye, EyeOff } from "lucide-react";
import { COMPANY_NAME, PRODUCT_TAGLINE } from "../brand.ts";
import { Banner, Card, Field, Page } from "../components/ui.tsx";
import type { DemoAccount } from "../demoAccounts.ts";
import { maskEmail, maskMobile } from "../model.ts";
import { usePortal } from "../store.tsx";
import { MFA_CODE_NEEDED, apiMfaSetupRequired } from "../api/client.ts";

type ResetChannel = "email" | "mobile";

/** Demo persona panel and on-screen OTP codes are local-development aids only. */
const SHOW_DEV_ACCOUNTS = DEMO_MODE;

export function LoginPage() {
  const {
    signedIn,
    signIn,
    employee,
    demoAccounts,
    requestPasswordResetOtp,
    resetPasswordWithOtp,
    rememberedEmail,
  } = usePortal();
  const navigate = useNavigate();
  useEffect(() => {
    document.title = `Sign in · ${COMPANY_NAME}`;
  }, []);
  const [mode, setMode] = useState<"login" | "forgot">("login");
  const [email, setEmail] = useState(rememberedEmail ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(Boolean(rememberedEmail));
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [channel, setChannel] = useState<ResetChannel>("email");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [demoOtp, setDemoOtp] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [sentChannel, setSentChannel] = useState<ResetChannel>("email");
  const [message, setMessage] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  // Two-step sign-in: after the password, the code from the authenticator app (or a backup code).
  const [mfaStep, setMfaStep] = useState(false);
  const [mfaCode, setMfaCode] = useState("");

  if (signedIn) return <Navigate to="/" replace />;

  function validateLogin() {
    const next: { email?: string; password?: string } = {};
    if (!email.trim()) next.email = "Enter your work email or employee ID.";
    if (!password.trim()) next.password = "Enter your password.";
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!validateLogin()) {
      setMessage({ tone: "err", text: "Fix the highlighted fields to continue." });
      return;
    }
    if (mfaStep && !mfaCode.trim()) {
      setMessage({ tone: "err", text: "Enter the code from your app." });
      return;
    }
    const error = await signIn(email, password, remember, mfaStep ? mfaCode : undefined);
    if (error === MFA_CODE_NEEDED) {
      setMfaStep(true);
      setMfaCode("");
      setMessage({ tone: "info", text: error });
      window.setTimeout(() => document.querySelector<HTMLInputElement>(".login-card input[name=mfa-code]")?.focus(), 50);
      return;
    }
    if (error) setMessage({ tone: "err", text: error });
    else navigate(apiMfaSetupRequired() ? "/settings/security" : "/");
  }

  function leaveMfaStep() {
    setMfaStep(false);
    setMfaCode("");
    setMessage(null);
  }

  function fillDemo(account: DemoAccount) {
    // Fills the email and default password; the person then presses Sign in.
    setEmail(account.email);
    setPassword(account.password);
    setMfaStep(false);
    setMfaCode("");
    setFieldErrors({});
    setMessage({ tone: "ok", text: `${account.fullName}'s details are filled in. Press Sign in.` });
    // On narrow screens the form is above the list; bring it into view.
    document.querySelector(".login-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => document.querySelector<HTMLButtonElement>(".login-card button[type=submit]")?.focus(), 50);
  }


  function sendResetOtp() {
    const result = requestPasswordResetOtp(email, channel);
    if ("error" in result) {
      setMessage({ tone: "err", text: result.error });
      return;
    }
    setOtpSent(true);
    setDemoOtp(result.code);
    setSentTo(result.sentTo);
    setSentChannel(result.channel);
    setOtp("");
    const destination =
      result.channel === "email" ? maskEmail(result.sentTo) : maskMobile(result.sentTo);
    setMessage({
      tone: "ok",
      text: `OTP sent to your registered ${result.channel === "email" ? "email" : "mobile"} ${destination}.`,
    });
  }

  function onReset(event: FormEvent) {
    event.preventDefault();
    if (!otpSent) {
      setMessage({ tone: "err", text: "Send a verification code first." });
      return;
    }
    const error = resetPasswordWithOtp(email, otp, newPassword, confirm);
    if (error) {
      setMessage({ tone: "err", text: error });
      return;
    }
    setMode("login");
    setPassword("");
    setOtp("");
    setNewPassword("");
    setConfirm("");
    setOtpSent(false);
    setDemoOtp("");
    setSentTo("");
    setMessage({ tone: "ok", text: "Password updated. Sign in with your new password." });
  }

  function openForgot() {
    setMode("forgot");
    setMessage(null);
    setOtp("");
    setNewPassword("");
    setConfirm("");
    setOtpSent(false);
    setDemoOtp("");
    setSentTo("");
    setChannel("email");
  }

  function backToLogin() {
    setMode("login");
    setMessage(null);
    setOtp("");
    setNewPassword("");
    setConfirm("");
    setOtpSent(false);
    setDemoOtp("");
    setSentTo("");
  }

  const maskedDestination =
    sentChannel === "email" ? maskEmail(sentTo || employee.email) : maskMobile(sentTo || employee.mobile);

  return (
    <div className="login-screen">
      {mode === "login" ? (
        <div className="login-layout">
          <form className="login-card" onSubmit={onSubmit} noValidate>
            <span className="mark" aria-hidden>
              TZ
            </span>
            <h1>{COMPANY_NAME}</h1>
            <p className="lede">{PRODUCT_TAGLINE}</p>
            {mfaStep ? (
              <div className="stack">
                <p className="muted">Signing in as {email}</p>
                <Field label="Code from your authenticator app" wide>
                  <input
                    name="mfa-code"
                    value={mfaCode}
                    onChange={(event) => setMfaCode(event.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    maxLength={16}
                  />
                </Field>
                <p className="muted">Lost your phone? Enter a backup code instead.</p>
              </div>
            ) : (
            <div className="stack">
              <Field label="Work email" wide>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setFieldErrors((prev) => ({ ...prev, email: undefined }));
                  }}
                  autoComplete="username"
                  placeholder="name@timez.com"
                  aria-invalid={Boolean(fieldErrors.email)}
                />
              </Field>
              {fieldErrors.email && <p className="field-error">{fieldErrors.email}</p>}
              <div className="login-password-block">
                <div className="login-password-head">
                  <span>Password</span>
                  <button className="login-forgot" type="button" onClick={openForgot}>
                    Forgot password?
                  </button>
                </div>
                <div className="password-input-wrap">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setFieldErrors((prev) => ({ ...prev, password: undefined }));
                    }}
                    autoComplete="current-password"
                    aria-invalid={Boolean(fieldErrors.password)}
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    onClick={() => setShowPassword((value) => !value)}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              {fieldErrors.password && <p className="field-error">{fieldErrors.password}</p>}
              <label className="remember-row">
                <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                <span>Remember me on this device</span>
              </label>
            </div>
            )}
            <div className="login-actions">
              <button className="btn" type="submit">
                {mfaStep ? "Verify" : "Sign in"}
              </button>
              {mfaStep && (
                <button className="btn-ghost" type="button" onClick={leaveMfaStep}>
                  Back
                </button>
              )}
              <button className="btn-ghost sso-demo" type="button" disabled title="Single sign-on is not enabled">
                Continue with SSO
              </button>
            </div>
            <Banner message={message} />
          </form>

          {SHOW_DEV_ACCOUNTS && (
          <aside className="login-demo-panel" aria-label="Development accounts">
            <div className="login-demo-head">
              <h2>Accounts</h2>
              <p>{demoAccounts.length} accounts</p>
            </div>
            <div className="login-demo-grid">
              {demoAccounts.map((account) => (
                <article key={account.id} className="login-demo-card">
                  <div>
                    <strong>{account.personaLabel}</strong>
                    <span>{account.fullName}</span>
                    <small>
                      {account.email}
                      <br />
                      ID {account.employeeCode} · {account.countryName}
                      <br />
                      Default password: {account.password}
                    </small>
                  </div>
                  <div className="login-demo-actions">
                    <button type="button" className="btn btn-tiny" onClick={() => fillDemo(account)}>
                      Fill
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </aside>
          )}
        </div>
      ) : (
        <form className="login-card" onSubmit={onReset}>
          <span className="mark" aria-hidden>
            TZ
          </span>
          <h1>Forgot password</h1>
          <p className="lede">We send a one-time code to your registered mobile or email, then you set a new password.</p>
          <div className="stack">
            <Field label="Work email or employee ID">
              <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" />
            </Field>

            <fieldset className="otp-channel">
              <legend>Send OTP to</legend>
              <label className={channel === "mobile" ? "otp-choice active" : "otp-choice"}>
                <input
                  type="radio"
                  name="otp-channel"
                  checked={channel === "mobile"}
                  onChange={() => {
                    setChannel("mobile");
                    setOtpSent(false);
                    setDemoOtp("");
                    setSentTo("");
                  }}
                />
                <span>
                  Mobile
                  <small>{maskMobile(employee.mobile)}</small>
                </span>
              </label>
              <label className={channel === "email" ? "otp-choice active" : "otp-choice"}>
                <input
                  type="radio"
                  name="otp-channel"
                  checked={channel === "email"}
                  onChange={() => {
                    setChannel("email");
                    setOtpSent(false);
                    setDemoOtp("");
                    setSentTo("");
                  }}
                />
                <span>
                  Email
                  <small>{maskEmail(employee.email)}</small>
                </span>
              </label>
            </fieldset>

            <div className="form-actions" style={{ marginTop: 0 }}>
              <button className="btn-ghost" type="button" onClick={sendResetOtp}>
                {otpSent ? "Resend OTP" : "Send OTP"}
              </button>
            </div>

            {otpSent && (
              <>
                <div className="otp-box">
                  <p className="otp-title">OTP sent</p>
                  <p className="note">
                    Delivered to your registered {sentChannel === "email" ? "email" : "mobile"}: <strong>{maskedDestination}</strong>
                  </p>
                  {SHOW_DEV_ACCOUNTS && (
                    <>
                      <p className="note">Development build: no SMS/email gateway, so the code is shown here.</p>
                      <p className="otp-code">{demoOtp}</p>
                    </>
                  )}
                </div>
                <Field label="OTP">
                  <input
                    value={otp}
                    onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="6-digit code"
                  />
                </Field>
                <Field label="New password">
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
                <Field label="Confirm password">
                  <input
                    type="password"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
              </>
            )}
          </div>
          <div className="login-actions">
            <button className="btn" type="submit" disabled={!otpSent || otp.length !== 6}>
              Reset password
            </button>
          </div>
          <div className="login-forgot-row">
            <button className="login-forgot" type="button" onClick={backToLogin}>
              Back to sign in
            </button>
          </div>
          <Banner message={message} />
        </form>
      )}
    </div>
  );
}

export function TermsPage() {
  return (
    <Page title="Terms & conditions">
      <Card>
        <div className="prose">
          <p>{COMPANY_NAME} is your employee portal. It is not a payroll, tax, or attendance system of record until those records are connected.</p>
          <p>Downloaded payslip text is not an official salary statement.</p>
        </div>
      </Card>
    </Page>
  );
}
