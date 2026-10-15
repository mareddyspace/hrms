import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Banner, Card, Field, LeaveTable, Page, StatusPill } from "../components/ui.tsx";
import type { LeaveCode } from "../model.ts";
import { formatShortDate, holidaySet, workingDays } from "../model.ts";
import { usePortal } from "../store.tsx";

export function LeavePage() {
  const portal = usePortal();
  const { leaveTable, state, employee, applyLeave, setLeaveStatus } = portal;
  const years = useMemo(() => {
    const set = new Set<number>([new Date().getFullYear()]);
    for (const request of state.leaveRequests) {
      if (request.employeeId === employee.id) set.add(Number(request.from.slice(0, 4)));
    }
    return [...set].sort((a, b) => b - a);
  }, [employee.id, state.leaveRequests]);
  const [year, setYear] = useState(years[0] ?? new Date().getFullYear());
  const [code, setCode] = useState<LeaveCode>("pto");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const days = from && to ? workingDays(from, to, holidaySet(state.holidays)) : 0;
  const requests = state.leaveRequests.filter(
    (request) => request.employeeId === employee.id && request.from.startsWith(String(year)),
  );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const error = await applyLeave({ code, from, to, reason });
    setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Leave request submitted. A manager must approve it." });
    if (!error) {
      setReason("");
      setFrom("");
      setTo("");
    }
  }

  return (
    <Page title="Leave & Absence" subtitle="Balances, apply leave, and your request history. Balances update when a manager approves.">
      <div className="year-bar" role="tablist" aria-label="Leave year">
        {years.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={item === year}
            className={item === year ? "year-chip active" : "year-chip"}
            onClick={() => setYear(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="leave-layout">
        <div className="leave-main">
          <Card title={`Leave balance · ${year}`}>
            <LeaveTable rows={leaveTable} showPending />
            <p className="note">Types include privilege, casual, sick, WFH, emergency, bereavement, and leave without pay.</p>
          </Card>
          <Card title={`My requests · ${year}`}>
            <div className="table-scroll">
              <table className="data requests">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Dates</th>
                    <th>Days</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {requests.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        No leave requests in {year}.
                      </td>
                    </tr>
                  )}
                  {requests.map((request) => {
                    const policy = leaveTable.find((row) => row.code === request.code);
                    const count = workingDays(request.from, request.to, holidaySet(state.holidays));
                    return (
                      <tr key={request.id}>
                        <td>{policy?.name ?? request.code}</td>
                        <td>
                          {formatShortDate(request.from)} – {formatShortDate(request.to)}
                        </td>
                        <td>{count}</td>
                        <td>{request.reason}</td>
                        <td>
                          <StatusPill status={request.status} />
                        </td>
                        <td>
                          {request.status === "pending" && (
                            <button
                              className="btn-ghost btn-tiny"
                              type="button"
                              onClick={async () => {
                                const error = await setLeaveStatus(request.id, "withdrawn");
                                if (error) setMessage({ tone: "err", text: error });
                              }}
                            >
                              Withdraw
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
        <Card title="Apply Leave">
          <form onSubmit={onSubmit}>
            <div className="form-grid">
              <Field label="Leave type" wide>
                <select value={code} onChange={(event) => setCode(event.target.value as LeaveCode)}>
                  {leaveTable.map((row) => (
                    <option key={row.code} value={row.code}>
                      {row.name} · {row.available} available
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="From">
                <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required />
              </Field>
              <Field label="To">
                <input type="date" value={to} onChange={(event) => setTo(event.target.value)} required />
              </Field>
              <Field label="Reason" wide>
                <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
              </Field>
            </div>
            <p className="note">Working days in this range: {days}. Weekends and holidays are skipped.</p>
            <div className="form-actions">
              <button className="btn" type="submit">
                Submit request
              </button>
            </div>
            <Banner message={message} />
          </form>
        </Card>
      </div>
    </Page>
  );
}
