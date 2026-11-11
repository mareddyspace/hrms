/**
 * The "Payslips" tab on a person's profile.
 * - Their own profile: every payslip they have (FINAL from locked payroll runs, ESTIMATED otherwise), the same
 *   figures as My payslips, with a link to the full slip and the PDF.
 * - HR / payroll looking at someone in their scope: that person's FINAL payslips from locked runs only (the server
 *   answers 404 for anyone else, so the tab then shows nothing). Managers and colleagues never get the tab.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { API_ENABLED } from "../../api/client.ts";
import { fetchFile } from "../../api/syncRewardsShared.ts";
import { ActionButton, EmptyState } from "../../components/ui.tsx";
import { money } from "../../countryPay.ts";
import { asDetailView } from "../../data/payslipGenerator.ts";
import { toPayslipView, type Employee, type PayslipView } from "../../model.ts";
import { useTaxRegime } from "../../data/taxRegime.ts";
import { usePortal } from "../../store.tsx";
import { downloadPayslip, monthTitle, payslipFileName, payslipPdf, slipStatus } from "./payslipDoc.ts";
import { saveFile } from "./pdfDoc.ts";
import { getRunSlipsSnapshot, personLockedSlips, subscribeRunSlips } from "./runsStore.ts";
import "./payslips.css";
import "../../styles/pay-claims.css";

/** Roles that may open another person's payslips (the server checks scope and country again). */
const PAYSLIP_VIEWER_ROLES = new Set(["hr", "hr_admin", "hrbp", "super_admin", "payroll"]);

export function canSeePayslipsOf(viewerRole: string, isSelf: boolean): boolean {
  return isSelf || PAYSLIP_VIEWER_ROLES.has(viewerRole);
}

type SlipPerson = {
  fullName: string;
  employeeCode: string;
  designation?: string;
  department?: string;
  countryCode: string;
  countryName?: string;
  legalEntity?: string;
};

export function ProfilePayslips({ personId, isSelf, person }: { personId: string; isSelf: boolean; person: SlipPerson }) {
  return isSelf ? <OwnSlips /> : <OtherSlips personId={personId} person={person} />;
}

function OwnSlips() {
  useSyncExternalStore(subscribeRunSlips, getRunSlipsSnapshot, getRunSlipsSnapshot);
  const { payslipViews, employee } = usePortal();
  const regime = useTaxRegime(employee.id);
  return (
    <SlipTable
      slips={payslipViews}
      emptyText="No payslips yet. The first one appears after your first full month."
      view={(slip) => `/payslips/${slip.id}`}
      download={(slip) => downloadPayslip(slip, employee, employee.countryCode === "IN" ? regime : undefined)}
      footer={<Link to="/payslips">Open My payslips (tax, salary history, payroll calendar)</Link>}
    />
  );
}

function OtherSlips({ personId, person }: { personId: string; person: SlipPerson }) {
  const [state, setState] = useState<{ slips: PayslipView[]; error: string | null; loading: boolean }>({ slips: [], error: null, loading: true });
  useEffect(() => {
    let live = true;
    personLockedSlips(personId)
      .then((rows) => live && setState({ slips: rows.map((r) => ({ ...r.slip, ...toPayslipView(r.slip) })), error: null, loading: false }))
      .catch(() => live && setState({ slips: [], error: null, loading: false })); // 404: not in scope -> nothing to show
    return () => {
      live = false;
    };
  }, [personId]);
  const asEmployee = person as unknown as Employee;
  if (state.loading) return <p className="muted">Loading payslips…</p>;
  return (
    <SlipTable
      slips={state.slips}
      emptyText="No payslips from locked payroll runs for this person yet."
      download={async (slip) => {
        const runId = asDetailView(slip)?.runId;
        if (API_ENABLED && runId) {
          return fetchFile(
            `/payroll/people/${encodeURIComponent(personId)}/slips/${encodeURIComponent(runId)}/pdf`,
            payslipFileName(slip, asEmployee),
          );
        }
        try {
          saveFile(payslipPdf(slip, asEmployee), payslipFileName(slip, asEmployee));
          return null;
        } catch {
          return "Could not create the PDF.";
        }
      }}
      footer={<p className="muted" style={{ margin: 0 }}>Only final payslips from locked payroll runs are shown here. Downloads are logged.</p>}
    />
  );
}

function SlipTable({
  slips,
  emptyText,
  view,
  download,
  footer,
}: {
  slips: PayslipView[];
  emptyText: string;
  view?: (slip: PayslipView) => string;
  download: (slip: PayslipView) => Promise<string | null>;
  footer: ReactNode;
}) {
  const latest = slips[0];
  const ytd = latest ? asDetailView(latest)?.ytd : undefined;
  const currency = latest?.currency ?? "INR";
  const finals = useMemo(() => slips.filter((s) => slipStatus(s) === "final").length, [slips]);
  if (!slips.length) return <EmptyState title="No payslips" description={emptyText} />;
  return (
    <div className="pc-profile-slips">
      <p className="muted" style={{ margin: "0 0 8px" }}>
        {finals} of {slips.length} month{slips.length === 1 ? "" : "s"} final (locked payroll run); the rest are estimates.
        {ytd ? ` Year to date (${ytd.taxYear}): gross ${money(ytd.gross, currency)} · tax ${money(ytd.tax, currency)} · net ${money(ytd.net, currency)}.` : ""}
      </p>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Month</th>
              <th>Status</th>
              <th className="num">Gross</th>
              <th className="num">Deductions</th>
              <th className="num">Net pay</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {slips.map((slip) => {
              const status = slipStatus(slip);
              const c = slip.currency ?? currency;
              return (
                <tr key={slip.id ?? slip.month}>
                  <td>{view ? <Link to={view(slip)}>{monthTitle(slip.month)}</Link> : monthTitle(slip.month)}</td>
                  <td>
                    <span className={`slip-tag ${status}`}>{status === "final" ? "Final" : "Estimated"}</span>
                  </td>
                  <td className="num">{money(slip.gross, c)}</td>
                  <td className="num">{money(slip.deductionTotal, c)}</td>
                  <td className="num">
                    <strong>{money(slip.net, c)}</strong>
                  </td>
                  <td>
                    <ActionButton
                      className="btn-ghost"
                      busyLabel="Preparing…"
                      doneLabel="Downloaded"
                      onAction={() => download(slip)}
                      success={`${monthTitle(slip.month)} payslip downloaded (PDF).`}
                      toastError
                    >
                      Download PDF
                    </ActionButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8 }}>{footer}</div>
    </div>
  );
}
