import { useState } from "react";
import type { Employee } from "../model.ts";
import { usePortal } from "../store.tsx";
import { profileExtrasFor, saveProfileExtras } from "../data/profileExtras.ts";
import type { ProfileExtras } from "../data/profileExtras.ts";
import { Banner, Field, SubmitButton, useAction } from "./ui.tsx";
import { useProfileCode } from "./ProfileCodeDialog.tsx";
import { API_ENABLED } from "../api/client.ts";
import { apiUpdateOwnProfile, type ApiSelfProfileUpdate } from "../api/syncProfile.ts";
import { getPerson } from "../data/peopleLocal.ts";
import { isMasked } from "../utils/mask.ts";

/** Backend mode: structured address. Street line and postcode arrive masked, so blank means "keep". */
interface ApiAddress {
  line: string;
  city: string;
  postcode: string;
  country: string;
}

/** Backend mode: start from the server record. Masked values start blank (blank = keep). */
function apiStart(personId: string): { extras: ProfileExtras; address: ApiAddress } {
  const p = getPerson(personId);
  const unmasked = (v?: string) => (v && !isMasked(v) ? v : "");
  return {
    extras: {
      personalEmail: unmasked(p?.personalEmail),
      preferredName: p?.preferredName ?? "",
      emergencyName: p?.emergencyName ?? "",
      emergencyRelation: p?.emergencyRelationship ?? "",
      emergencyPhone: unmasked(p?.emergencyPhone),
    },
    address: { line: unmasked(p?.addressLine), city: p?.addressCity ?? "", postcode: unmasked(p?.addressPostcode), country: p?.addressCountry ?? "" },
  };
}

type ProfileDraft = Pick<Employee, "fullName" | "designation" | "mobile" | "email" | "address" | "shiftName" | "shiftHours">;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validPhone(value: string): boolean {
  const phone = value.trim();
  const digits = phone.replace(/\D/g, "").length;
  return /^\+?[\d ]+$/.test(phone) && digits >= 8 && digits <= 15;
}

/** Problems with the employee-editable fields, or null when they are fine. Name and work email are HR-owned. */
function validateDraft(draft: ProfileDraft, extras: ProfileExtras): string | null {
  // Backend mode: an unchanged mobile stays masked and isn't sent.
  if (!(API_ENABLED && isMasked(draft.mobile)) && !validPhone(draft.mobile)) {
    return "Enter a valid mobile number: 8–15 digits, optionally starting with + (spaces allowed).";
  }
  if (extras.personalEmail.trim() && !EMAIL_PATTERN.test(extras.personalEmail.trim())) {
    return "Enter a valid personal email address.";
  }
  const hasEmergency = extras.emergencyName.trim() || extras.emergencyPhone.trim() || extras.emergencyRelation.trim();
  if (hasEmergency) {
    if (!extras.emergencyName.trim()) return "Enter the emergency contact's name.";
    if (!(API_ENABLED && !extras.emergencyPhone.trim()) && !validPhone(extras.emergencyPhone)) {
      return "Enter a valid emergency contact phone: 8–15 digits.";
    }
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
  const { employee, updateProfile } = usePortal();
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [extras, setExtras] = useState<ProfileExtras>(() => (API_ENABLED ? apiStart(employee.id).extras : profileExtrasFor(employee.id)));
  const [apiAddress, setApiAddress] = useState<ApiAddress>(() => apiStart(employee.id).address);
  const code = useProfileCode();
  const saveAction = useAction();

  /** Backend mode: only fields that changed or were typed (masked ones start blank = keep). */
  function apiUpdate(): ApiSelfProfileUpdate {
    const start = apiStart(employee.id);
    const update: ApiSelfProfileUpdate = {
      emergency_name: extras.emergencyName,
      emergency_relationship: extras.emergencyRelation,
      address_city: apiAddress.city,
      address_country: apiAddress.country,
    };
    if (!isMasked(draft.mobile) && draft.mobile.trim() !== employee.mobile) update.mobile = draft.mobile;
    if (extras.personalEmail.trim() && extras.personalEmail.trim() !== start.extras.personalEmail) update.personal_email = extras.personalEmail;
    if (extras.emergencyPhone.trim()) update.emergency_phone = extras.emergencyPhone;
    else if (!extras.emergencyName.trim()) update.emergency_phone = null;
    if (apiAddress.line.trim()) update.address_line = apiAddress.line;
    if (apiAddress.postcode.trim()) update.address_postcode = apiAddress.postcode;
    return update;
  }

  /** Local mode: the personal details that differ from the saved ones (these need a code). */
  function localChanges(): Record<string, unknown> {
    const saved = profileExtrasFor(employee.id);
    const next: Record<string, [string, string]> = {
      mobile: [draft.mobile.trim(), employee.mobile],
      address: [draft.address.trim(), employee.address],
      personalEmail: [extras.personalEmail.trim(), saved.personalEmail],
      emergencyName: [extras.emergencyName.trim(), saved.emergencyName],
      emergencyRelation: [extras.emergencyRelation.trim(), saved.emergencyRelation],
      emergencyPhone: [extras.emergencyPhone.trim(), saved.emergencyPhone],
    };
    return Object.fromEntries(Object.entries(next).filter(([, [a, b]]) => a !== (b ?? "").trim()).map(([k, [a]]) => [k, a]));
  }

  function saveLocal(): string | null {
    // Legal name, work email, designation and shift are HR-owned: always send the current values, never the draft's.
    const error = updateProfile({
      ...draft,
      fullName: employee.fullName,
      email: employee.email,
      designation: employee.designation,
      shiftName: employee.shiftName,
      shiftHours: employee.shiftHours,
      photo: photoFile || undefined,
    });
    if (error) return error;
    // Preferred name is edited under Personal; keep the latest saved value rather than the one loaded with this form.
    saveProfileExtras(employee.id, { ...extras, preferredName: profileExtrasFor(employee.id).preferredName });
    return null;
  }

  async function saveProfile(): Promise<boolean | string> {
    setMessage(null);
    const invalid = validateDraft(draft, extras);
    if (invalid) {
      setMessage({ tone: "err", text: invalid });
      return false;
    }
    const update = API_ENABLED ? apiUpdate() : {};
    const result = await code.start({
      userId: employee.id,
      apiChanges: update,
      localChanges: API_ENABLED ? {} : localChanges(),
      save: (otp) => (API_ENABLED ? apiUpdateOwnProfile(otp ? { ...update, otp_code: otp } : update) : saveLocal()),
      onSaved: () => {
        setMessage({ tone: "ok", text: "Profile updated." });
        onSaved();
      },
    });
    if (typeof result === "string") setMessage({ tone: "err", text: result });
    return result === true;
  }

  return (
    <>
    <form className="identity-edit" onSubmit={saveAction.submit(saveProfile, { success: "Profile saved." })}>
      <div className="form-grid">
        <Field label="Photo">
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => event.target.files?.[0] && onReadPhoto(event.target.files[0])}
          />
          {photoError ? <span className="note err">{photoError}</span> : <span className="note">JPEG, PNG or WebP, up to 5 MB.</span>}
        </Field>
        <Field label="Legal name">
          <input value={employee.fullName} readOnly disabled />
          <span className="note">Use Request correction under Personal.</span>
        </Field>
        <Field label="Work email">
          <input type="email" value={employee.email} readOnly disabled />
          <span className="note">Ask HR to change.</span>
        </Field>
        <Field label="Mobile">
          <input
            type="tel"
            inputMode="tel"
            value={draft.mobile}
            onChange={(event) => setDraft({ ...draft, mobile: event.target.value })}
          />
        </Field>
        <Field label="Personal email">
          <input
            type="email"
            value={extras.personalEmail}
            onChange={(event) => setExtras({ ...extras, personalEmail: event.target.value })}
          />
        </Field>
        {API_ENABLED ? (
          <>
            <Field label="Address" wide>
              <input
                value={apiAddress.line}
                placeholder={getPerson(employee.id)?.addressLine ? "Unchanged" : ""}
                onChange={(event) => setApiAddress({ ...apiAddress, line: event.target.value })}
              />
            </Field>
            <Field label="City">
              <input value={apiAddress.city} onChange={(event) => setApiAddress({ ...apiAddress, city: event.target.value })} />
            </Field>
            <Field label="Postcode">
              <input
                value={apiAddress.postcode}
                placeholder={getPerson(employee.id)?.addressPostcode ? "Unchanged" : ""}
                onChange={(event) => setApiAddress({ ...apiAddress, postcode: event.target.value })}
              />
            </Field>
            <Field label="Country">
              <input value={apiAddress.country} onChange={(event) => setApiAddress({ ...apiAddress, country: event.target.value })} />
            </Field>
          </>
        ) : (
          <Field label="Address" wide>
            <input value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} />
          </Field>
        )}
      </div>

      <h3 className="card-title" style={{ marginTop: 16 }}>Emergency contact</h3>
      <div className="form-grid">
        <Field label="Name">
          <input value={extras.emergencyName} onChange={(event) => setExtras({ ...extras, emergencyName: event.target.value })} />
        </Field>
        <Field label="Relationship">
          <input
            value={extras.emergencyRelation}
            onChange={(event) => setExtras({ ...extras, emergencyRelation: event.target.value })}
          />
        </Field>
        <Field label="Phone">
          <input
            type="tel"
            inputMode="tel"
            value={extras.emergencyPhone}
            placeholder={API_ENABLED && getPerson(employee.id)?.emergencyPhone ? "Unchanged" : ""}
            onChange={(event) => setExtras({ ...extras, emergencyPhone: event.target.value })}
          />
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
        <p className="note">Managed by HR.</p>
      </section>

      <div className="form-actions">
        <SubmitButton action={saveAction} className="btn">
          Save profile
        </SubmitButton>
        <button className="btn-ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <Banner message={message} />
    </form>
    {code.dialog}
    </>
  );
}
