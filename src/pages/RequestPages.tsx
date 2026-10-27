import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Banner, Card, Field, Page, StatusPill } from "../components/ui.tsx";
import { claimLimitsFor, itemCurrency, money, moneyTotals, payRulesFor } from "../countryPay.ts";
import { formatShortDate, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";
import { ASSET_SUGGESTIONS, TEMPLATE_BLANKS_ERROR, hasOwnTemplate, hasTemplateBlanks, useTemplatedText } from "../data/requestTemplates.ts";

export function EncashmentPage() {
  const { leaveTable, state, employee, applyEncashment, hasApprover } = usePortal();
  const pto = leaveTable.find((row) => row.code === "pto");
  const [days, setDays] = useState("1");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const mine = state.encashments.filter((item) => item.employeeId === employee.id);

  return (
    <Page
      title="Leave encashment"
      subtitle="Privilege leave only"
    >
      <section className="summary-row" aria-label="Privilege leave">
        <div className="summary">
          <span>Allowed</span>
          <strong>{pto?.quota ?? 0}</strong>
        </div>
        <div className="summary sky">
          <span>Used</span>
          <strong>{pto?.utilized ?? 0}</strong>
        </div>
        <div className="summary lilac">
          <span>Available to encash</span>
          <strong>{pto?.available ?? 0}</strong>
        </div>
      </section>
      <div className="split">
        <Card title="Request encashment">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const error = applyEncashment("pto", Number(days));
              setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: hasApprover ? "Encashment submitted for manager approval." : "Encashment approved automatically." });
            }}
          >
            <Field label="Privilege leave days">
              <input type="number" min={1} value={days} onChange={(event) => setDays(event.target.value)} />
            </Field>
            <div className="form-actions">
              <button className="btn" type="submit">
                Submit
              </button>
            </div>
            <Banner message={message} />
          </form>
        </Card>
        <Card title="History">
          {mine.length === 0 ? (
            <p className="empty">No encashment requests yet.</p>
          ) : (
            <div className="doc-table-wrap">
              <table className="data">
                <tbody>
                  {mine.map((item) => (
                    <tr key={item.id}>
                      <td>{item.days} days</td>
                      <td>{item.appliedOn}</td>
                      <td>
                        <StatusPill status={item.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}

const CASH_CATEGORIES = [
  "Business trip",
  "Client entertainment",
  "Local conveyance",
  "Training / event",
  "Emergency purchase",
  "Other",
] as const;

export function CashPage() {
  const { state, employee, addCash, hasApprover } = usePortal();
  const currency = payRulesFor(employee.countryCode).currency;
  const { maxCashAdvance } = claimLimitsFor(employee.countryCode);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const { value: purpose, setValue: setPurpose, ref: purposeRef, fill: fillPurpose, reset: resetPurpose } = useTemplatedText();
  const [requiredBy, setRequiredBy] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const rows = state.cashAdvances.filter((item) => item.employeeId === employee.id);
  const totalRequested = moneyTotals(rows.map((item) => ({ amount: item.amount, currency: itemCurrency(item) })));
  const pendingCount = rows.filter((item) => item.status === "pending").length;

  return (
    <Page title="Cash advance" subtitle="Recovered from a later payslip">
      <section className="cash-summary" aria-label="Cash advance summary">
        <div className="cash-stat">
          <span>Total requested</span>
          <strong>{totalRequested}</strong>
        </div>
        <div className="cash-stat">
          <span>Pending requests</span>
          <strong>{pendingCount}</strong>
        </div>
      </section>

      <Card title="New advance request">
        <form
          className="cash-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (hasTemplateBlanks(purpose)) {
              setMessage({ tone: "err", text: TEMPLATE_BLANKS_ERROR });
              return;
            }
            const error = addCash({
              amount: Number(amount),
              category,
              purpose,
              requiredBy,
            });
            setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: hasApprover ? "Cash advance submitted for approval." : "Cash advance approved automatically." });
            if (!error) {
              setAmount("");
              setCategory("");
              resetPurpose();
              setRequiredBy("");
            }
          }}
        >
          <Field label={`Amount (${currency}, up to ${money(maxCashAdvance, currency)})`}>
            <input
              type="number"
              min={1}
              step={1}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </Field>
          <Field label="Expense category">
            <select
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                fillPurpose("cashAdvance", event.target.value);
              }}
            >
              <option value="">Select a category</option>
              {CASH_CATEGORIES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Business purpose" wide>
            <textarea
              ref={purposeRef}
              rows={3}
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              placeholder="Explain why the advance is required"
            />
          </Field>
          <Field label="Required by date">
            <input type="date" min={todayISO()} value={requiredBy} onChange={(event) => setRequiredBy(event.target.value)} />
          </Field>
          <button className="btn cash-submit" type="submit">
            Submit request
          </button>
          <Banner message={message} />
        </form>
      </Card>

      <Card title="My requests">
        {rows.length === 0 ? (
          <p className="empty">No advance requested yet.</p>
        ) : (
          <div className="cash-request-list">
            {rows.map((item) => (
              <article key={item.id} className="cash-request-card">
                <div className="cash-request-top">
                  <h3>{item.category || item.purpose}</h3>
                  <StatusPill status={item.status} />
                </div>
                <strong className="cash-request-amount">{money(item.amount, itemCurrency(item))}</strong>
                {item.purpose && item.purpose !== item.category && <p className="muted cash-request-purpose">{item.purpose}</p>}
                <p className="cash-request-meta">Submitted {formatShortDate(item.date)}</p>
                {item.requiredBy && <p className="cash-request-meta">Needed by {formatShortDate(item.requiredBy)}</p>}
              </article>
            ))}
          </div>
        )}
      </Card>
    </Page>
  );
}

export function AssetsPage() {
  const { state, employee, addAssetRequest, hasApprover } = usePortal();
  const [item, setItem] = useState("");
  const { value: reason, setValue: setReason, ref: reasonRef, fill: fillReason, reset: resetReason } = useTemplatedText<HTMLInputElement>();
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const assigned = state.assets.filter((asset) => asset.employeeId === employee.id);
  const requests = state.assetRequests.filter((request) => request.employeeId === employee.id);
  return (
    <Page title="Asset requests">
      <Card title="Assigned to me">
        {assigned.length === 0 ? (
          <p className="empty">No assets are assigned to you.</p>
        ) : (
        <div className="doc-table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Tag</th>
                <th>Since</th>
                <th>Condition</th>
              </tr>
            </thead>
            <tbody>
              {assigned.map((asset) => (
                <tr key={asset.id}>
                  <td>{asset.name}</td>
                  <td>{asset.tag}</td>
                  <td>{asset.assignedOn}</td>
                  <td>{asset.condition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </Card>
      <RequestSplit
        form={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (hasTemplateBlanks(reason)) {
                setMessage({ tone: "err", text: TEMPLATE_BLANKS_ERROR });
                return;
              }
              const error = addAssetRequest(item, reason);
              setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: hasApprover ? "Asset request submitted." : "Asset request approved automatically." });
              if (!error) {
                setItem("");
                resetReason();
              }
            }}
          >
            <div className="form-grid">
              <Field label="Asset">
                <input
                  list="asset-suggestions"
                  value={item}
                  placeholder="e.g. Laptop"
                  onChange={(event) => {
                    setItem(event.target.value);
                    // A suggestion picked from the list fills the reason straight away.
                    if (hasOwnTemplate("asset", event.target.value)) {
                      const picked = (event.nativeEvent as InputEvent).inputType !== "insertText";
                      fillReason("asset", event.target.value, { focus: picked });
                    }
                  }}
                  onBlur={(event) => fillReason("asset", event.target.value, { focus: false })}
                />
                <datalist id="asset-suggestions">
                  {ASSET_SUGGESTIONS.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </Field>
              <Field label="Reason" wide>
                <input ref={reasonRef} value={reason} onChange={(event) => setReason(event.target.value)} />
              </Field>
            </div>
            <div className="form-actions">
              <button className="btn" type="submit">
                Request asset
              </button>
            </div>
            <Banner message={message} />
          </form>
        }
        rows={
          requests.length === 0 ? (
            <p className="empty">No open asset requests.</p>
          ) : (
            <div className="doc-table-wrap">
              <table className="data">
                <tbody>
                  {requests.map((request) => (
                    <tr key={request.id}>
                      <td>{request.date}</td>
                      <td>{request.item}</td>
                      <td>{request.reason}</td>
                      <td>
                        <StatusPill status={request.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      />
    </Page>
  );
}

export function SoftwarePage() {
  const { state, employee, addSoftware, hasApprover } = usePortal();
  const [software, setSoftware] = useState("");
  const {
    value: justification,
    setValue: setJustification,
    ref: justificationRef,
    fillIfEmpty: fillJustificationIfEmpty,
    reset: resetJustification,
  } = useTemplatedText();
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const rows = state.softwareRequests.filter((item) => item.employeeId === employee.id);
  return (
    <Page title="Software requests">
      <RequestSplit
        form={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (hasTemplateBlanks(justification)) {
                setMessage({ tone: "err", text: TEMPLATE_BLANKS_ERROR });
                return;
              }
              const error = addSoftware(software, justification);
              setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: hasApprover ? "Software request submitted." : "Software request approved automatically." });
              if (!error) {
                setSoftware("");
                resetJustification();
              }
            }}
          >
            <div className="form-grid">
              <Field label="Software">
                <input value={software} onChange={(event) => setSoftware(event.target.value)} />
              </Field>
              <Field label="Why you need it" wide>
                <textarea
                  ref={justificationRef}
                  value={justification}
                  onChange={(event) => setJustification(event.target.value)}
                  // Once the software is named, start the justification for the user.
                  onFocus={() => fillJustificationIfEmpty("software", software)}
                />
              </Field>
            </div>
            <div className="form-actions">
              <button className="btn" type="submit">
                Submit request
              </button>
            </div>
            <Banner message={message} />
          </form>
        }
        rows={
          rows.length === 0 ? (
            <p className="empty">No software requests.</p>
          ) : (
            <div className="doc-table-wrap">
              <table className="data">
                <tbody>
                  {rows.map((item) => (
                    <tr key={item.id}>
                      <td>{item.software}</td>
                      <td>{item.justification}</td>
                      <td>
                        <StatusPill status={item.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      />
    </Page>
  );
}

function RequestSplit({ form, rows }: { form: ReactNode; rows: ReactNode }) {
  return (
    <div className="split">
      <Card title="New request">{form}</Card>
      <Card title="My requests">{rows}</Card>
    </div>
  );
}
