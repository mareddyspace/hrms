import { useState, type ReactNode } from "react";
import { Banner, Dialog, Field, SubmitButton, useAction } from "../../components/ui.tsx";
import "../../styles/manager.css";

export type DecisionKind = "approve" | "reject";

/**
 * The one decision dialog used by Approvals and Team timesheets: approve (comment optional) or decline / send back
 * (comment required). onConfirm returns an error message or null.
 */
export function DecisionDialog({
  decision,
  title,
  summary,
  rejectLabel = "Decline",
  count = 1,
  onConfirm,
  onClose,
}: {
  decision: DecisionKind;
  title: string;
  summary?: ReactNode;
  rejectLabel?: string;
  count?: number;
  onConfirm: (note: string) => Promise<string | null> | string | null;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ tone: "err"; text: string } | null>(null);
  const act = useAction();
  const approving = decision === "approve";
  const verb = approving ? "Approve" : rejectLabel;
  const label = count > 1 ? `${verb} ${count}` : verb;
  return (
    <Dialog open title={title} onClose={onClose}>
      <form
        className="mgr-decision"
        onSubmit={act.submit(
          async () => {
            const text = note.trim();
            if (!approving && !text) {
              const error = `Add a comment saying why (${rejectLabel.toLowerCase()}).`;
              setMsg({ tone: "err", text: error });
              return error;
            }
            const error = await onConfirm(text);
            if (error) setMsg({ tone: "err", text: error });
            return error;
          },
          { success: approving ? "Approved." : rejectLabel === "Send back" ? "Sent back." : "Declined.", onSuccess: onClose },
        )}
      >
        <Banner message={msg} />
        {summary && <div className="mgr-decision-summary">{summary}</div>}
        <Field label={approving ? "Comment (optional)" : "Comment (required)"} wide>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} required={!approving} autoFocus />
        </Field>
        <div className="form-actions">
          <SubmitButton action={act} className={approving ? "btn" : "btn mgr-btn-danger"}>
            {label}
          </SubmitButton>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
