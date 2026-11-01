/**
 * Benefit plan documents: the plan summary PDF (server-made in backend mode, built in the browser otherwise),
 * policy files HR uploaded (backend), and dependents' proof files.
 */
import { API_ENABLED } from "../../api/client.ts";
import { fetchFile } from "../../api/syncRewardsShared.ts";
import { apiUploadPlanDoc } from "../../api/syncRewards.ts";
import { eligibilityRules, runRewardApi } from "../../data/rewardLocal.ts";
import type { BenefitPlan, Dependent } from "../../data/rewardData.ts";
import { PdfDoc, pdfMoney, saveFile } from "../payroll/pdfDoc.ts";

const slug = (s: string) => s.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");

function localPlanPdf(plan: BenefitPlan): Blob {
  const doc = new PdfDoc(`${plan.name} plan summary`);
  const L = 42;
  const W = 511;
  doc.box(0, 0, 595.28, 60, [0.11, 0.24, 0.43]);
  doc.text(L, 16, "TimeZ", { size: 18, bold: true, color: [1, 1, 1] });
  doc.text(L, 38, plan.legalEntity ?? `All TimeZ entities in ${plan.country}`, { size: 9.5, color: [0.86, 0.9, 0.96] });
  let y = 80;
  doc.text(L, y, `${plan.name} · plan summary`, { size: 15, bold: true });
  y += 28;
  const facts: [string, string][] = [
    ["Plan type", plan.category],
    ["Provider", plan.provider],
    ["Country", plan.country],
    ["Employee contribution", plan.employeeCost || "—"],
    ["Employer contribution", plan.employerAnnualCost ? `${pdfMoney(plan.employerAnnualCost, plan.currency)} a year per member` : "—"],
    ["Dependents", plan.coversDependents ? "Can be covered" : "Employee only"],
    ["Enrollment", plan.mandatory ? "Statutory (automatic)" : plan.autoEnrolled ? "Automatic" : "On request"],
  ];
  for (const [k, v] of facts) {
    doc.text(L, y, k, { size: 9.5, bold: true });
    y += doc.paragraph(L + 150, y, v, W - 150, { size: 9.5 }) + 2;
  }
  for (const [h, t] of [["Summary", plan.summary], ["Coverage", plan.coverage], ["Terms", plan.terms]] as const) {
    if (!t) continue;
    y += 8;
    doc.text(L, y, h, { size: 11, bold: true, color: [0.11, 0.24, 0.43] });
    y += 16;
    y += doc.paragraph(L, y, t, W, { size: 9.5 });
  }
  y += 8;
  doc.text(L, y, "Who can join", { size: 11, bold: true, color: [0.11, 0.24, 0.43] });
  y += 16;
  for (const r of eligibilityRules(plan)) y += doc.paragraph(L, y, `• ${r}`, W, { size: 9.5 });
  doc.paragraph(L, Math.max(y + 16, 780), "Summary for information. The provider's policy wording prevails.", W, { size: 8, color: [0.4, 0.42, 0.48] });
  return doc.toBlob();
}

/** The plan summary as a PDF. */
export async function downloadPlanSummary(plan: BenefitPlan): Promise<string | null> {
  if (API_ENABLED) return fetchFile(`/benefits/plans/${encodeURIComponent(plan.id)}/summary.pdf`, `${slug(plan.name)}-summary.pdf`);
  saveFile(localPlanPdf(plan), `${slug(plan.name)}-summary.pdf`);
  return null;
}

/** A policy document HR uploaded (backend mode). */
export function downloadPlanFile(plan: BenefitPlan, file: { id: string; fileName: string }): Promise<string | null> {
  return fetchFile(`/benefits/plans/${encodeURIComponent(plan.id)}/documents/${encodeURIComponent(file.id)}`, file.fileName);
}

export function uploadPlanFile(plan: BenefitPlan, title: string, file: File): Promise<string | null> {
  if (!title.trim()) return Promise.resolve("Give the document a title.");
  if (!["application/pdf", "image/png", "image/jpeg"].includes(file.type)) return Promise.resolve("Upload a PDF or an image.");
  if (file.size > 5 * 1024 * 1024) return Promise.resolve("The file is larger than 5 MB.");
  return runRewardApi(apiUploadPlanDoc(plan.id, title.trim(), file), ["benefits"]);
}

/** A dependent's proof of relationship. */
export async function downloadDependentDoc(d: Dependent): Promise<string | null> {
  if (API_ENABLED) return fetchFile(`/benefits/dependents/${encodeURIComponent(d.id)}/document`, d.docName ?? "proof");
  if (!d.docDataUrl) return "No file stored for this dependent.";
  saveFile(await (await fetch(d.docDataUrl)).blob(), d.docName ?? "proof");
  return null;
}
