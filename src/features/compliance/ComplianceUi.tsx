import { useId, useMemo, useState, useSyncExternalStore } from "react";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";

type Tone = "ok" | "warn" | "danger" | "info" | "neutral";

const TONES: Record<string, Tone> = {
  Valid: "ok",
  Verified: "ok",
  Clear: "ok",
  Completed: "ok",
  Resolved: "ok",
  Expiring: "warn",
  "Pending verification": "warn",
  "In progress": "warn",
  Investigating: "warn",
  Open: "info",
  "Renewal in progress": "info",
  "Awaiting consent": "neutral",
  "Not started": "neutral",
  Closed: "neutral",
  Withdrawn: "neutral",
  Incomplete: "warn",
  Expired: "danger",
  Rejected: "danger",
  Discrepancy: "danger",
  "Needs review": "danger",
  "Unable to verify": "warn",
  Overdue: "danger",
  "Closed (manual)": "ok",
};

export function toneFor(status: string): Tone {
  return TONES[status] ?? "neutral";
}

/** Searchable person picker over the people directory. Calls onChange with the person id ("" when unresolved). */
export function PersonPicker({
  value,
  onChange,
  excludeId,
  placeholder = "Search by name or employee ID",
}: {
  value: string;
  onChange: (id: string) => void;
  excludeId?: string;
  placeholder?: string;
}) {
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const listId = useId();
  const labelFor = (id: string) => {
    const p = people.find((x) => x.id === id);
    return p ? `${p.fullName} · ${p.employeeCode}` : "";
  };
  const [text, setText] = useState(() => labelFor(value));
  const options = useMemo(() => {
    const q = text.trim().toLowerCase();
    return people
      .filter((p) => p.id !== excludeId && p.employmentStatus !== "Terminated")
      .filter((p) => !q || p.fullName.toLowerCase().includes(q) || p.employeeCode.toLowerCase().includes(q))
      .slice(0, 40);
  }, [people, text, excludeId]);

  return (
    <>
      <input
        list={listId}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          const match = people.find((p) => p.id !== excludeId && `${p.fullName} · ${p.employeeCode}` === next);
          onChange(match?.id ?? "");
        }}
      />
      <datalist id={listId}>
        {options.map((p) => (
          <option key={p.id} value={`${p.fullName} · ${p.employeeCode}`}>
            {p.countryName} · {p.department}
          </option>
        ))}
      </datalist>
    </>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="cmp-switch" onClick={() => onChange(!checked)} />;
}
