import { listPeople } from "../../data/peopleLocal.ts";
import { todayISO } from "../../model.ts";
import {
  createLocalStore,
  daysBetween,
  isHr,
  isISODate,
  newId,
  relDay,
  type ComplianceActor,
  type ComplianceResult,
} from "./shared.ts";

export const DOC_TYPES = [
  "Passport",
  "Visa",
  "Work permit",
  "Residence ID/Iqama",
  "Emirates ID",
  "BRP/UK right-to-work",
  "Aufenthaltstitel",
  "National ID",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const ISSUING_COUNTRIES = [
  "India",
  "United Arab Emirates",
  "Saudi Arabia",
  "Germany",
  "United Kingdom",
  "United States",
  "Australia",
  "Canada",
  "Egypt",
  "Pakistan",
  "Philippines",
] as const;

export type DocStatus = "Valid" | "Expiring" | "Expired" | "Renewal in progress";
export type Verification = "Pending verification" | "Verified" | "Rejected";

export type IdDocument = {
  id: string;
  personId: string;
  type: DocType;
  number: string;
  issuingCountry: string;
  issueDate: string;
  expiryDate: string;
  sponsor?: string;
  renewalInProgress: boolean;
  recordedExpired: boolean;
  verification: Verification;
  verificationNote?: string;
  verifiedById?: string;
  verifiedOn?: string;
  updatedOn: string;
  updatedById: string;
};

type ImmigrationState = { documents: IdDocument[] };

const SPONSOR_COUNTRIES = ["United Arab Emirates", "Saudi Arabia"];
const SPONSORED_TYPES: DocType[] = ["Visa", "Work permit", "Residence ID/Iqama", "Emirates ID"];
const DEMO_IDS = new Set(["emp-mahesh", "emp-ram", "demo-hr-admin", "demo-recruiter", "demo-hiring-manager", "demo-ceo", "demo-compensation", "demo-admin"]);

export const EXPIRING_WINDOW_DAYS = 90;

export function needsSponsor(type: DocType, issuingCountry: string): boolean {
  return SPONSORED_TYPES.includes(type) && SPONSOR_COUNTRIES.includes(issuingCountry);
}

function seedDoc(
  personId: string,
  type: DocType,
  number: string,
  issuingCountry: string,
  issueDate: string,
  expiryDate: string,
  extra: Partial<IdDocument> = {},
): IdDocument {
  return {
    id: `idd-${personId}-${type.replace(/\W+/g, "").toLowerCase()}`,
    personId,
    type,
    number,
    issuingCountry,
    issueDate,
    expiryDate,
    renewalInProgress: false,
    recordedExpired: expiryDate < todayISO(),
    verification: "Verified",
    verifiedById: "demo-hr-admin",
    verifiedOn: issueDate,
    updatedOn: issueDate,
    updatedById: "demo-hr-admin",
    ...extra,
  };
}

function peopleIn(code: string, count: number): string[] {
  return listPeople()
    .filter((p) => p.countryCode === code && !DEMO_IDS.has(p.id) && p.employmentStatus !== "Terminated")
    .slice(0, count)
    .map((p) => p.id);
}

function defaults(): ImmigrationState {
  const docs: IdDocument[] = [
    seedDoc("emp-mahesh", "Passport", "Z4821937", "India", "2019-03-11", "2029-03-10"),
    seedDoc("emp-mahesh", "Visa", "B1B2-55017342", "United States", "2022-01-05", relDay(64)),
    seedDoc("demo-hr-admin", "Passport", "W9017325", "India", "2018-07-02", "2028-07-01"),
    seedDoc("demo-admin", "Passport", "533829104", "United Kingdom", "2021-05-20", "2031-05-19"),
  ];

  const [ae1, ae2, ae3] = peopleIn("AE", 3);
  if (ae1) {
    docs.push(seedDoc(ae1, "Passport", "P8812094", "India", "2020-02-14", "2030-02-13"));
    docs.push(seedDoc(ae1, "Emirates ID", "784-1990-4821937-2", "United Arab Emirates", "2024-11-02", relDay(22), { sponsor: "Infotech FZ-LLC" }));
    docs.push(seedDoc(ae1, "Visa", "201/2024/7/118204", "United Arab Emirates", "2024-11-01", relDay(21), { sponsor: "Infotech FZ-LLC" }));
  }
  if (ae2) {
    docs.push(seedDoc(ae2, "Passport", "EP7710432", "Egypt", "2017-09-18", relDay(-12)));
    docs.push(seedDoc(ae2, "Emirates ID", "784-1987-1130554-8", "United Arab Emirates", "2023-06-10", relDay(310), { sponsor: "Infotech FZ-LLC" }));
  }
  if (ae3) {
    docs.push(
      seedDoc(ae3, "Work permit", "MOHRE-4419027", "United Arab Emirates", "2024-10-20", relDay(48), {
        sponsor: "Infotech FZ-LLC",
        renewalInProgress: true,
      }),
    );
    docs.push(
      seedDoc(ae3, "Passport", "P3390218", "Philippines", "2022-04-04", "2032-04-03", {
        verification: "Pending verification",
        verifiedById: undefined,
        verifiedOn: undefined,
        updatedOn: relDay(-2),
        updatedById: ae3,
      }),
    );
  }

  const [sa1, sa2] = peopleIn("SA", 2);
  if (sa1) {
    docs.push(seedDoc(sa1, "Residence ID/Iqama", "2398104472", "Saudi Arabia", "2025-01-12", relDay(81), { sponsor: "Infotech Arabia LLC" }));
    docs.push(seedDoc(sa1, "Passport", "K1180397", "Pakistan", "2019-12-01", "2029-11-30"));
  }
  if (sa2) {
    docs.push(seedDoc(sa2, "Residence ID/Iqama", "2471003856", "Saudi Arabia", "2024-08-30", relDay(-5), { sponsor: "Infotech Arabia LLC" }));
  }

  const [de1, de2] = peopleIn("DE", 2);
  if (de1) docs.push(seedDoc(de1, "Aufenthaltstitel", "Y7H40L2K9", "Germany", "2023-03-15", relDay(140)));
  if (de2) docs.push(seedDoc(de2, "National ID", "L01X00T47", "Germany", "2018-05-09", relDay(37)));

  const [gb1, gb2] = peopleIn("GB", 2);
  if (gb1) docs.push(seedDoc(gb1, "BRP/UK right-to-work", "ZU1907752", "United Kingdom", "2021-12-06", relDay(-30)));
  if (gb2) docs.push(seedDoc(gb2, "Passport", "551204873", "United Kingdom", "2016-10-26", relDay(10)));

  return { documents: docs };
}

const store = createLocalStore<ImmigrationState>("kastech.immigration.v1", defaults);

export const subscribeImmigration = store.subscribe;
export const getImmigrationState = store.getState;
export const resetImmigration = store.reset;
export const IMMIGRATION_KEY = store.key;

/* ───────────── Derived status ───────────── */

export function daysToExpiry(doc: Pick<IdDocument, "expiryDate">, today = todayISO()): number {
  return daysBetween(today, doc.expiryDate);
}

export function docStatus(doc: IdDocument, today = todayISO()): DocStatus {
  if (doc.renewalInProgress) return "Renewal in progress";
  const days = daysToExpiry(doc, today);
  if (days < 0) return "Expired";
  if (days <= EXPIRING_WINDOW_DAYS) return "Expiring";
  return "Valid";
}

/* ───────────── Permissions ───────────── */

export function canSeeDocument(actor: ComplianceActor, doc: IdDocument): boolean {
  return doc.personId === actor.id || isHr(actor.role);
}

/** Full document numbers are shown only to HR and the document holder. */
export function canSeeFullNumber(actor: ComplianceActor, doc: IdDocument): boolean {
  return canSeeDocument(actor, doc);
}

export function maskNumber(number: string): string {
  const clean = number.trim();
  return clean.length <= 4 ? "••••" : `•••• ${clean.slice(-4)}`;
}

export function canVerify(actor: ComplianceActor, doc: IdDocument): boolean {
  return isHr(actor.role) && doc.personId !== actor.id;
}

/* ───────────── Mutations ───────────── */

export type DocInput = {
  personId: string;
  type: DocType;
  number: string;
  issuingCountry: string;
  issueDate: string;
  expiryDate: string;
  sponsor: string;
  recordExpired: boolean;
};

function validate(input: DocInput, existing: IdDocument[], editingId?: string): ComplianceResult {
  const today = todayISO();
  const number = input.number.trim().toUpperCase();
  if (!DOC_TYPES.includes(input.type)) return "Choose a document type.";
  if (!number) return "Enter the document number.";
  if (!/^[A-Z0-9][A-Z0-9/-]{3,23}$/.test(number)) return "Document number must be 4–24 letters, digits, dashes or slashes.";
  if (!input.issuingCountry) return "Choose the issuing country.";
  if (input.type === "Emirates ID") {
    if (input.issuingCountry !== "United Arab Emirates") return "An Emirates ID must be issued by the United Arab Emirates.";
    if (!/^784-?\d{4}-?\d{7}-?\d$/.test(number)) return "Emirates ID format is 784-YYYY-NNNNNNN-N.";
  }
  if (input.type === "Residence ID/Iqama") {
    if (!SPONSOR_COUNTRIES.includes(input.issuingCountry)) return "A residence ID / Iqama must be issued by the UAE or Saudi Arabia.";
    if (input.issuingCountry === "Saudi Arabia" && !/^2\d{9}$/.test(number)) return "An Iqama number is 10 digits starting with 2.";
  }
  if (input.type === "BRP/UK right-to-work" && input.issuingCountry !== "United Kingdom") return "A BRP / right-to-work record must be issued by the United Kingdom.";
  if (input.type === "Aufenthaltstitel" && input.issuingCountry !== "Germany") return "An Aufenthaltstitel must be issued by Germany.";
  if (!isISODate(input.issueDate)) return "Enter a valid issue date.";
  if (!isISODate(input.expiryDate)) return "Enter a valid expiry date.";
  if (input.issueDate > today) return "Issue date cannot be in the future.";
  if (input.expiryDate <= input.issueDate) return "Expiry date must be after the issue date.";
  if (daysBetween(input.issueDate, input.expiryDate) > 366 * 15) return "Validity cannot exceed 15 years — check the dates.";
  if (input.expiryDate < today && !input.recordExpired) return "This document has already expired — tick “record expired document” to add it.";
  if (needsSponsor(input.type, input.issuingCountry) && !input.sponsor.trim()) return "Enter the sponsor for UAE / Saudi permits.";
  const duplicate = existing.some(
    (d) => d.id !== editingId && d.type === input.type && d.number.toUpperCase() === number && d.issuingCountry === input.issuingCountry,
  );
  if (duplicate) return "This document is already on record.";
  return null;
}

export function addDocument(actor: ComplianceActor, input: DocInput): ComplianceResult {
  return store.guarded((s) => {
    if (input.personId !== actor.id && !isHr(actor.role)) return "You can only add your own documents.";
    const error = validate(input, s.documents);
    if (error) return error;
    const today = todayISO();
    const byHrForOther = isHr(actor.role) && input.personId !== actor.id;
    s.documents.push({
      id: newId("idd"),
      personId: input.personId,
      type: input.type,
      number: input.number.trim().toUpperCase(),
      issuingCountry: input.issuingCountry,
      issueDate: input.issueDate,
      expiryDate: input.expiryDate,
      sponsor: needsSponsor(input.type, input.issuingCountry) ? input.sponsor.trim() : undefined,
      renewalInProgress: false,
      recordedExpired: input.expiryDate < today,
      verification: byHrForOther ? "Verified" : "Pending verification",
      verifiedById: byHrForOther ? actor.id : undefined,
      verifiedOn: byHrForOther ? today : undefined,
      updatedOn: today,
      updatedById: actor.id,
    });
    return null;
  });
}

export function updateDocument(actor: ComplianceActor, id: string, input: DocInput): ComplianceResult {
  return store.guarded((s) => {
    const row = s.documents.find((d) => d.id === id);
    if (!row) return "Document not found.";
    if (row.personId !== actor.id && !isHr(actor.role)) return "You can only update your own documents.";
    if (input.personId !== row.personId) return "A document cannot be moved to another person.";
    const error = validate(input, s.documents, id);
    if (error) return error;
    const today = todayISO();
    const byHrForOther = isHr(actor.role) && row.personId !== actor.id;
    const renewed = input.expiryDate > row.expiryDate;
    Object.assign(row, {
      type: input.type,
      number: input.number.trim().toUpperCase(),
      issuingCountry: input.issuingCountry,
      issueDate: input.issueDate,
      expiryDate: input.expiryDate,
      sponsor: needsSponsor(input.type, input.issuingCountry) ? input.sponsor.trim() : undefined,
      recordedExpired: input.expiryDate < today,
      renewalInProgress: renewed ? false : row.renewalInProgress,
      verification: byHrForOther ? "Verified" : "Pending verification",
      verificationNote: undefined,
      verifiedById: byHrForOther ? actor.id : undefined,
      verifiedOn: byHrForOther ? today : undefined,
      updatedOn: today,
      updatedById: actor.id,
    } satisfies Partial<IdDocument>);
    return null;
  });
}

export function setRenewalInProgress(actor: ComplianceActor, id: string, value: boolean): ComplianceResult {
  return store.guarded((s) => {
    const row = s.documents.find((d) => d.id === id);
    if (!row) return "Document not found.";
    if (row.personId !== actor.id && !isHr(actor.role)) return "Only the holder or HR can mark a renewal.";
    row.renewalInProgress = value;
    row.updatedOn = todayISO();
    row.updatedById = actor.id;
    return null;
  });
}

export function verifyDocument(actor: ComplianceActor, id: string, decision: "Verified" | "Rejected", note = ""): ComplianceResult {
  return store.guarded((s) => {
    const row = s.documents.find((d) => d.id === id);
    if (!row) return "Document not found.";
    if (!canVerify(actor, row)) return row.personId === actor.id ? "You cannot verify your own document." : "Only HR can verify documents.";
    if (row.verification !== "Pending verification") return "This document is not waiting for verification.";
    if (decision === "Rejected" && !note.trim()) return "Add a reason for returning the document.";
    row.verification = decision;
    row.verificationNote = note.trim() || undefined;
    row.verifiedById = actor.id;
    row.verifiedOn = todayISO();
    return null;
  });
}

export function removeDocument(actor: ComplianceActor, id: string): ComplianceResult {
  return store.guarded((s) => {
    const row = s.documents.find((d) => d.id === id);
    if (!row) return "Document not found.";
    const ownPending = row.personId === actor.id && row.verification !== "Verified";
    if (!ownPending && !(isHr(actor.role) && row.personId !== actor.id)) {
      return "Verified documents can only be removed by HR.";
    }
    s.documents = s.documents.filter((d) => d.id !== id);
    return null;
  });
}

/** Documents for the data export — only the holder's own. */
export function documentsForPerson(personId: string): IdDocument[] {
  return getImmigrationState().documents.filter((d) => d.personId === personId);
}
