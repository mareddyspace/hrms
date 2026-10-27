import "./letterDocument.css";

/** Shows a print-ready letter document in a sandboxed frame (scripts off). */
export function LetterFrame({ html, title }: { html: string; title: string }) {
  return <iframe className="letter-frame" title={title} srcDoc={html} sandbox="" />;
}

/**
 * "Download PDF": loads the document into a hidden frame and opens the print dialog, where the
 * user picks "Save as PDF". The @page rules in the document set A4 and margins.
 */
export function printLetter(html: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  document.body.appendChild(frame);
  const cleanup = () => window.setTimeout(() => frame.remove(), 1000);
  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) return cleanup();
    win.addEventListener("afterprint", cleanup, { once: true });
    win.focus();
    win.print();
    // Some browsers don't fire afterprint for frames; remove after a minute regardless.
    window.setTimeout(() => frame.isConnected && frame.remove(), 60_000);
  };
  frame.srcdoc = html;
}

/** Fallback: save the letter as a standalone .html file. */
export function downloadLetterHtml(fileName: string, html: string): void {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName.endsWith(".html") ? fileName : `${fileName}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function LetterDownloadButtons({ html, fileName }: { html: string; fileName: string }) {
  return (
    <span className="letter-downloads">
      <button type="button" className="btn" onClick={() => printLetter(html)}>
        Download PDF
      </button>
      <button type="button" className="btn-ghost" onClick={() => downloadLetterHtml(fileName, html)}>
        Download .html
      </button>
    </span>
  );
}
