import { useState } from "react";
import type { ReactNode } from "react";
import { Banner, Card, Field, Page, StatusPill, SubmitButton, useAction } from "../components/ui.tsx";
import { usePortal } from "../store.tsx";
import { formatShortDate } from "../model.ts";
import { ASSET_SUGGESTIONS, TEMPLATE_BLANKS_ERROR, hasOwnTemplate, hasTemplateBlanks, useTemplatedText } from "../data/requestTemplates.ts";

// Cash advance, leave encashment and software have guided pages of their own (src/features/payrequests).
export { CashAdvancePage as CashPage } from "../features/payrequests/CashAdvancePage.tsx";
export { EncashmentPage } from "../features/payrequests/EncashmentPage.tsx";
export { SoftwareCataloguePage as SoftwarePage } from "../features/payrequests/SoftwarePage.tsx";

export function AssetsPage() {
  const { state, employee, addAssetRequest, hasApprover } = usePortal();
  const [item, setItem] = useState("");
  const { value: reason, setValue: setReason, ref: reasonRef, fill: fillReason, reset: resetReason } = useTemplatedText<HTMLInputElement>();
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const assigned = state.assets.filter((asset) => asset.employeeId === employee.id);
  const requests = state.assetRequests.filter((request) => request.employeeId === employee.id);
  const assetAction = useAction();
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
                  <td>{formatShortDate(asset.assignedOn)}</td>
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
            onSubmit={assetAction.submit(() => {
              if (hasTemplateBlanks(reason)) {
                setMessage({ tone: "err", text: TEMPLATE_BLANKS_ERROR });
                return false;
              }
              const error = addAssetRequest(item, reason);
              setMessage(error ? { tone: "err", text: error } : { tone: "ok", text: hasApprover ? "Asset request submitted." : "Asset request approved automatically." });
              if (!error) {
                setItem("");
                resetReason();
              }
              return error ? false : true;
            }, { success: hasApprover ? "Asset request submitted for approval." : "Asset request approved." })}
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
              <SubmitButton action={assetAction} className="btn">
                Request asset
              </SubmitButton>
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
                      <td>{formatShortDate(request.date)}</td>
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

function RequestSplit({ form, rows }: { form: ReactNode; rows: ReactNode }) {
  return (
    <div className="split">
      <Card title="New request">{form}</Card>
      <Card title="My requests">{rows}</Card>
    </div>
  );
}
