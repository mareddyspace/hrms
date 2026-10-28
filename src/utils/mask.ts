/**
 * Masking for sensitive personal details (phone, personal email, date of birth, address, ID / bank numbers).
 * Same formats as the API (backend/app/services/pii.py). Already-masked values pass through unchanged.
 */

export const DOT = "•";

export type MaskKind = "phone" | "email" | "dob" | "address" | "id";

export function isMasked(value: string | null | undefined): boolean {
  return Boolean(value && value.includes(DOT));
}

/** "+91 98450 22110" → "+91 ••••• 22110" (country code + last 5 digits, or last 4 for short numbers). */
export function maskPhone(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  if (isMasked(v)) return v;
  const digits = v.replace(/\D/g, "");
  let country = v.match(/^\+\d{1,3}(?=[\s\-(])/)?.[0];
  if (!country && v.startsWith("+") && digits.length > 10) country = `+${digits.slice(0, digits.length - 10)}`;
  const local = country ? digits.slice(country.length - 1) : digits;
  if (local.length < 6) return DOT.repeat(4);
  const keep = local.length >= 10 ? 5 : 4;
  return `${country ? `${country} ` : ""}${DOT.repeat(5)} ${local.slice(-keep)}`;
}

/** "babu@gmail.com" → "b•••@gmail.com". */
export function maskEmail(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  if (isMasked(v)) return v;
  const at = v.indexOf("@");
  if (at <= 0 || at === v.length - 1) return DOT.repeat(4);
  return `${v[0]}${DOT.repeat(3)}${v.slice(at)}`;
}

/** "1990-06-14" → "•• ••• 1990" (year only). */
export function maskDob(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  if (isMasked(v)) return v;
  const year = v.match(/\d{4}/)?.[0];
  return year ? `${DOT.repeat(2)} ${DOT.repeat(3)} ${year}` : DOT.repeat(4);
}

/** "12 MG Road, Bengaluru, India" → "Bengaluru, India" (city / country only), else "••••". */
export function maskAddress(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  if (isMasked(v)) return v;
  const parts = v.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 3 ? parts.slice(-2).join(", ") : DOT.repeat(4);
}

/** Tax / national ID, passport, visa or bank account: "•••• 1234". */
export function maskId(value: string | null | undefined): string {
  const v = (value ?? "").replace(/\s/g, "");
  if (!v) return "";
  if (isMasked(v)) return (value ?? "").trim();
  return v.length <= 4 ? DOT.repeat(4) : `${DOT.repeat(4)} ${v.slice(-4)}`;
}

const MASKERS: Record<MaskKind, (value: string | null | undefined) => string> = {
  phone: maskPhone,
  email: maskEmail,
  dob: maskDob,
  address: maskAddress,
  id: maskId,
};

export function maskValue(value: string | null | undefined, kind: MaskKind): string {
  return MASKERS[kind](value);
}
