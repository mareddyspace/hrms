import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * The section's pages as tabs above the page: a sliding underline follows the active tab, and when the tabs
 * don't fit, the row scrolls (arrows at the edges) and keeps the active tab in view.
 * Children are the tab links; the active one carries the "active" class.
 */
export function SectionTabs({ label, title, watch, children }: { label: string; title: ReactNode; watch: string; children: ReactNode }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  // The first placement jumps straight to the active tab; later page changes glide.
  const placed = useRef(false);

  const measure = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    const active = row.querySelector<HTMLElement>(".section-tab.active");
    setBar((prev) => {
      if (!active) return null;
      const next = { left: active.offsetLeft, width: active.offsetWidth };
      return prev && prev.left === next.left && prev.width === next.width ? prev : next;
    });
    const left = row.scrollLeft > 2;
    const right = row.scrollLeft + row.clientWidth < row.scrollWidth - 2;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  // New page: move the underline and bring the active tab into view.
  useLayoutEffect(() => {
    measure();
    const row = rowRef.current;
    const active = row?.querySelector<HTMLElement>(".section-tab.active");
    if (!row || !active) return;
    const pad = 40;
    const start = active.offsetLeft;
    const end = start + active.offsetWidth;
    let target: number | null = null;
    if (start - pad < row.scrollLeft) target = Math.max(0, start - pad);
    else if (end + pad > row.scrollLeft + row.clientWidth) target = end + pad - row.clientWidth;
    if (target !== null) row.scrollTo({ left: target, behavior: !placed.current || reducedMotion() ? "auto" : "smooth" });
    placed.current = true;
  }, [pathname, watch, measure]);

  // Tab widths change with badges, fonts and the window size.
  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(row);
    row.querySelectorAll(".section-tab").forEach((tab) => observer.observe(tab));
    return () => observer.disconnect();
  }, [watch, measure]);

  function nudge(direction: -1 | 1) {
    const row = rowRef.current;
    if (!row) return;
    row.scrollBy({ left: direction * Math.max(120, row.clientWidth * 0.6), behavior: reducedMotion() ? "auto" : "smooth" });
  }

  return (
    <nav className="section-tabs" aria-label={label}>
      <span className="section-tabs-title">{title}</span>
      <div className={`section-tabs-scroller${edges.left ? " fade-left" : ""}${edges.right ? " fade-right" : ""}`}>
        {edges.left && (
          <button type="button" className="section-tabs-arrow left" aria-label="Scroll tabs left" onClick={() => nudge(-1)}>
            <ChevronLeft size={16} />
          </button>
        )}
        <div className="section-tabs-row" ref={rowRef} onScroll={measure}>
          {children}
          {bar && <span className="section-tabs-indicator" aria-hidden="true" style={{ width: bar.width, transform: `translateX(${bar.left}px)` }} />}
        </div>
        {edges.right && (
          <button type="button" className="section-tabs-arrow right" aria-label="Scroll tabs right" onClick={() => nudge(1)}>
            <ChevronRight size={16} />
          </button>
        )}
      </div>
    </nav>
  );
}
