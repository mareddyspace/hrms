import { canApproveTeam, todayISO, TIMEZ_COUNTRIES } from "../../model.ts";
import { DEMO_ACCOUNTS, findDemoById, managementChain } from "../../demoAccounts.ts";
import {
  createStore,
  daysBetween,
  fmt,
  isHrOrAdmin,
  isISODate,
  keepArrays,
  newId,
  notify,
  type WorkforceActor,
  type WorkforceResult,
} from "./workforceShared.ts";

const KEY = "kastech.contractors.v1";
const ROUTE = "/workforce/contractors";
export const ENDING_SOON_DAYS = 30;

export interface Vendor {
  id: string;
  name: string;
  countryCode: string;
  contactEmail: string;
  contractStart: string;
  contractEnd: string;
  currency: string;
}

/** Contingent worker — not an employee, so never part of leave, payroll or performance. */
export interface Contractor {
  id: string;
  name: string;
  vendorId: string;
  managerId: string;
  project: string;
  startDate: string;
  endDate: string;
  dailyRate: number;
}

export interface ExtensionRequest {
  id: string;
  contractorId: string;
  requestedById: string;
  requestedByName: string;
  currentEnd: string;
  newEnd: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requestedOn: string;
  decidedByName?: string;
  decidedOn?: string;
  decisionNote?: string;
}

interface ContractorState {
  vendors: Vendor[];
  contractors: Contractor[];
  extensions: ExtensionRequest[];
}

function defaults(): ContractorState {
  return {
    vendors: [
      { id: "vd-nimbus", name: "Nimbus Staffing", countryCode: "IN", contactEmail: "accounts@nimbusstaffing.in", contractStart: "2026-01-01", contractEnd: "2027-03-31", currency: "INR" },
      { id: "vd-brightlane", name: "Brightlane Consulting", countryCode: "GB", contactEmail: "contracts@brightlane.co.uk", contractStart: "2026-04-01", contractEnd: "2026-12-31", currency: "GBP" },
    ],
    contractors: [
      { id: "ctr-arjun", name: "Arjun Verma", vendorId: "vd-nimbus", managerId: "emp-ram", project: "Payments revamp", startDate: "2026-05-01", endDate: "2026-11-10", dailyRate: 9000 },
      { id: "ctr-meera", name: "Meera Iyer", vendorId: "vd-nimbus", managerId: "emp-ram", project: "Mobile app QA", startDate: "2026-07-01", endDate: "2027-01-31", dailyRate: 8500 },
      { id: "ctr-tom", name: "Tom Fletcher", vendorId: "vd-brightlane", managerId: "demo-admin", project: "Cloud migration", startDate: "2026-04-15", endDate: "2026-09-30", dailyRate: 450 },
      { id: "ctr-lena", name: "Lena Hart", vendorId: "vd-brightlane", managerId: "demo-hiring-manager", project: "Product discovery", startDate: "2026-06-01", endDate: "2026-11-06", dailyRate: 520 },
    ],
    extensions: [],
  };
}

const store = createStore<ContractorState>(KEY, defaults, keepArrays);

export const subscribeContractors = store.subscribe;
/** Stable snapshot for useSyncExternalStore. */
export const getContractorState = store.getState;

export type ContractorStatus = "Upcoming" | "Active" | "Ending soon" | "Ended";

export function contractorStatus(c: Pick<Contractor, "startDate" | "endDate">, today = todayISO()): ContractorStatus {
  if (c.endDate < today) return "Ended";
  if (daysBetween(today, c.endDate) <= ENDING_SOON_DAYS) return "Ending soon";
  if (c.startDate > today) return "Upcoming";
  return "Active";
}

export function canManageVendors(role: WorkforceActor["role"]): boolean {
  return isHrOrAdmin(role);
}

/** People who can own contractors: line managers (not HR or platform admins). */
export function assignableManagers() {
  return DEMO_ACCOUNTS.filter((a) => canApproveTeam(a.role) && !isHrOrAdmin(a.role));
}

/** Who approves an extension: the line manager of the contractor's manager. Undefined at the top (the CEO). */
export function extensionApproverId(managerId: string): string | undefined {
  return managementChain(managerId)[0]?.id;
}

export function canDecideExtension(actor: WorkforceActor, ext: ExtensionRequest, state: ContractorState = getContractorState()): boolean {
  if (ext.status !== "pending" || ext.requestedById === actor.id) return false;
  const c = state.contractors.find((x) => x.id === ext.contractorId);
  return Boolean(c && extensionApproverId(c.managerId) === actor.id);
}

export const CURRENCIES: string[] = [...new Set(TIMEZ_COUNTRIES.map((c) => c.currency as string))];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function vendorById(id: string, state: ContractorState = getContractorState()): Vendor | undefined {
  return state.vendors.find((v) => v.id === id);
}

/** Contractors this actor may see: all for HR/admin, their own for managers. */
export function visibleContractors(actor: WorkforceActor, state: ContractorState = getContractorState()): Contractor[] {
  const list = canManageVendors(actor.role) ? state.contractors : state.contractors.filter((c) => c.managerId === actor.id);
  const order: Record<ContractorStatus, number> = { "Ending soon": 0, Active: 1, Upcoming: 2, Ended: 3 };
  return [...list].sort((a, b) => order[contractorStatus(a)] - order[contractorStatus(b)] || a.endDate.localeCompare(b.endDate));
}

/** Contracts ending within 30 days that this actor should hear about. */
export function endingSoonFor(actor: WorkforceActor, state: ContractorState = getContractorState()): Contractor[] {
  return visibleContractors(actor, state).filter((c) => contractorStatus(c) === "Ending soon");
}

// ---------- vendors ----------

export type VendorInput = Omit<Vendor, "id"> & { id?: string };

export function saveVendor(actor: WorkforceActor, input: VendorInput): WorkforceResult {
  if (!canManageVendors(actor.role)) return "Only HR or admins can manage vendors.";
  const name = input.name.trim();
  const email = input.contactEmail.trim();
  if (name.length < 2) return "Enter the vendor name.";
  if (name.length > 80) return "Vendor name must be 80 characters or fewer.";
  if (!TIMEZ_COUNTRIES.some((c) => c.code === input.countryCode)) return "Pick a country.";
  if (!EMAIL_RE.test(email)) return "Enter a valid contact email.";
  if (!isISODate(input.contractStart) || !isISODate(input.contractEnd)) return "Enter contract start and end dates.";
  if (input.contractEnd <= input.contractStart) return "Contract end must be after the start.";
  if (!CURRENCIES.includes(input.currency)) return "Pick a rate card currency.";
  return store.mutate((s) => {
    if (s.vendors.some((v) => v.id !== input.id && v.name.toLowerCase() === name.toLowerCase())) return `A vendor called "${name}" already exists.`;
    if (input.id) {
      const vendor = s.vendors.find((v) => v.id === input.id);
      if (!vendor) return "That vendor no longer exists.";
      const outside = s.contractors.find(
        (c) => c.vendorId === vendor.id && (c.startDate < input.contractStart || c.endDate > input.contractEnd),
      );
      if (outside) return `${outside.name}'s dates (${fmt(outside.startDate)} – ${fmt(outside.endDate)}) fall outside the new contract.`;
      if (vendor.currency !== input.currency && s.contractors.some((c) => c.vendorId === vendor.id)) {
        return "Currency can't change while contractors are on this vendor's rate card.";
      }
      Object.assign(vendor, { ...input, name, contactEmail: email });
    } else {
      s.vendors.push({ ...input, id: newId("vd"), name, contactEmail: email });
    }
    return null;
  });
}

export function removeVendor(actor: WorkforceActor, id: string): WorkforceResult {
  if (!canManageVendors(actor.role)) return "Only HR or admins can manage vendors.";
  return store.mutate((s) => {
    const vendor = s.vendors.find((v) => v.id === id);
    if (!vendor) return "That vendor no longer exists.";
    const count = s.contractors.filter((c) => c.vendorId === id).length;
    if (count) return `${vendor.name} still has ${count} contractor${count === 1 ? "" : "s"} — remove them first.`;
    s.vendors = s.vendors.filter((v) => v.id !== id);
    return null;
  });
}

// ---------- contractors ----------

export type ContractorInput = Omit<Contractor, "id"> & { id?: string };

export function saveContractor(actor: WorkforceActor, input: ContractorInput): WorkforceResult {
  if (!canManageVendors(actor.role)) return "Only HR or admins can manage contractors.";
  const name = input.name.trim();
  const project = input.project.trim();
  if (name.length < 2) return "Enter the contractor's name.";
  if (project.length < 2) return "Enter the project.";
  const manager = findDemoById(input.managerId);
  if (!manager || !canApproveTeam(manager.role) || isHrOrAdmin(manager.role)) return "Pick a line manager.";
  if (!isISODate(input.startDate) || !isISODate(input.endDate)) return "Enter start and end dates.";
  if (input.endDate <= input.startDate) return "End date must be after the start date.";
  if (!Number.isFinite(input.dailyRate) || input.dailyRate <= 0) return "Daily rate must be more than 0.";
  if (Math.round(input.dailyRate * 100) !== input.dailyRate * 100) return "Daily rate can have at most 2 decimals.";
  return store.mutate((s) => {
    const vendor = s.vendors.find((v) => v.id === input.vendorId);
    if (!vendor) return "Pick a vendor.";
    if (input.startDate < vendor.contractStart || input.endDate > vendor.contractEnd) {
      return `Dates must sit within ${vendor.name}'s contract (${fmt(vendor.contractStart)} – ${fmt(vendor.contractEnd)}).`;
    }
    const record = { ...input, name, project };
    if (input.id) {
      const existing = s.contractors.find((c) => c.id === input.id);
      if (!existing) return "That contractor no longer exists.";
      if (s.extensions.some((e) => e.contractorId === existing.id && e.status === "pending") && existing.endDate !== input.endDate) {
        return "An extension is pending — decide it before changing the end date.";
      }
      Object.assign(existing, record);
    } else {
      s.contractors.push({ ...record, id: newId("ctr") });
    }
    if (input.managerId !== actor.id) {
      notify(input.managerId, input.id ? "Contractor updated" : "Contractor assigned", `${name} (${vendor.name}) on ${project}, until ${fmt(input.endDate)}.`, ROUTE);
    }
    return null;
  });
}

export function removeContractor(actor: WorkforceActor, id: string): WorkforceResult {
  if (!canManageVendors(actor.role)) return "Only HR or admins can manage contractors.";
  return store.mutate((s) => {
    if (!s.contractors.some((c) => c.id === id)) return "That contractor no longer exists.";
    s.contractors = s.contractors.filter((c) => c.id !== id);
    s.extensions = s.extensions.filter((e) => e.contractorId !== id);
    return null;
  });
}

// ---------- extensions ----------

export function requestExtension(actor: WorkforceActor, contractorId: string, newEnd: string, reason: string): WorkforceResult {
  const why = reason.trim();
  if (!isISODate(newEnd)) return "Pick the new end date.";
  if (why.length < 3) return "Add a short reason.";
  return store.mutate((s) => {
    const c = s.contractors.find((x) => x.id === contractorId);
    if (!c) return "That contractor no longer exists.";
    if (c.managerId !== actor.id) return "Only the contractor's manager can request an extension.";
    if (contractorStatus(c) === "Ended") return "This contract has ended. Ask HR to set up a new one.";
    if (newEnd <= c.endDate) return `New end must be after the current end (${fmt(c.endDate)}).`;
    const vendor = s.vendors.find((v) => v.id === c.vendorId);
    if (!vendor) return "The vendor for this contractor no longer exists.";
    if (newEnd > vendor.contractEnd) return `New end can't go past ${vendor.name}'s contract end (${fmt(vendor.contractEnd)}).`;
    if (s.extensions.some((e) => e.contractorId === c.id && e.status === "pending")) return "There's already a pending extension for this contractor.";
    const approverId = extensionApproverId(actor.id);
    const ext: ExtensionRequest = {
      id: newId("ext"),
      contractorId: c.id,
      requestedById: actor.id,
      requestedByName: actor.fullName,
      currentEnd: c.endDate,
      newEnd,
      reason: why,
      status: "pending",
      requestedOn: todayISO(),
    };
    if (!approverId) {
      // No one above the requester (the CEO): the extension applies straight away.
      ext.status = "approved";
      ext.decidedByName = actor.fullName;
      ext.decidedOn = todayISO();
      c.endDate = newEnd;
    } else {
      notify(approverId, "Contract extension request", `${actor.fullName} asks to extend ${c.name} to ${fmt(newEnd)}.`, ROUTE);
    }
    s.extensions.unshift(ext);
    return null;
  });
}

export function cancelExtension(actor: WorkforceActor, id: string): WorkforceResult {
  return store.mutate((s) => {
    const ext = s.extensions.find((e) => e.id === id);
    if (!ext) return "That request no longer exists.";
    if (ext.requestedById !== actor.id) return "Only the requester can cancel.";
    if (ext.status !== "pending") return "This request is already closed.";
    ext.status = "cancelled";
    ext.decidedOn = todayISO();
    return null;
  });
}

export function decideExtension(actor: WorkforceActor, id: string, approve: boolean, note = ""): WorkforceResult {
  return store.mutate((s) => {
    const ext = s.extensions.find((e) => e.id === id);
    if (!ext) return "That request no longer exists.";
    if (ext.status !== "pending") return "This request is already closed.";
    if (ext.requestedById === actor.id) return "You can't approve your own request.";
    if (!canDecideExtension(actor, ext, s)) return "Only the requester's line manager can decide this extension.";
    if (!approve && note.trim().length < 3) return "Add a reason for rejecting.";
    const c = s.contractors.find((x) => x.id === ext.contractorId);
    if (!c) return "That contractor no longer exists.";
    if (approve) {
      const vendor = s.vendors.find((v) => v.id === c.vendorId);
      if (!vendor) return "The vendor for this contractor no longer exists.";
      if (ext.newEnd > vendor.contractEnd) return `New end is past ${vendor.name}'s contract end (${fmt(vendor.contractEnd)}).`;
      if (ext.newEnd <= c.endDate) return "The contract already runs past the requested date.";
      if (c.endDate < todayISO()) return "This contract has already ended.";
      c.endDate = ext.newEnd;
    }
    ext.status = approve ? "approved" : "rejected";
    ext.decidedByName = actor.fullName;
    ext.decidedOn = todayISO();
    ext.decisionNote = note.trim() || undefined;
    notify(
      ext.requestedById,
      approve ? "Extension approved" : "Extension rejected",
      approve ? `${c.name} now runs until ${fmt(ext.newEnd)}.` : `${c.name}'s extension was rejected: ${ext.decisionNote}`,
      ROUTE,
    );
    return null;
  });
}
