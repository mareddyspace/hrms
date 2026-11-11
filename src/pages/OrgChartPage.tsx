import { useEffect, useRef, useState } from "react";
import type { FocusEvent, MouseEvent } from "react";
import { Link } from "react-router-dom";
import { UserRound } from "lucide-react";
import { Card, Page } from "../components/ui.tsx";
import { OrgChart } from "../components/OrgChart.tsx";
import { usePortal } from "../store.tsx";
import "../styles/calendar-people.css";

type Hover = { id: string; name: string; title: string; top: number; left: number };

/** The person card under the pointer (or keyboard focus), read from the chart's own markup. */
function cardInfo(target: EventTarget | null, wrap: HTMLElement): Hover | null {
  const card = (target as HTMLElement | null)?.closest?.("article.orgchart-card[data-org-id]") as HTMLElement | null;
  if (!card || card.classList.contains("is-vacancy") || !wrap.contains(card)) return null;
  const id = card.dataset.orgId ?? "";
  const name = card.querySelector(".orgchart-text strong")?.textContent?.trim() ?? "";
  const title = card.querySelector(".orgchart-role")?.textContent?.trim() ?? "";
  if (!id || !name) return null;
  const box = card.getBoundingClientRect();
  const outer = wrap.getBoundingClientRect();
  return { id, name, title, top: box.bottom - outer.top + 6, left: Math.max(0, box.left - outer.left) };
}

export function OrgChartPage() {
  const { employee } = usePortal();
  const wrap = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  function cancelHide() {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }
  function hideSoon() {
    cancelHide();
    hideTimer.current = window.setTimeout(() => setHover(null), 250);
  }
  useEffect(() => cancelHide, []);

  function show(event: MouseEvent | FocusEvent) {
    if (!wrap.current) return;
    if ((event.target as HTMLElement).closest?.(".org-hovercard")) {
      cancelHide();
      return;
    }
    const info = cardInfo(event.target, wrap.current);
    if (info) {
      cancelHide();
      setHover((current) => (current?.id === info.id ? current : info));
    } else if (hover) hideSoon();
  }

  return (
    <Page title="Org chart">
      <Card title="Reporting lines">
        <div
          ref={wrap}
          className="org-hover-wrap"
          onMouseOver={show}
          onMouseLeave={hideSoon}
          onFocus={show}
          onKeyDown={(event) => {
            if (event.key === "Escape") setHover(null);
          }}
        >
          <OrgChart />
          {hover && (
            <div
              className="org-hovercard"
              role="tooltip"
              style={{ top: hover.top, left: hover.left }}
              onMouseEnter={cancelHide}
              onMouseLeave={hideSoon}
            >
              <strong>{hover.name}</strong>
              {hover.title && <span className="muted">{hover.title}</span>}
              <Link className="btn btn-tiny" to={hover.id === employee.id ? "/info" : `/people/${hover.id}`}>
                <UserRound size={14} aria-hidden /> {hover.id === employee.id ? "View my profile" : "Visit profile"}
              </Link>
            </div>
          )}
        </div>
      </Card>
    </Page>
  );
}
