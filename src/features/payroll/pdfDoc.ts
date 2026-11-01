/**
 * A small PDF writer (no library): A4 pages, Helvetica / Helvetica-Bold text, lines and filled boxes.
 * Text is WinAnsi-encoded; characters outside it are replaced (₹ → "Rs", others → "?"), so amounts are written
 * with their ISO currency code (pdfMoney). Used for payslips, tax declaration previews and benefit plan summaries.
 */

export const A4 = { width: 595.28, height: 841.89 };

type Rgb = [number, number, number];
export type TextOptions = { size?: number; bold?: boolean; color?: Rgb; align?: "left" | "right" | "center" };

// Helvetica glyph widths (1/1000 em) for ASCII 32–126.
const WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278,
  584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
  667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
  278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

// Unicode → WinAnsi code points above 0x7F that differ from Latin-1.
const WIN_ANSI: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "‰": 0x89, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94,
  "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99,
};

/** Text as single-byte WinAnsi characters (a JS string whose char codes are the bytes). */
export function winAnsi(text: string): string {
  let out = "";
  for (const ch of text.replace(/₹\s?/g, "Rs ").replace(/ | /g, " ")) {
    const code = ch.codePointAt(0) ?? 63;
    if (code < 0x80) out += ch;
    else if (WIN_ANSI[ch] !== undefined) out += String.fromCharCode(WIN_ANSI[ch]);
    else if (code >= 0xa0 && code <= 0xff) out += ch;
    else out += "?";
  }
  return out;
}

export function textWidth(text: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of winAnsi(text)) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? WIDTHS[c - 32] : 556;
  }
  return (w * size * (bold ? 1.06 : 1)) / 1000;
}

const esc = (s: string) => winAnsi(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const num = (n: number) => (Math.round(n * 100) / 100).toString();
const rgb = (c: Rgb) => c.map((v) => num(v)).join(" ");

/** Amount with the ISO code, e.g. "INR 1,23,456.00" / "USD 7,000.00" (always readable in a PDF). */
export function pdfMoney(amount: number, currency = "INR"): string {
  const locale = currency === "INR" ? "en-IN" : "en-US";
  return `${currency} ${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)}`;
}

export class PdfDoc {
  private pages: string[][] = [];
  private ops: string[] = [];
  private title: string;
  constructor(title = "Document") {
    this.title = title;
    this.addPage();
  }

  addPage(): void {
    this.ops = [];
    this.pages.push(this.ops);
  }

  /** y is measured from the top of the page (like the screen). */
  text(x: number, yTop: number, text: string, o: TextOptions = {}): void {
    const size = o.size ?? 10;
    const w = textWidth(text, size, o.bold);
    const left = o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x;
    const y = A4.height - yTop - size;
    this.ops.push(`BT ${rgb(o.color ?? [0.1, 0.1, 0.12])} rg /${o.bold ? "F2" : "F1"} ${num(size)} Tf ${num(left)} ${num(y)} Td (${esc(text)}) Tj ET`);
  }

  /** Wraps to maxWidth; returns the height used. */
  paragraph(x: number, yTop: number, text: string, maxWidth: number, o: TextOptions = {}): number {
    const size = o.size ?? 10;
    const lead = size * 1.35;
    let line = "";
    let y = yTop;
    const flush = () => {
      if (line) this.text(x, y, line, o);
      y += lead;
      line = "";
    };
    for (const para of text.split("\n")) {
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (textWidth(next, size, o.bold) > maxWidth && line) {
          flush();
          line = word;
        } else line = next;
      }
      flush();
    }
    return y - yTop;
  }

  line(x1: number, y1Top: number, x2: number, y2Top: number, width = 0.5, color: Rgb = [0.8, 0.82, 0.86]): void {
    this.ops.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(A4.height - y1Top)} m ${num(x2)} ${num(A4.height - y2Top)} l S`);
  }

  box(x: number, yTop: number, w: number, h: number, fill: Rgb): void {
    this.ops.push(`${rgb(fill)} rg ${num(x)} ${num(A4.height - yTop - h)} ${num(w)} ${num(h)} re f`);
  }

  toBytes(): Uint8Array {
    const objects: string[] = [];
    const pageIds: number[] = [];
    // 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then page + content pairs.
    const first = 6;
    this.pages.forEach((ops, i) => {
      const content = ops.join("\n");
      const pageId = first + i * 2;
      pageIds.push(pageId);
      objects[pageId] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(A4.width)} ${num(A4.height)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
      objects[pageId + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    });
    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
    objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
    objects[5] = `<< /Title (${esc(this.title)}) /Producer (TimeZ HRMS) /Creator (TimeZ HRMS) >>`;
    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets: number[] = [];
    for (let id = 1; id < objects.length; id += 1) {
      offsets[id] = out.length;
      out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i += 1) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }

  toBlob(): Blob {
    return new Blob([this.toBytes() as BlobPart], { type: "application/pdf" });
  }
}

/** Saves a blob as a file (a link click). */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
