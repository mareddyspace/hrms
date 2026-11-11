import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, Search, UserRound, LayoutGrid } from "lucide-react";
import { COMPANY_NAME } from "../brand.ts";
import { personFilterFor, useAccessVersion } from "../data/accessControl.ts";
import { listPeople, subscribePeople } from "../data/peopleLocal.ts";
import { canViewPeopleDirectory, getPeopleListScope } from "../data/peoplePermissions.ts";
import { policiesForPerson } from "../data/policyLibrary.ts";
import { directoryFieldLevel } from "../data/rbac.ts";
import type { CountryCode } from "../model.ts";
import type { NavLink as SideNavLink } from "../nav.ts";
import { usePortal } from "../store.tsx";
import "../styles/calendar-people.css";

type Hit = { key: string; kind: "page" | "person" | "policy"; label: string; detail: string; to: string; score: number };

const KIND_LABEL: Record<Hit["kind"], string> = { page: "Pages", person: "People", policy: "Policies" };
const LIMITS: Record<Hit["kind"], number> = { page: 6, person: 8, policy: 4 };

/** Lower is better: exact, then starts-with, then word start, then anywhere. -1 = no match. */
function rank(text: string, needle: string): number {
  const t = text.toLowerCase();
  if (!needle) return -1;
  if (t === needle) return 0;
  if (t.startsWith(needle)) return 1;
  if (t.split(/[\s/&·,-]+/).some((w) => w.startsWith(needle))) return 2;
  return t.includes(needle) ? 3 : -1;
}

function best(texts: (string | undefined)[], needle: string): number {
  let out = -1;
  for (const text of texts) {
    if (!text) continue;
    const r = rank(text, needle);
    if (r >= 0 && (out < 0 || r < out)) out = r;
  }
  return out;
}

/**
 * The top bar's search: people (name, ID, email, title; only those you may see), pages from your menu and the
 * policies that apply to you. Arrow keys move, Enter opens, Escape closes; Ctrl+K or "/" jumps to the box.
 */
export function GlobalSearch({ links }: { links: { link: SideNavLink; group: string }[] }) {
  const { demoProfile, employee } = usePortal();
  const navigate = useNavigate();
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const accessVersion = useAccessVersion();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Ctrl/Cmd+K anywhere, or "/" when not typing in a field.
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      } else if (event.key === "/" && !typing) {
        event.preventDefault();
        input.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const visiblePeople = useMemo(() => {
    if (!canViewPeopleDirectory(demoProfile)) return people.filter((p) => p.id === employee.id);
    const scope = getPeopleListScope(demoProfile);
    if (scope === "self") return people.filter((p) => p.id === employee.id);
    const basic = directoryFieldLevel(demoProfile) === "basic";
    const canSee = personFilterFor(demoProfile.id);
    return people.filter((p) => (basic ? p.employmentStatus !== "Terminated" : canSee(p)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, demoProfile, employee.id, accessVersion]);

  const policies = useMemo(() => {
    if (!links.some(({ link }) => link.to === "/policies")) return [];
    try {
      return policiesForPerson(
        {
          countryCode: (employee.countryCode ?? "IN") as CountryCode,
          legalEntity: employee.legalEntity,
          role: employee.role,
          employmentType: employee.employmentType,
        },
        { holidays: [] },
      );
    } catch {
      return [];
    }
  }, [links, employee.countryCode, employee.legalEntity, employee.role, employee.employmentType]);

  const hits = useMemo((): Hit[] => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const out: Hit[] = [];
    const seen = new Set<string>();
    for (const { link, group } of links) {
      if (seen.has(link.to)) continue;
      const score = best([link.label, group], needle);
      if (score < 0) continue;
      seen.add(link.to);
      out.push({ key: `page-${link.to}`, kind: "page", label: link.label, detail: group, to: link.to, score });
    }
    for (const p of visiblePeople) {
      const score = best([p.fullName, p.preferredName, p.employeeCode, p.email, p.designation], needle);
      if (score < 0) continue;
      out.push({
        key: `person-${p.id}`,
        kind: "person",
        label: p.fullName,
        detail: [p.designation, p.employeeCode, p.department].filter(Boolean).join(" · "),
        to: p.id === employee.id ? "/info" : `/directory/${p.id}`,
        score,
      });
    }
    for (const policy of policies) {
      const score = best([policy.title, policy.category], needle);
      if (score < 0) continue;
      out.push({ key: `policy-${policy.id}`, kind: "policy", label: policy.title, detail: policy.category, to: `/policies?policy=${encodeURIComponent(policy.id)}`, score });
    }
    const order: Hit["kind"][] = ["person", "page", "policy"];
    return order.flatMap((kind) =>
      out
        .filter((h) => h.kind === kind)
        .sort((a, b) => a.score - b.score || a.label.localeCompare(b.label))
        .slice(0, LIMITS[kind]),
    );
  }, [query, links, visiblePeople, policies, employee.id]);

  useEffect(() => setActive(0), [query]);

  function go(hit: Hit | undefined) {
    if (!hit) return;
    navigate(hit.to);
    setQuery("");
    setOpen(false);
    input.current?.blur();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (hits.length ? (i + 1) % hits.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(hits[active]);
    } else if (event.key === "Escape") {
      if (query) setQuery("");
      else input.current?.blur();
      setOpen(false);
    }
  }

  const showList = open && query.trim().length > 0;
  let lastKind: Hit["kind"] | null = null;

  return (
    <div className="topbar-search gsearch" role="search">
      <Search size={18} aria-hidden />
      <input
        ref={input}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
        placeholder={`Search ${COMPANY_NAME}…`}
        aria-label="Global search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && hits[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
      />
      <kbd className="gsearch-kbd" aria-hidden>
        Ctrl K
      </kbd>
      {showList && (
        <ul className="gsearch-list" id={listId} role="listbox" aria-label="Search results">
          {hits.length === 0 && <li className="gsearch-empty">No matches</li>}
          {hits.map((hit, index) => {
            const heading = hit.kind !== lastKind ? KIND_LABEL[hit.kind] : null;
            lastKind = hit.kind;
            return (
              <li key={hit.key} role="presentation">
                {heading && <span className="gsearch-group">{heading}</span>}
                <button
                  type="button"
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? "gsearch-item active" : "gsearch-item"}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => go(hit)}
                  tabIndex={-1}
                >
                  <span className="gsearch-ico" aria-hidden>
                    {hit.kind === "person" ? <UserRound size={15} /> : hit.kind === "page" ? <LayoutGrid size={15} /> : <FileText size={15} />}
                  </span>
                  <span className="gsearch-text">
                    <strong>{hit.label}</strong>
                    {hit.detail && <small>{hit.detail}</small>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
