/**
 * Payslip figures for the summary table and the official payslip PDF.
 * FINAL = the month's payslip from a locked payroll run (runsStore). ESTIMATED = worked out by the portal
 * (payslipGenerator) because no locked run covers that month yet.
 */
import { API_ENABLED } from "../../api/client.ts";
import { fetchFile } from "../../api/syncRewardsShared.ts";
import { legalEntityFor } from "../../countryPay.ts";
import { asDetailView, paydayFor } from "../../data/payslipGenerator.ts";
import { parseISODate, type Employee, type PayslipView } from "../../model.ts";
import { PdfDoc, pdfMoney, saveFile, textWidth } from "./pdfDoc.ts";

export type SlipStatus = "final" | "estimated";

export function slipStatus(slip: PayslipView): SlipStatus {
  return asDetailView(slip)?.runId ? "final" : "estimated";
}

export const STATUS_TEXT: Record<SlipStatus, string> = {
  final: "Final · locked payroll run",
  estimated: "Estimated · not yet finalised by payroll",
};

export function monthTitle(month: string): string {
  return parseISODate(`${month}-01`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

const ONE_OFF = /bonus|encashment|overtime|reimburse|arrear/i;

export interface SlipBreakdown {
  basic: number;
  allowances: number;
  other: number;
  gross: number;
  /** Statutory and other deductions, without income tax. */
  deductions: number;
  tax: number;
  net: number;
  employer: number;
}

/** Basic (the first earnings line), allowances (the other regular lines), one-offs, gross, deductions, tax, net. */
export function slipBreakdown(slip: PayslipView): SlipBreakdown {
  const detail = asDetailView(slip);
  const [first, ...rest] = slip.earnings;
  const basic = first && !ONE_OFF.test(first.name) ? first.amount : 0;
  const pool = basic ? rest : slip.earnings;
  const allowances = pool.filter((l) => !ONE_OFF.test(l.name)).reduce((s, l) => s + l.amount, 0);
  const other = pool.filter((l) => ONE_OFF.test(l.name)).reduce((s, l) => s + l.amount, 0);
  const tax = detail?.tax.monthTax ?? 0;
  return {
    basic,
    allowances,
    other,
    gross: slip.gross,
    deductions: slip.deductionTotal - tax,
    tax,
    net: slip.net,
    employer: (detail?.employerContributions ?? []).reduce((s, l) => s + l.amount, 0),
  };
}

export function payPeriod(slip: PayslipView): { from: string; to: string } {
  const start = parseISODate(`${slip.month}-01`);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const to = slip.finalSettlement && slip.paidDays != null ? `${slip.month}-${String(slip.paidDays).padStart(2, "0")}` : iso(end);
  return { from: iso(start), to };
}

const fmt = (iso: string) => parseISODate(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** The payslip as an A4 PDF: header, employee and period, earnings and deductions, net, employer, tax, year to date. */
export function payslipPdf(slip: PayslipView, employee: Employee, regime?: string): Blob {
  const detail = asDetailView(slip);
  const c = slip.currency ?? "INR";
  const status = slipStatus(slip);
  const doc = new PdfDoc(`${slip.label} - ${employee.fullName}`);
  const L = 42;
  const R = 553;
  const navy: [number, number, number] = [0.11, 0.24, 0.43];
  doc.box(0, 0, 595.28, 70, navy);
  doc.text(L, 18, "TimeZ", { size: 20, bold: true, color: [1, 1, 1] });
  doc.text(L, 44, employee.legalEntity ?? legalEntityFor(employee.countryCode), { size: 10, color: [0.86, 0.9, 0.96] });
  doc.text(R, 20, `Payslip · ${monthTitle(slip.month)}`, { size: 14, bold: true, color: [1, 1, 1], align: "right" });
  doc.text(R, 44, status === "final" ? "FINAL" : "ESTIMATED", { size: 10, bold: true, color: status === "final" ? [0.7, 0.95, 0.75] : [1, 0.85, 0.5], align: "right" });

  let y = 88;
  const period = payPeriod(slip);
  const facts: [string, string][] = [
    ["Employee", `${employee.fullName} (${employee.employeeCode})`],
    ["Designation", employee.designation || "—"],
    ["Department", employee.department || "—"],
    ["Pay period", `${fmt(period.from)} – ${fmt(period.to)}`],
    ["Payment date", fmt(paydayFor(slip.month, employee.countryCode))],
    ["Country · currency", `${employee.countryName ?? employee.countryCode ?? "India"} · ${c}`],
    ["Days paid", slip.paidDays != null ? `${slip.paidDays} of ${slip.totalDays}${slip.finalSettlement ? " (final settlement)" : ""}` : "Full month"],
    ["Tax", detail ? `${detail.tax.basis}${regime ? ` · ${regime === "old" ? "old" : "new"} regime` : ""}` : "—"],
  ];
  facts.forEach(([k, v], i) => {
    const x = i % 2 === 0 ? L : 310;
    const row = Math.floor(i / 2);
    doc.text(x, y + row * 30, k.toUpperCase(), { size: 7.5, bold: true, color: [0.45, 0.48, 0.55] });
    doc.text(x, y + row * 30 + 11, v.length > 48 ? `${v.slice(0, 47)}…` : v, { size: 9.5 });
  });
  y += Math.ceil(facts.length / 2) * 30 + 8;
  doc.line(L, y, R, y, 1, navy);
  y += 12;

  const col = (x: number, w: number, title: string, lines: { name: string; amount: number }[], totalName: string, total: number, top: number) => {
    let yy = top;
    doc.box(x, yy, w, 18, [0.93, 0.95, 0.98]);
    doc.text(x + 6, yy + 4, title, { size: 9.5, bold: true, color: navy });
    yy += 24;
    const shown = lines.filter((l) => l.amount);
    if (!shown.length) {
      doc.text(x + 6, yy, "None", { size: 9, color: [0.45, 0.48, 0.55] });
      yy += 15;
    }
    for (const l of shown) {
      let name = l.name;
      while (textWidth(name, 9) > w - 110 && name.length > 4) name = `${name.slice(0, -2)}…`;
      doc.text(x + 6, yy, name, { size: 9 });
      doc.text(x + w - 6, yy, pdfMoney(l.amount, c), { size: 9, align: "right" });
      yy += 15;
    }
    doc.line(x, yy, x + w, yy);
    yy += 5;
    doc.text(x + 6, yy, totalName, { size: 9.5, bold: true });
    doc.text(x + w - 6, yy, pdfMoney(total, c), { size: 9.5, bold: true, align: "right" });
    return yy + 18;
  };
  const half = (R - L - 14) / 2;
  const yE = col(L, half, "Earnings", slip.earnings, "Gross pay", slip.gross, y);
  const yD = col(L + half + 14, half, "Deductions", slip.deductions, "Total deductions", slip.deductionTotal, y);
  y = Math.max(yE, yD) + 4;
  doc.box(L, y, R - L, 30, navy);
  doc.text(L + 10, y + 9, "NET PAY", { size: 12, bold: true, color: [1, 1, 1] });
  doc.text(R - 10, y + 9, pdfMoney(slip.net, c), { size: 12, bold: true, color: [1, 1, 1], align: "right" });
  y += 44;

  if (detail && detail.employerContributions.length) {
    const total = detail.employerContributions.reduce((s, l) => s + l.amount, 0);
    y = col(L, R - L, "Employer contributions (paid on top, not deducted)", detail.employerContributions, "Total employer contributions", total, y) + 4;
  }
  if (detail) {
    const t = detail.tax;
    const rows: { name: string; amount: number }[] = [
      { name: "Annual gross (annualised)", amount: t.annualGross },
      ...t.reliefs.map((r) => ({ name: `Less ${r.name}`, amount: r.amount })),
      { name: "Annual taxable income", amount: t.annualTaxable },
      { name: "Annual tax", amount: t.annualTax },
    ];
    y = col(L, R - L, `Tax computation · ${t.taxYear} · ${t.basis}`, rows, "Tax this month", t.monthTax, y) + 4;
    if (y > 740) {
      doc.addPage();
      y = 50;
    }
    doc.text(L, y, `Year to date (${detail.ytd.taxYear}): gross ${pdfMoney(detail.ytd.gross, c)} · tax ${pdfMoney(detail.ytd.tax, c)} · net ${pdfMoney(detail.ytd.net, c)}`, { size: 9 });
    y += 18;
  }
  const note =
    status === "final"
      ? "Final figures from the locked payroll run for this month. Computer-generated payslip; no signature needed. Confidential."
      : "ESTIMATED: worked out from your pay record, tax rules and verified declarations. The final payslip comes from the locked payroll run and may differ. Confidential.";
  doc.paragraph(L, Math.max(y + 6, 770), note, R - L, { size: 8, color: [0.4, 0.42, 0.48] });
  return doc.toBlob();
}

export function payslipFileName(slip: PayslipView, employee: Employee): string {
  return `Payslip-${slip.month}-${employee.employeeCode}${slipStatus(slip) === "estimated" ? "-estimate" : ""}.pdf`;
}

/**
 * Downloads the official PDF. Backend mode, final slip: the server's PDF of the locked run (audited). Otherwise the
 * same layout built in the browser. Returns an error message or null.
 */
export async function downloadPayslip(slip: PayslipView, employee: Employee, regime?: string): Promise<string | null> {
  const runId = asDetailView(slip)?.runId;
  if (API_ENABLED && runId) {
    return fetchFile(`/payroll/my-slips/${encodeURIComponent(runId)}/pdf`, payslipFileName(slip, employee));
  }
  try {
    saveFile(payslipPdf(slip, employee, regime), payslipFileName(slip, employee));
    return null;
  } catch {
    return "Could not create the PDF.";
  }
}
