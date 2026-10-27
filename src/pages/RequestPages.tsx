import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Banner, Card, Field, Page, StatusPill } from "../components/ui.tsx";
import { claimLimitsFor, itemCurrency, money, moneyTotals, payRulesFor } from "../countryPay.ts";
import { formatShortDate, inr, todayISO } from "../model.ts";
import { usePortal } from "../store.tsx";

export function EncashmentPage() {
  const { leaveTable, state, employee, applyEncashment, hasApprover } = usePortal();
  const pto = leaveTable.find((row) => row.code === "pto");
  const [days, setDays] = useState("1");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const mine = state.encashments.filter((item) => item.employeeId === employee.id);

  return (
    <Page
      title="Leave encashment"
      subtitle="Only privilege leave can be encashed."
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
  const [purpose, setPurpose] = useState("");
  const [requiredBy, setRequiredBy] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const rows = state.cashAdvances.filter((item) => item.employeeId === employee.id);
  const totalRequested = moneyTotals(rows.map((item) => ({ amount: item.amount, currency: itemCurrency(item) })));
  const pendingCount = rows.filter((item) => item.status === "pending").length;

  return (
    <Page title="Cash advance" subtitle="Approved advances are recovered from a later payslip.">
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
              setPurpose("");
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
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
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
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const assigned = state.assets.filter((asset) => asset.employeeId === employee.id);
  const requests = state.assetRequests.filter((request) => request.employeeId === employee.id);
  return (
    <Page title="My Asset Request">
      <Card title="Assigned to me">
        {assigned.length === 0 ? (
          <p className="empty">No assets are assigned to you.</p>
        ) : (
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
        )}
      </Card>
      <RequestSplit
        form={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const error = addAssetRequest(item, reason);
              setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: hasApprover ? "Asset request submitted." : "Asset request approved automatically." });
              if (!error) {
                setItem("");
                setReason("");
              }
            }}
          >
            <div className="form-grid">
              <Field label="Asset">
                <input value={item} onChange={(event) => setItem(event.target.value)} />
              </Field>
              <Field label="Reason" wide>
                <input value={reason} onChange={(event) => setReason(event.target.value)} />
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
          )
        }
      />
    </Page>
  );
}

export function CabPage() {
  const { state, employee, addCab, hasApprover } = usePortal();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const rows = state.cabBookings.filter((item) => item.employeeId === employee.id);
  return (
    <Page title="Book my Cab">
      <RequestSplit
        form={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const error = addCab({ date, time, from, to });
              setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: hasApprover ? "Cab requested." : "Cab booking approved automatically." });
              if (!error) {
                setFrom("");
                setTo("");
              }
            }}
          >
            <div className="form-grid">
              <Field label="Date">
                <input type="date" min={todayISO()} value={date} onChange={(event) => setDate(event.target.value)} />
              </Field>
              <Field label="Time">
                <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
              </Field>
              <Field label="Pickup">
                <input value={from} onChange={(event) => setFrom(event.target.value)} />
              </Field>
              <Field label="Drop">
                <input value={to} onChange={(event) => setTo(event.target.value)} />
              </Field>
            </div>
            <div className="form-actions">
              <button className="btn" type="submit">
                Book cab
              </button>
            </div>
            <Banner message={message} />
          </form>
        }
        rows={
          rows.length === 0 ? (
            <p className="empty">No cab bookings.</p>
          ) : (
            <table className="data">
              <tbody>
                {rows.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {item.date} {item.time}
                    </td>
                    <td>
                      {item.from} → {item.to}
                    </td>
                    <td>
                      <StatusPill status={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      />
    </Page>
  );
}

export function SoftwarePage() {
  const { state, employee, addSoftware, hasApprover } = usePortal();
  const [software, setSoftware] = useState("");
  const [justification, setJustification] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const rows = state.softwareRequests.filter((item) => item.employeeId === employee.id);
  return (
    <Page title="Request For Software">
      <RequestSplit
        form={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const error = addSoftware(software, justification);
              setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: hasApprover ? "Software request submitted." : "Software request approved automatically." });
              if (!error) {
                setSoftware("");
                setJustification("");
              }
            }}
          >
            <div className="form-grid">
              <Field label="Software">
                <input value={software} onChange={(event) => setSoftware(event.target.value)} />
              </Field>
              <Field label="Why you need it" wide>
                <textarea value={justification} onChange={(event) => setJustification(event.target.value)} />
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
          )
        }
      />
    </Page>
  );
}

export function CafeteriaPage() {
  const { state, employee, menuItem, orderMeal, cancelMeal } = usePortal();
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const orders = state.cafeteriaOrders.filter((order) => order.employeeId === employee.id);
  return (
    <Page title="My Cafeteria">
      <div className="menu-grid">
        {state.menu.map((item) => (
          <article key={item.id} className="menu-card">
            <h3>{item.name}</h3>
            <p className="muted">{item.category}</p>
            <strong>{inr(item.price)}</strong>
            <div className="form-actions">
              <button
                className="btn"
                type="button"
                onClick={() => {
                  const error = orderMeal(item.id);
                  setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: `${item.name} ordered.` });
                }}
              >
                Order
              </button>
            </div>
          </article>
        ))}
      </div>
      <Card title="My orders">
        <Banner message={message} />
        {orders.length === 0 ? (
          <p className="empty">No orders yet.</p>
        ) : (
          <table className="data">
            <tbody>
              {orders.map((order) => {
                const item = menuItem(order.menuItemId);
                // Use the name and price saved with the order; older orders fall back to today's menu.
                const price = order.unitPrice ?? item?.price;
                return (
                  <tr key={order.id}>
                    <td>{order.date}</td>
                    <td>{order.itemName ?? item?.name ?? "Menu item"}</td>
                    <td>{price != null ? inr(price) : "—"}</td>
                    <td>
                      <StatusPill status={order.status} />
                    </td>
                    <td>
                      {order.status === "placed" && order.date === todayISO() && (
                        <button
                          type="button"
                          className="btn-ghost btn-tiny"
                          onClick={() => {
                            const error = cancelMeal(order.id);
                            setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: "Order cancelled." });
                          }}
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
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
