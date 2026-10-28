/** Receipt files for expense claims, kept in this browser (IndexedDB, with localStorage as a fallback). */
import { uid, type ExpenseReceipt } from "../model.ts";

export const RECEIPT_MAX_BYTES = 1.5 * 1024 * 1024;
const DB_NAME = "kastech.receipts";
const STORE = "files";
const FALLBACK_PREFIX = "kastech.receipt.";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Checks type and size; returns an error message or null. */
export function receiptFileError(file: File): string | null {
  const okType = file.type.startsWith("image/") || file.type === "application/pdf";
  if (!okType) return "Receipts must be an image or a PDF.";
  if (file.size > RECEIPT_MAX_BYTES) return "Receipt is too large (up to 1.5 MB).";
  return null;
}

/** Saves the file and returns its details for the claim. */
export async function saveReceipt(file: File): Promise<ExpenseReceipt> {
  const error = receiptFileError(file);
  if (error) throw new Error(error);
  const dataUrl = await readAsDataUrl(file);
  const meta: ExpenseReceipt = { id: uid("rcpt"), name: file.name, type: file.type, size: file.size };
  const db = await openDb();
  if (db) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(dataUrl, meta.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return meta;
  }
  try {
    localStorage.setItem(FALLBACK_PREFIX + meta.id, dataUrl);
  } catch {
    throw new Error("Couldn't save the receipt in this browser.");
  }
  return meta;
}

export async function loadReceipt(id: string): Promise<string | null> {
  const db = await openDb();
  if (db) {
    const value = await new Promise<unknown>((resolve) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    if (typeof value === "string") return value;
  }
  try {
    return localStorage.getItem(FALLBACK_PREFIX + id);
  } catch {
    return null;
  }
}

/** Opens the receipt in a new tab (or downloads it). Returns an error message or null. */
export async function openReceipt(receipt: ExpenseReceipt, download = false): Promise<string | null> {
  const dataUrl = await loadReceipt(receipt.id);
  if (!dataUrl) return "Receipt file isn't available in this browser.";
  const blob = await (await fetch(dataUrl)).blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  if (download) link.download = receipt.name;
  else link.target = "_blank";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return null;
}
