import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ActionButton,
  DataTable,
  EmptyState,
  FilterBar,
  MetricCard,
  MetricGrid,
  Page,
  StatusBadge,
  Tabs,
  notify,
  useAction,
} from "../components/ui.tsx";
import { activeDelegationFor, covers, onBehalfNote, personLabel } from "../data/delegations.ts";
import { remindApprover } from "../data/teamOverview.ts";
import { plural } from "../model.ts";
import { scopeOf, useApprovalInbox, type ApprovalInboxItem } from "./ApprovalsCenter.tsx";
import "./team.css";

/** Waiting longer than this many days is overdue (shown in red). */
const OVERDUE_DAYS = 2;

type AgeFilter = "any" | "today" | "recent" | "overdue";

/** Open requests: decide (one by one or in bulk) what waits on you, and chase what you've asked for. */
export function WorkflowsPage() {
  const { portal, waiting, mine, nameOf, ageOf, holdOf, currentApprover, today } = useApprovalInbox();
  const { employee } = portal;
  const [params] = useSearchParams();
  const linkedPerson = params.get("person") ?? "";
  const [view, setView] = useState(params.get("tab") === "mine" ? "mine" : "decide");
  const [type, setType] = useState("all");
  const [age, setAge] = useState<AgeFilter>("any");
  const [person, setPerson] = useState(linkedPerson);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bulk = useAction();

  const myOpen = mine.filter((m) => m.open);
  const list = view === "decide" ? waiting : myOpen;
  const types = useMemo(() => [...new Set(list.map((i) => i.kind))].sort(), [list]);
  const requesters = useMemo(
    () => [...new Set(list.map((i) => i.employeeId))].map((id) => ({ id, name: nameOf(id) })).sort((a, b) => a.name.localeCompare(b.name)),
    // nameOf is rebuilt each render; the list drives this
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list],
  );
  const rows = list
    .filter((i) => type === "all" || i.kind === type)
    .filter((i) => view === "mine" || !person || i.employeeId === person)
    .filter((i) => {
      const a = ageOf(i);
      return age === "any" || (age === "today" ? a === 0 : age === "recent" ? a > 0 && a <= OVERDUE_DAYS : a > OVERDUE_DAYS);
    })
    .sort((a, b) => ageOf(b) - ageOf(a));
  const visibleKeys = new Set(rows.map((r) => r.key));
  const picked = [...selected].filter((k) => visibleKeys.has(k));
  const overdue = waiting.filter((i) => ageOf(i) > OVERDUE_DAYS).length;

  const noteFor = (item: ApprovalInboxItem) => {
    const from = holdOf(item).delegatedFrom;
    return from ? onBehalfNote(from) : undefined;
  };

  /** Who the request is with now: the open step's approver, a delegate, or the first available manager. */
  function approverOf(item: ApprovalInboxItem): { id: string; name: string } | undefined {
    const stepped = item.approverIds?.[0];
    if (stepped) return { id: stepped, name: personLabel(stepped) };
    const { first, available } = currentApprover(item.employeeId);
    if (!first) return undefined;
    const d = activeDelegationFor(first.id, today);
    if (d && d.delegateId !== item.employeeId && covers(d, scopeOf(item.kind))) return { id: d.delegateId, name: personLabel(d.delegateId) };
    const who = available ?? first;
    return { id: who.id, name: who.fullName ?? nameOf(who.id) };
  }

  async function approveSelected() {
    const items = rows.filter((r) => picked.includes(r.key));
    let done = 0;
    const errors: string[] = [];
    for (const item of items) {
      const error = await item.decide!("approved", noteFor(item));
      if (error) errors.push(`${nameOf(item.employeeId)} · ${item.kind}: ${error}`);
      else done += 1;
    }
    setSelected(new Set());
    if (!done) return errors[0] ?? "Nothing was approved.";
    if (errors.length) notify(`${plural(done, "request")} approved. ${errors.length} not approved: ${errors[0]}`, "err");
    else notify(`${plural(done, "request")} approved.`);
    return null;
  }

  const ageBadge = (item: ApprovalInboxItem) => {
    const a = ageOf(item);
    const text = a === 0 ? "Today" : plural(a, "day");
    return <StatusBadge status={text} tone={a > OVERDUE_DAYS ? "danger" : a > 0 ? "warn" : "neutral"} literal keepCase />;
  };

  const allPicked = rows.length > 0 && rows.every((r) => selected.has(r.key));

  return (
    <Page title="Workflows & approvals">
      <div className="team-tiles">
      <MetricGrid>
        <MetricCard label="Waiting for you" value={waiting.length} />
        <MetricCard label={`Overdue (over ${OVERDUE_DAYS} days)`} value={overdue} />
        <MetricCard label="Your open requests" value={myOpen.length} />
      </MetricGrid>
      </div>
      <Tabs
        tabs={[
          { id: "decide", label: `To decide (${waiting.length})` },
          { id: "mine", label: `My requests (${myOpen.length})` },
        ]}
        value={view}
        onChange={(next) => {
          setView(next);
          setSelected(new Set());
          setType("all");
        }}
      />
      <FilterBar>
        <label className="field">
          <span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">All types</option>
            {types.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Age</span>
          <select value={age} onChange={(e) => setAge(e.target.value as AgeFilter)}>
            <option value="any">Any age</option>
            <option value="today">Today</option>
            <option value="recent">1–{OVERDUE_DAYS} days</option>
            <option value="overdue">Overdue</option>
          </select>
        </label>
        {view === "decide" && (
          <label className="field">
            <span>Person</span>
            <select value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="">Everyone</option>
              {requesters.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              {person && !requesters.some((p) => p.id === person) && <option value={person}>{nameOf(person)}</option>}
            </select>
          </label>
        )}
        {view === "decide" && (
          <ActionButton
            className="btn"
            action={bulk}
            disabled={picked.length === 0}
            onAction={approveSelected}
            toastError
            doneLabel="Approved"
          >
            {picked.length ? `Approve selected (${picked.length})` : "Approve selected"}
          </ActionButton>
        )}
      </FilterBar>

      <DataTable
        headers={
          view === "decide"
            ? ["", "Type", "Requested by", "Details", "Age", ""]
            : ["Type", "Details", "Waiting with", "Age", ""]
        }
        rows={rows.map((item) =>
          view === "decide"
            ? [
                <input
                  key="c"
                  type="checkbox"
                  aria-label={`Select ${item.kind} from ${nameOf(item.employeeId)}`}
                  checked={selected.has(item.key)}
                  onChange={(e) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(item.key);
                      else next.delete(item.key);
                      return next;
                    })
                  }
                />,
                item.kind,
                nameOf(item.employeeId),
                <span key="d" className="team-name">
                  <span>{item.title}</span>
                  {item.withText && <span className="muted">{item.withText}</span>}
                </span>,
                ageBadge(item),
                <span key="a" className="team-actions">
                  <ActionButton
                    className="btn-ghost btn-tiny"
                    doneLabel={item.approveLabel === "Verify" ? "Verified" : item.approveLabel === "Accept" ? "Accepted" : "Approved"}
                    onAction={() => item.decide!("approved", noteFor(item))}
                    success={`${item.kind} approved for ${nameOf(item.employeeId)}.`}
                    toastError
                  >
                    {item.approveLabel ?? "Approve"}
                  </ActionButton>
                  <ActionButton
                    className="btn-ghost btn-tiny"
                    doneLabel={(item.declineLabel ?? "Send back") === "Send back" ? "Sent back" : "Done"}
                    onAction={() => item.decide!("rejected", noteFor(item))}
                    success={(item.declineLabel ?? "Send back") === "Send back" ? `${item.kind} sent back to ${nameOf(item.employeeId)}.` : `${item.kind}: ${item.declineLabel} for ${nameOf(item.employeeId)}.`}
                    toastError
                  >
                    {item.declineLabel ?? "Send back"}
                  </ActionButton>
                </span>,
              ]
            : (() => {
                const approver = approverOf(item);
                return [
                  item.kind,
                  item.title,
                  approver?.name ?? item.withText ?? "—",
                  ageBadge(item),
                  approver && approver.id !== employee.id ? (
                    <ActionButton
                      key="r"
                      className="btn-ghost btn-tiny"
                      doneLabel="Reminded"
                      busyLabel="Sending…"
                      toastError
                      success={`Reminder sent to ${approver.name}.`}
                      onAction={() =>
                        remindApprover({
                          actor: { id: employee.id, fullName: employee.fullName },
                          approverId: approver.id,
                          approverName: approver.name,
                          requesterId: item.employeeId,
                          requesterName: employee.fullName,
                          kind: item.kind,
                          summary: item.title,
                          requestId: item.key,
                          today,
                        })
                      }
                    >
                      Remind
                    </ActionButton>
                  ) : (
                    ""
                  ),
                ];
              })(),
        )}
        empty={<EmptyState title="Nothing open" description={view === "mine" ? "You have no open requests." : "Nothing is waiting for you."} />}
      />
      {view === "decide" && rows.length > 1 && (
        <p className="muted">
          <button
            type="button"
            className="link-btn"
            onClick={() => setSelected(allPicked ? new Set() : new Set(rows.map((r) => r.key)))}
          >
            {allPicked ? "Clear selection" : `Select all ${rows.length}`}
          </button>
          {" · "}
          <Link to="/approvals">Approvals</Link>
        </p>
      )}
    </Page>
  );
}
