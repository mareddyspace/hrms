import { useMemo, useState } from "react";
import { Download, Printer } from "lucide-react";
import { COMPANY_MARK, COMPANY_NAME } from "../brand.ts";
import { Dialog } from "./ui.tsx";

/** Everything needed to draw a certificate, for internal course completions and external certifications. */
export type CertificateDoc = {
  id: string;
  /** "course": issued by TimeZ when a course is completed. "professional": an external certification on file. */
  kind: "course" | "professional";
  title: string;
  recipient: string;
  issuer: string;
  issuedOn: string;
  expiresOn?: string;
  /** Shown only when there is a real number: our own course ID, or one HR recorded from the issuer. */
  credentialId?: string;
  /** External certifications: true once HR has checked it with the issuer. */
  verified?: boolean;
  /** External certifications: past the expiry date. */
  expired?: boolean;
  /** Short line under the title, e.g. "4 hours · Engineering". */
  details?: string;
};

const W = 1200;
const H = 850;

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
}

/** Stable short code for credential IDs (no randomness, so the same certificate always shows the same ID). */
export function credentialCode(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h.toString(36).toUpperCase().padStart(7, "0").slice(-7);
}

/** Landscape certificate as an SVG string — used for the preview, the PNG download and printing. */
export function certificateSvg(doc: CertificateDoc): string {
  const isCourse = doc.kind === "course";
  const heading = isCourse ? "CERTIFICATE OF COMPLETION" : "CERTIFICATION RECORD";
  const lead = isCourse ? "This certifies that" : "This confirms that";
  const verb = isCourse ? "has successfully completed" : "holds the professional certification";
  const issuerLine = isCourse
    ? `${COMPANY_NAME} Learning & Development`
    : `Issued by ${doc.issuer} · ${doc.verified ? "verified by HR" : "not verified"}`;
  const dates = [
    `${isCourse ? "Completed" : "Issued"} ${longDate(doc.issuedOn)}`,
    doc.expiresOn ? `${doc.expired ? "Expired" : "Valid until"} ${longDate(doc.expiresOn)}` : "No expiry",
  ].join("   ·   ");
  const stamp = isCourse ? "COMPLETED" : doc.expired ? "EXPIRED" : doc.verified ? "VERIFIED" : "ON FILE";
  const stampColor = !isCourse && doc.expired ? "#b91c1c" : "#0e7490";
  const font = "Segoe UI, Helvetica, Arial, sans-serif";
  const serif = "Georgia, 'Times New Roman', serif";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="band" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="#0b2545"/><stop offset="0.6" stop-color="#0e7490"/><stop offset="1" stop-color="#22b8cf"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="#0b2545" stroke-width="3"/>
  <rect x="38" y="38" width="${W - 76}" height="${H - 76}" fill="none" stroke="#a8dbe8" stroke-width="1.5"/>
  <rect x="38" y="38" width="${W - 76}" height="14" fill="url(#band)"/>
  <g transform="translate(${W / 2}, 132)">
    <circle r="38" fill="#0b2545"/>
    <text y="12" text-anchor="middle" font-family="${font}" font-size="30" font-weight="700" fill="#ffffff">${esc(COMPANY_MARK)}</text>
  </g>
  <text x="${W / 2}" y="214" text-anchor="middle" font-family="${font}" font-size="18" letter-spacing="6" fill="#0e7490" font-weight="700">${heading}</text>
  <text x="${W / 2}" y="290" text-anchor="middle" font-family="${font}" font-size="22" fill="#64748b">${lead}</text>
  <text x="${W / 2}" y="368" text-anchor="middle" font-family="${serif}" font-size="64" fill="#0f172a">${esc(doc.recipient)}</text>
  <line x1="${W / 2 - 280}" x2="${W / 2 + 280}" y1="392" y2="392" stroke="#a8dbe8" stroke-width="2"/>
  <text x="${W / 2}" y="446" text-anchor="middle" font-family="${font}" font-size="22" fill="#64748b">${verb}</text>
  <text x="${W / 2}" y="506" text-anchor="middle" font-family="${font}" font-size="40" font-weight="700" fill="#0b2545">${esc(doc.title)}</text>
  ${doc.details ? `<text x="${W / 2}" y="548" text-anchor="middle" font-family="${font}" font-size="20" fill="#64748b">${esc(doc.details)}</text>` : ""}
  <text x="${W / 2}" y="600" text-anchor="middle" font-family="${font}" font-size="19" fill="#334155">${esc(dates)}</text>
  <line x1="150" x2="450" y1="700" y2="700" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="300" y="728" text-anchor="middle" font-family="${font}" font-size="17" fill="#334155">${esc(issuerLine)}</text>
  <line x1="${W - 450}" x2="${W - 150}" y1="700" y2="700" stroke="#94a3b8" stroke-width="1.5"/>
  ${doc.credentialId ? `<text x="${W - 300}" y="728" text-anchor="middle" font-family="${font}" font-size="17" fill="#334155">Credential ID ${esc(doc.credentialId)}</text>` : ""}
  <g transform="translate(${W / 2}, 712)">
    <circle r="46" fill="#e0f2f7" stroke="${stampColor}" stroke-width="3"/>
    <circle r="36" fill="none" stroke="${stampColor}" stroke-width="1.5" stroke-dasharray="4 4"/>
    <text y="-4" text-anchor="middle" font-family="${font}" font-size="13" font-weight="700" fill="${stampColor}">${stamp}</text>
    <text y="16" text-anchor="middle" font-family="${font}" font-size="12" fill="${stampColor}">${esc(doc.issuedOn.slice(0, 4))}</text>
  </g>
</svg>`;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function fileName(doc: CertificateDoc, ext: string): string {
  const slug = `${doc.recipient}-${doc.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `${slug}-certificate.${ext}`;
}

/** Renders the certificate at 2× and downloads it as a PNG image. */
export async function downloadCertificatePng(doc: CertificateDoc): Promise<void> {
  const image = new Image();
  image.src = svgDataUrl(certificateSvg(doc));
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = W * 2;
  canvas.height = H * 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not available");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not create the image");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName(doc, "png");
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Prints only the certificate (landscape), so it can be saved as a PDF from the print dialog. */
export function printCertificate(doc: CertificateDoc): void {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(frame);
  const frameDoc = frame.contentDocument;
  if (!frameDoc) return;
  frameDoc.open();
  frameDoc.write(`<!doctype html><html><head><title>${esc(fileName(doc, "pdf"))}</title>
<style>@page{size:landscape;margin:0}html,body{margin:0}svg{width:100vw;height:auto;display:block}</style></head>
<body>${certificateSvg(doc)}</body></html>`);
  frameDoc.close();
  window.setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    window.setTimeout(() => frame.remove(), 1000);
  }, 100);
}

export function CertificateDialog({ doc, onClose }: { doc: CertificateDoc | null; onClose: () => void }) {
  const [error, setError] = useState("");
  const src = useMemo(() => (doc ? svgDataUrl(certificateSvg(doc)) : ""), [doc]);
  if (!doc) return null;

  async function download() {
    try {
      setError("");
      await downloadCertificatePng(doc!);
    } catch {
      setError("Could not create the image. Try Print / Save as PDF instead.");
    }
  }

  return (
    <Dialog open title={doc.title} onClose={onClose} wide>
      <img className="certificate-preview" src={src} alt={`${doc.title} certificate for ${doc.recipient}`} />
      <dl className="certificate-meta">
        <div>
          <dt>Recipient</dt>
          <dd>{doc.recipient}</dd>
        </div>
        <div>
          <dt>Issuer</dt>
          <dd>{doc.kind === "course" ? `${COMPANY_NAME} Learning & Development` : doc.issuer}</dd>
        </div>
        <div>
          <dt>{doc.kind === "course" ? "Completed" : "Issued"}</dt>
          <dd>{longDate(doc.issuedOn)}</dd>
        </div>
        <div>
          <dt>{doc.expired ? "Expired" : "Valid until"}</dt>
          <dd>{doc.expiresOn ? longDate(doc.expiresOn) : "No expiry"}</dd>
        </div>
        {doc.kind === "professional" && (
          <div>
            <dt>Status</dt>
            <dd>{doc.expired ? "Expired" : doc.verified ? "Verified by HR" : "Not verified"}</dd>
          </div>
        )}
        {doc.credentialId && (
          <div>
            <dt>Credential ID</dt>
            <dd>{doc.credentialId}</dd>
          </div>
        )}
      </dl>
      {error && <p className="note err">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Close
        </button>
        <button type="button" className="btn-ghost" onClick={() => printCertificate(doc)}>
          <Printer size={15} aria-hidden /> Print / Save as PDF
        </button>
        <button type="button" className="btn" onClick={download}>
          <Download size={15} aria-hidden /> Download
        </button>
      </div>
    </Dialog>
  );
}
