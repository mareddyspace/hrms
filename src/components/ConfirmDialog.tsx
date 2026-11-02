import type { ReactNode } from "react";
import { ActionButton, Dialog, type ActionResult } from "./ui.tsx";

/**
 * "Are you sure?" before a step that can't be undone (submitting an assessment, removing a goal).
 * `onConfirm` runs the change; the dialog closes itself only when it succeeds, and shows nothing extra on failure
 * (the page reports the error in its own notice).
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => ActionResult | Promise<ActionResult>;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <ActionButton className="btn" onAction={onConfirm} onSuccess={onClose}>
            {confirmLabel}
          </ActionButton>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
