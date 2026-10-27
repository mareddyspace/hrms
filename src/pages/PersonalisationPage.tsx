import { ArrowDown, ArrowUp, Eye, EyeOff, Star, StarOff } from "lucide-react";
import { Card, Page } from "../components/ui.tsx";
import {
  DEFAULT_PREFERENCES,
  resetPreferences,
  updatePreferences,
  usePreferences,
  type Preferences,
} from "../data/preferences.ts";
import { filterNavForAccount, filterPinnedForAccount } from "../nav.ts";
import { usePortal } from "../store.tsx";

type Choice<T extends string> = { value: T; label: string };

function Choices<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Choice<T>[];
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div className="pref-choices" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="btn-ghost btn-tiny"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function move<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function PersonalisationPage() {
  const { employee, demoProfile } = usePortal();
  const prefs = usePreferences(employee.id);
  const set = (patch: Partial<Preferences>) => updatePreferences(employee.id, patch);

  const groups = filterNavForAccount(demoProfile);
  const pages = [...filterPinnedForAccount(demoProfile), ...groups.flatMap((group) => group.links)];

  // Home sections in the person's order (sections they never moved keep the page's order).
  const sections = [...prefs.knownHomeSections].sort((a, b) => {
    const rank = (id: string) => {
      const i = prefs.homeOrder.indexOf(id);
      return i === -1 ? prefs.homeOrder.length + prefs.knownHomeSections.findIndex((s) => s.id === id) : i;
    };
    return rank(a.id) - rank(b.id);
  });
  const favourites = prefs.favourites.filter((id) => pages.some((page) => page.id === id));

  return (
    <Page title="Personalisation">
      <div className="split">
        <Card title="Look">
          <div className="pref-row">
            <strong>Theme</strong>
            <Choices
              label="Theme"
              value={prefs.theme}
              onChange={(theme) => set({ theme })}
              options={[
                { value: "light", label: "Light" },
                { value: "night", label: "Dark" },
                { value: "system", label: "Match device" },
              ]}
            />
          </div>
          <div className="pref-row">
            <strong>Text size</strong>
            <Choices
              label="Text size"
              value={prefs.textSize}
              onChange={(textSize) => set({ textSize })}
              options={[
                { value: "small", label: "Small" },
                { value: "default", label: "Default" },
                { value: "large", label: "Large" },
                { value: "xlarge", label: "Extra large" },
              ]}
            />
          </div>
          <div className="pref-row">
            <strong>Spacing</strong>
            <Choices
              label="Spacing"
              value={prefs.density}
              onChange={(density) => set({ density })}
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
            />
          </div>
          <div className="pref-row">
            <strong>Menu</strong>
            <Choices
              label="Menu"
              value={prefs.menuStyle}
              onChange={(menuStyle) => set({ menuStyle })}
              options={[
                { value: "full", label: "Full menu" },
                { value: "icons", label: "Icons only" },
              ]}
            />
          </div>
          <div className="pref-row">
            <strong>Animations</strong>
            <Choices
              label="Animations"
              value={prefs.reduceMotion ? "off" : "on"}
              onChange={(v) => set({ reduceMotion: v === "off" })}
              options={[
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
            />
          </div>
        </Card>

        <Card title="Start page">
          <div className="pref-row">
            <span>Open after sign-in</span>
            <select value={prefs.startPage} onChange={(event) => set({ startPage: event.target.value })} aria-label="Start page">
              {pages.map((page) => (
                <option key={page.id} value={page.to}>
                  {page.label}
                </option>
              ))}
            </select>
          </div>
        </Card>
      </div>

      <div className="split">
        <Card title="Home page order">
          {sections.length === 0 ? (
            <p className="muted">No sections yet.</p>
          ) : (
            <ul className="pref-order">
              {sections.map((section, index) => {
                const hidden = prefs.homeHidden.includes(section.id);
                return (
                  <li key={section.id} className={hidden ? "hidden-section" : undefined}>
                    <span>{section.label}</span>
                    <button
                      type="button"
                      className="btn-ghost btn-tiny"
                      aria-label={`Move ${section.label} up`}
                      disabled={index === 0}
                      onClick={() => set({ homeOrder: move(sections.map((s) => s.id), index, -1) })}
                    >
                      <ArrowUp size={14} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-tiny"
                      aria-label={`Move ${section.label} down`}
                      disabled={index === sections.length - 1}
                      onClick={() => set({ homeOrder: move(sections.map((s) => s.id), index, 1) })}
                    >
                      <ArrowDown size={14} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-tiny"
                      aria-label={hidden ? `Show ${section.label}` : `Hide ${section.label}`}
                      onClick={() =>
                        set({
                          homeHidden: hidden
                            ? prefs.homeHidden.filter((id) => id !== section.id)
                            : [...prefs.homeHidden, section.id],
                        })
                      }
                    >
                      {hidden ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Favourite pages">
          <ul className="pref-order">
            {favourites.map((id, index) => {
              const page = pages.find((p) => p.id === id)!;
              return (
                <li key={id}>
                  <span>{page.label}</span>
                  <button
                    type="button"
                    className="btn-ghost btn-tiny"
                    aria-label={`Move ${page.label} up`}
                    disabled={index === 0}
                    onClick={() => set({ favourites: move(favourites, index, -1) })}
                  >
                    <ArrowUp size={14} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-tiny"
                    aria-label={`Move ${page.label} down`}
                    disabled={index === favourites.length - 1}
                    onClick={() => set({ favourites: move(favourites, index, 1) })}
                  >
                    <ArrowDown size={14} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-tiny"
                    aria-label={`Unpin ${page.label}`}
                    onClick={() => set({ favourites: favourites.filter((f) => f !== id) })}
                  >
                    <StarOff size={14} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="pref-row">
            <span>Add a page</span>
            <select
              value=""
              aria-label="Add a favourite page"
              onChange={(event) => {
                if (event.target.value) set({ favourites: [...favourites, event.target.value] });
              }}
            >
              <option value="">Choose…</option>
              {pages
                .filter((page) => page.to !== "/" && !favourites.includes(page.id))
                .map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.label}
                  </option>
                ))}
            </select>
          </div>
          {favourites.length === 0 && (
            <p className="muted">
              <Star size={13} aria-hidden /> No favourites yet.
            </p>
          )}
        </Card>
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => resetPreferences(employee.id)}
          disabled={JSON.stringify({ ...prefs, knownHomeSections: [] }) === JSON.stringify(DEFAULT_PREFERENCES)}
        >
          Reset to default
        </button>
      </div>
    </Page>
  );
}
