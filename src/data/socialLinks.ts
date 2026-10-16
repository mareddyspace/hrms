/** Professional links people add to their own profile (currently LinkedIn), kept per person in browser storage. */

const KEY = "kastech.profile.links.v1";

type LinksState = Record<string, { linkedin?: string }>;

let cache: LinksState | null = null;
const listeners = new Set<() => void>();

function read(): LinksState {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as LinksState) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function subscribeLinks(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot for useSyncExternalStore. */
export function getLinksState(): LinksState {
  if (!cache) cache = read();
  return cache;
}

/**
 * Accepts "linkedin.com/in/name", "www.linkedin.com/in/name/" or a full https URL and returns the
 * canonical https://www.linkedin.com/in/<name> form, or null when it is not a LinkedIn profile address.
 */
export function normalizeLinkedIn(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const match = url.pathname.match(/^\/in\/([A-Za-z0-9\-_%]{3,100})\/?$/);
  if (!match) return null;
  return `https://www.linkedin.com/in/${match[1]}`;
}

/** Saves (or clears, with an empty string) a person's LinkedIn. Returns an error message or null. */
export function setLinkedIn(personId: string, input: string): string | null {
  const next = { ...getLinksState() };
  if (!input.trim()) {
    next[personId] = { ...next[personId], linkedin: undefined };
  } else {
    const url = normalizeLinkedIn(input);
    if (!url) return "Enter a LinkedIn profile address, like linkedin.com/in/your-name.";
    next[personId] = { ...next[personId], linkedin: url };
  }
  cache = next;
  localStorage.setItem(KEY, JSON.stringify(next));
  listeners.forEach((fn) => fn());
  return null;
}
