import { useState, useSyncExternalStore } from "react";
import { ActionButton, Banner, Card, DataTable, Dialog, EmptyState, Field, MetricCard, MetricGrid, Page, StatusBadge } from "../../components/ui.tsx";
import { formatShortDate, todayISO } from "../../model.ts";
import { getTalentState, subscribeTalent } from "../../data/talentLocal.ts";
import {
  BGV_VENDORS,
  CHECK_STATUSES,
  canEditRecord,
  canManageBgv,
  canReadAllBgv,
  getBgvState,
  isSubject,
  overallResult,
  recordConsent,
  removeVerification,
  startVerification,
  subscribeBgv,
  updateCheck,
  type BgvCheck,
  type BgvRecord,
  type CheckPatch,
  type CheckStatus,
} from "./bgvStore.ts";
import { personName, type ComplianceActor } from "./shared.ts";
import { PersonPicker, toneFor } from "./ComplianceUi.tsx";
import { useComplianceActor } from "./useActor.ts";
import "./compliance.css";

type Msg = { tone: "ok" | "err" | "warn" | "info"; text: string } | null;

const DONE: CheckStatus[] = ["Clear", "Discrepancy", "Unable to verify"];

export function BackgroundChecksPage() {
  const actor = useComplianceActor();
  const state = useSyncExternalStore(subscribeBgv, getBgvState, getBgvState);
  const talent = useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
  const [msg, setMsg] = useState<Msg>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [pickerKey, setPickerKey] = useState(0);

  const readAll = canReadAllBgv(actor.role);
  const manage = canManageBgv(actor.role);
  const own = state.records.filter((r) => isSubject(actor, r));

  if (!readAll) {
    return (
      <Page title="Background checks">
        <Card title="My verification">
          {own.length === 0 ? (
            <EmptyState title="No verification on record" />
          ) : (
            <ul className="cmp-list">
              {own.map((r) => {
                const overall = overallResult(r);
                return (
                  <li key={r.id} className="cmp-item">
                    <div className="cmp-item-head">
                      <strong>Overall status</strong>
                      <StatusBadge status={overall} tone={toneFor(overall)} literal />
                    </div>
                    <div className="cmp-meta">
                      <span>Started {formatShortDate(r.createdOn)}</span>
                      <span>{r.consent ? `Consent given ${formatShortDate(r.consent.givenOn)}` : "Consent not yet given"}</span>
                    </div>
                    {!r.consent && <ConsentForm actor={actor} record={r} onResult={setMsg} />}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Banner message={msg} />
      </Page>
    );
  }

  const records = state.records;
  const withoutRecord = talent.joiners.filter((j) => !records.some((r) => r.subjectKind === "joiner" && r.subjectId === j.id));
  const counts = { clear: 0, review: 0, progress: 0, consent: 0 };
  for (const r of records) {
    const o = overallResult(r);
    if (o === "Clear") counts.clear += 1;
    else if (o === "Needs review" || o === "Incomplete") counts.review += 1;
    else if (o === "Awaiting consent") counts.consent += 1;
    else counts.progress += 1;
  }
  const opened = openId ? records.find((r) => r.id === openId) : undefined;

  function report(error: string | null, ok: string) {
    setMsg(error ? { tone: "err", text: error } : { tone: "ok", text: ok });
  }

  return (
    <Page title="Background checks">
      <Banner message={msg} />
      <MetricGrid>
        <MetricCard label="Clear" value={counts.clear} />
        <MetricCard label="Needs review" value={counts.review} />
        <MetricCard label="In progress" value={counts.progress} />
        <MetricCard label="Awaiting consent" value={counts.consent} />
      </MetricGrid>

      {manage && (
        <div className="cmp-split">
          {withoutRecord.length > 0 && (
            <Card title="Joiners without verification">
              <ul className="cmp-list">
                {withoutRecord.map((j) => (
                  <li key={j.id} className="row-between">
                    <span>
                      {j.name}
                      <br />
                      <small className="muted">
                        {j.role} · starts {formatShortDate(j.startDate)}
                      </small>
                    </span>
                    <ActionButton
                      className="btn-ghost btn-tiny"
                      busyLabel="Starting…"
                      doneLabel="Started"
                      success={`Verification started for ${j.name}.`}
                      onAction={() => {
                        const error = startVerification(actor, "joiner", j.id);
                        report(error, `Verification started for ${j.name}.`);
                        return error;
                      }}
                    >
                      Start
                    </ActionButton>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="Verify an employee">
            <div className="stack">
              <Field label="Employee">
                <PersonPicker key={pickerKey} value={employeeId} onChange={setEmployeeId} excludeId={actor.id} />
              </Field>
              <div>
                <ActionButton
                  className="btn"
                  busyLabel="Starting…"
                  doneLabel="Started"
                  success={employeeId ? `Verification started for ${personName(employeeId)}.` : undefined}
                  onAction={() => {
                    if (!employeeId) {
                      report("Choose an employee from the list.", "");
                      return false;
                    }
                    const error = startVerification(actor, "employee", employeeId);
                    report(error, `Verification started for ${personName(employeeId)}.`);
                    if (!error) {
                      setEmployeeId("");
                      setPickerKey((k) => k + 1);
                    }
                    return error;
                  }}
                >
                  Start verification
                </ActionButton>
              </div>
            </div>
          </Card>
        </div>
      )}

      <Card title="Verifications">
        <DataTable
          headers={["Name", "Type", "Consent", "Checks done", "Overall", ""]}
          empty={<EmptyState title="No verifications" description="Start one for a joiner or employee." />}
          rows={records.map((r) => {
            const overall = overallResult(r);
            const done = r.checks.filter((c) => DONE.includes(c.status)).length;
            return [
              <span key="n">
                {r.subjectName}
                <br />
                <small className="muted">{r.role}</small>
              </span>,
              r.subjectKind === "joiner" ? "Joiner" : "Employee",
              r.consent ? formatShortDate(r.consent.givenOn) : <StatusBadge key="c" status="Missing" tone="danger" literal />,
              `${done} of ${r.checks.length}`,
              <StatusBadge key="o" status={overall} tone={toneFor(overall)} literal />,
              <button key="a" className="btn-ghost btn-tiny" type="button" onClick={() => setOpenId(r.id)}>
                {canEditRecord(actor, r) ? "Manage" : "View"}
              </button>,
            ];
          })}
        />
      </Card>

      {opened && <RecordDialog record={opened} actor={actor} onClose={() => setOpenId(null)} onRemoved={(text) => { setOpenId(null); setMsg({ tone: "ok", text }); }} />}
    </Page>
  );
}

function ConsentForm({ actor, record, onResult }: { actor: ComplianceActor; record: BgvRecord; onResult: (msg: Msg) => void }) {
  if (!isSubject(actor, record)) return <p className="muted">Waiting for {record.subjectName} to give consent.</p>;
  return (
    <div className="cmp-form">
      <div style={{ alignSelf: "end" }}>
        <ActionButton
          className="btn"
          busyLabel="Recording…"
          doneLabel="Recorded"
          success="Consent recorded and sent to HR."
          onAction={() => {
            const err = recordConsent(actor, record.id, todayISO());
            onResult(err ? { tone: "err", text: err } : { tone: "ok", text: "Consent recorded." });
            return err;
          }}
        >
          I consent to background verification
        </ActionButton>
      </div>
    </div>
  );
}

function RecordDialog({ record, actor, onClose, onRemoved }: { record: BgvRecord; actor: ComplianceActor; onClose: () => void; onRemoved: (text: string) => void }) {
  const [msg, setMsg] = useState<Msg>(null);
  const editable = canEditRecord(actor, record);
  const overall = overallResult(record);
  const untouched = record.checks.every((c) => c.status === "Not started");

  return (
    <Dialog
      open
      wide
      title={record.subjectName}
      onClose={onClose}
      actions={
        <>
          {editable && untouched && (
            <ActionButton
              className="btn-ghost"
              success={`Verification for ${record.subjectName} removed.`}
              onAction={() => {
                const err = removeVerification(actor, record.id);
                if (err) setMsg({ tone: "err", text: err });
                else onRemoved("Verification removed.");
                return err;
              }}
            >
              Remove
            </ActionButton>
          )}
          <button className="btn-ghost" type="button" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="stack">
        <Banner message={msg} />
        <div className="cmp-item-head">
          <span className="cmp-meta">
            <span>{record.role}</span>
            <span>{record.subjectKind === "joiner" ? "Joiner" : "Employee"}</span>
            <span>
              {record.consent
                ? `Consent given ${formatShortDate(record.consent.givenOn)}`
                : "No consent on record"}
            </span>
          </span>
          <StatusBadge status={overall} tone={toneFor(overall)} literal />
        </div>
        {!record.consent && <ConsentForm actor={actor} record={record} onResult={setMsg} />}
        <div className="cmp-checks">
          {record.checks.map((c) => (
            <CheckCard key={c.type} record={record} item={c} actor={actor} editable={editable} onResult={setMsg} />
          ))}
        </div>
      </div>
    </Dialog>
  );
}

function CheckCard({
  record,
  item,
  actor,
  editable,
  onResult,
}: {
  record: BgvRecord;
  item: BgvCheck;
  actor: ComplianceActor;
  editable: boolean;
  onResult: (msg: Msg) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<CheckPatch>({
    status: item.status,
    vendor: item.vendor,
    initiatedOn: item.initiatedOn ?? "",
    completedOn: item.completedOn ?? "",
    remarks: item.remarks,
  });
  const done = DONE.includes(form.status);

  if (!editing) {
    return (
      <div className="cmp-item">
        <div className="cmp-item-head">
          <strong>{item.type}</strong>
          <StatusBadge status={item.status} tone={toneFor(item.status)} literal />
        </div>
        <div className="cmp-meta">
          {item.vendor && <span>{item.vendor}</span>}
          {item.initiatedOn && <span>Started {formatShortDate(item.initiatedOn)}</span>}
          {item.completedOn && <span>Done {formatShortDate(item.completedOn)}</span>}
        </div>
        {item.remarks && <p className="cmp-desc muted">{item.remarks}</p>}
        {editable && (
          <div className="cmp-actions">
            <button
              className="btn-ghost btn-tiny"
              type="button"
              onClick={() => {
                setForm({
                  status: item.status,
                  vendor: item.vendor || BGV_VENDORS[0],
                  initiatedOn: item.initiatedOn ?? todayISO(),
                  completedOn: item.completedOn ?? "",
                  remarks: item.remarks,
                });
                setEditing(true);
              }}
            >
              Update
            </button>
          </div>
        )}
      </div>
    );
  }

  const statusOptions = item.status === "Not started" ? CHECK_STATUSES : CHECK_STATUSES.filter((s) => s !== "Not started");
  return (
    <div className="cmp-item">
      <strong>{item.type}</strong>
      <Field label="Status">
        <select
          value={form.status}
          onChange={(e) => {
            const status = e.target.value as CheckStatus;
            setForm((f) => ({ ...f, status, completedOn: DONE.includes(status) && !f.completedOn ? todayISO() : f.completedOn }));
          }}
        >
          {statusOptions.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </Field>
      <Field label="Vendor">
        <select value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })}>
          <option value="">Choose…</option>
          {BGV_VENDORS.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </Field>
      {form.status !== "Not started" && (
        <Field label="Initiated">
          <input type="date" value={form.initiatedOn} max={todayISO()} onChange={(e) => setForm({ ...form, initiatedOn: e.target.value })} />
        </Field>
      )}
      {done && (
        <Field label="Completed">
          <input type="date" value={form.completedOn} max={todayISO()} onChange={(e) => setForm({ ...form, completedOn: e.target.value })} />
        </Field>
      )}
      <Field label={form.status === "Discrepancy" || form.status === "Unable to verify" ? "Remarks" : "Remarks (optional)"}>
        <textarea value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} />
      </Field>
      <div className="cmp-actions">
        <ActionButton
          className="btn btn-tiny"
          success={`${item.type} check for ${record.subjectName} saved.`}
          onAction={() => {
            const err = updateCheck(actor, record.id, item.type, form);
            onResult(err ? { tone: "err", text: err } : { tone: "ok", text: `${item.type} check updated.` });
            if (!err) setEditing(false);
            return err;
          }}
        >
          Save
        </ActionButton>
        <button className="btn-ghost btn-tiny" type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
