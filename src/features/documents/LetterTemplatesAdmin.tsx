/**
 * Letter templates admin (HR / admin, backend mode): the wording of every letter type, with a version per country or
 * per legal entity (entity wins over country, country over the default), placeholders, and a live preview with a
 * real employee's data. Backend: /letters/templates, /letters/placeholders, /letters/templates/preview.
 * Issued letters keep their PDF; a saved change applies to letters generated afterwards.
 */
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, apiRequest } from "../../api/client.ts";
import { attempt } from "../../api/syncRewardsShared.ts";
import { Banner, Card, EmptyState, Field, SubmitButton, notify, useAction } from "../../components/ui.tsx";
import { listPeople, subscribePeople } from "../../data/peopleLocal.ts";
import { TIMEZ_COUNTRIES, formatShortDate } from "../../model.ts";
import { LoadState, useServerValue } from "../payrequests/requestKit.tsx";
import "../../styles/documents.css";

interface TemplateOut {
  id: string;
  letter_type: string;
  country_code: string | null;
  legal_entity: string | null;
  title: string;
  to_whom: boolean;
  paragraphs: string[];
  version: number;
  active: boolean;
  updated_at: string;
}
interface TypeOut {
  type: string;
  label: string;
  employee_can_request: boolean;
  second_approval: boolean;
}
interface Placeholder {
  name: string;
  description: string;
}
interface PreviewOut {
  title: string;
  paragraphs: string[];
  missing: string[];
}

type Actor = { id: string; fullName: string; role: string };

const enc = encodeURIComponent;
const countryName = (code: string) => TIMEZ_COUNTRIES.find((c) => c.code === code)?.name ?? code;
const variantLabel = (t: TemplateOut) => (t.legal_entity ? t.legal_entity : t.country_code ? countryName(t.country_code) : "Default (all countries)");

async function loadAll() {
  const [types, templates, placeholders] = await Promise.all([
    api.get<TypeOut[]>("/letters/types"),
    api.get<TemplateOut[]>("/letters/templates"),
    api.get<Placeholder[]>("/letters/placeholders"),
  ]);
  return { types, templates, placeholders };
}

/** Server preview markup holds escaped text plus <b> tags; render it without innerHTML. */
function Markup({ text }: { text: string }) {
  const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");
  let bold = false;
  return (
    <>
      {text.split(/(<\/?b>)/i).map((part, i) => {
        if (/^<b>$/i.test(part)) {
          bold = true;
          return null;
        }
        if (/^<\/b>$/i.test(part)) {
          bold = false;
          return null;
        }
        const plain = decode(part.replace(/<[^>]*>/g, ""));
        return bold ? <strong key={i}>{plain}</strong> : <Fragment key={i}>{plain}</Fragment>;
      })}
    </>
  );
}

function Editor({ template, placeholders, actor, onSaved }: { template: TemplateOut; placeholders: Placeholder[]; actor: Actor; onSaved: (text: string) => void }) {
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const [title, setTitle] = useState(template.title);
  const [toWhom, setToWhom] = useState(template.to_whom);
  const [paragraphs, setParagraphs] = useState<string[]>(template.paragraphs);
  const [active, setActive] = useState(template.active);
  const [subject, setSubject] = useState(actor.id);
  const [preview, setPreview] = useState<PreviewOut | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const focused = useRef(0);
  const refs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const save = useAction();
  const isDefault = !template.country_code && !template.legal_entity;
  const dirty = title !== template.title || toWhom !== template.to_whom || active !== template.active || paragraphs.join("\n") !== template.paragraphs.join("\n");

  useEffect(() => {
    setTitle(template.title);
    setToWhom(template.to_whom);
    setParagraphs(template.paragraphs);
    setActive(template.active);
    setPreview(null);
    setPreviewError(null);
  }, [template]);

  const insert = (name: string) => {
    const i = Math.min(focused.current, paragraphs.length - 1);
    const el = refs.current[i];
    const token = `{${name}}`;
    const text = paragraphs[i] ?? "";
    const at = el ? el.selectionStart : text.length;
    const next = text.slice(0, at) + token + text.slice(el ? el.selectionEnd : text.length);
    setParagraphs(paragraphs.map((p, j) => (j === i ? next : p)));
    window.setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    }, 0);
  };

  const runPreview = async () => {
    setPreviewError(null);
    try {
      setPreview(
        await api.post<PreviewOut>("/letters/templates/preview", {
          letter_type: template.letter_type,
          title,
          to_whom: toWhom,
          paragraphs: paragraphs.filter((p) => p.trim()),
          employee_id: subject,
        }),
      );
    } catch (e) {
      setPreview(null);
      setPreviewError((e as Error).message || "Preview not available.");
    }
  };

  const sortedPeople = useMemo(() => [...people].sort((a, b) => a.fullName.localeCompare(b.fullName)), [people]);

  return (
    <form
      className="stack"
      onSubmit={save.submit(async () => {
        const body = paragraphs.map((p) => p.trim()).filter(Boolean);
        if (title.trim().length < 3) return "Give the letter a title (3 characters or more).";
        if (!body.length) return "Add at least one paragraph.";
        const err = await attempt(() =>
          apiRequest(`/letters/templates/${enc(template.id)}`, { method: "PUT", body: { title: title.trim(), to_whom: toWhom, paragraphs: body, ...(isDefault ? {} : { active }) } }),
        );
        if (err) return err;
        notify(`${template.letter_type} · ${variantLabel(template)} saved as version ${template.version + 1}.`);
        onSaved(`Saved as version ${template.version + 1}. Letters generated from now on use it; issued letters keep their PDF.`);
        return true;
      })}
    >
      <p className="note">
        Version {template.version} · updated {formatShortDate(template.updated_at.slice(0, 10))}
        {!template.active && " · switched off"}
      </p>
      <Field label="Letter title">
        <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} required />
      </Field>
      <label className="filter-label">
        <input type="checkbox" checked={toWhom} onChange={(e) => setToWhom(e.target.checked)} /> Starts with "To whom it may concern"
      </label>
      {!isDefault && (
        <label className="filter-label">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> In use (switched off, the {template.legal_entity ? "country or default" : "default"} wording applies)
        </label>
      )}
      <div>
        <h4>Placeholders</h4>
        <p className="note">Click to insert into the paragraph you last edited. Use &lt;b&gt;…&lt;/b&gt; for bold.</p>
        <div className="lt-placeholders">
          {placeholders.map((p) => (
            <button key={p.name} type="button" title={p.description} onClick={() => insert(p.name)}>
              {`{${p.name}}`}
            </button>
          ))}
        </div>
      </div>
      {paragraphs.map((p, i) => (
        <div key={i} className="lt-paragraph">
          <textarea
            ref={(el) => {
              refs.current[i] = el;
            }}
            rows={3}
            value={p}
            maxLength={2000}
            aria-label={`Paragraph ${i + 1}`}
            onFocus={() => {
              focused.current = i;
            }}
            onChange={(e) => setParagraphs(paragraphs.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <span className="pr-actions">
            <button type="button" className="quiet-link" disabled={i === 0} onClick={() => setParagraphs(paragraphs.map((x, j) => (j === i - 1 ? paragraphs[i] : j === i ? paragraphs[i - 1] : x)))}>
              Up
            </button>
            <button type="button" className="quiet-link" disabled={paragraphs.length <= 1} onClick={() => setParagraphs(paragraphs.filter((_, j) => j !== i))}>
              Remove
            </button>
          </span>
        </div>
      ))}
      <div className="pr-actions">
        <button type="button" className="btn-ghost btn-tiny" disabled={paragraphs.length >= 12} onClick={() => setParagraphs([...paragraphs, ""])}>
          Add paragraph
        </button>
      </div>
      <div className="form-actions">
        <label className="filter-label">
          Preview with
          <select value={subject} onChange={(e) => setSubject(e.target.value)}>
            {!sortedPeople.some((p) => p.id === actor.id) && <option value={actor.id}>{actor.fullName}</option>}
            {sortedPeople.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName} · {p.employeeCode}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn-ghost" onClick={() => void runPreview()}>
          Preview
        </button>
        <SubmitButton action={save} className="btn" disabled={!dirty}>
          Save new version
        </SubmitButton>
      </div>
      {previewError && <Banner message={{ tone: "err", text: previewError }} />}
      {preview && (
        <div className="lt-preview" aria-label="Letter preview">
          {preview.missing.length > 0 && <Banner message={{ tone: "warn", text: `This employee's record is missing: ${preview.missing.join(", ")}. The letter can't be generated until it's filled in.` }} />}
          {toWhom && <p>To whom it may concern,</p>}
          <h4>{preview.title}</h4>
          {preview.paragraphs.map((p, i) => (
            <p key={i}>
              <Markup text={p} />
            </p>
          ))}
          <p className="note">Letterhead, reference number, signature and footer are added when the PDF is generated.</p>
        </div>
      )}
    </form>
  );
}

function NewVariant({ type, templates, onCreated }: { type: string; templates: TemplateOut[]; onCreated: (id: string) => void }) {
  const people = useSyncExternalStore(subscribePeople, listPeople, listPeople);
  const [kind, setKind] = useState<"country" | "entity">("country");
  const [value, setValue] = useState("");
  const act = useAction();
  const entities = useMemo(() => [...new Set(people.map((p) => p.legalEntity).filter(Boolean))].sort(), [people]);
  const takenCountries = new Set(templates.filter((t) => t.country_code && !t.legal_entity).map((t) => t.country_code));
  const takenEntities = new Set(templates.filter((t) => t.legal_entity).map((t) => t.legal_entity!.toLowerCase()));
  const base = templates.find((t) => !t.country_code && !t.legal_entity) ?? templates[0];
  const options = kind === "country" ? TIMEZ_COUNTRIES.filter((c) => !takenCountries.has(c.code)).map((c) => ({ v: c.code, l: c.name })) : entities.filter((e) => !takenEntities.has(e.toLowerCase())).map((e) => ({ v: e, l: e }));
  if (!base) return null;
  return (
    <form
      className="form-actions"
      onSubmit={act.submit(async () => {
        if (!value) return kind === "country" ? "Choose a country." : "Choose a legal entity.";
        let id = "";
        const err = await attempt(async () => {
          const made = await api.post<TemplateOut>("/letters/templates", {
            letter_type: type,
            title: base.title,
            to_whom: base.to_whom,
            paragraphs: base.paragraphs,
            ...(kind === "country" ? { country_code: value } : { legal_entity: value }),
          });
          id = made.id;
        });
        if (err) return err;
        notify(`New ${kind === "country" ? countryName(value) : value} version created from the default wording.`);
        setValue("");
        onCreated(id);
        return true;
      })}
    >
      <label className="filter-label">
        New version for
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as "country" | "entity");
            setValue("");
          }}
        >
          <option value="country">a country</option>
          <option value="entity">a legal entity</option>
        </select>
      </label>
      <label className="filter-label">
        {kind === "country" ? "Country" : "Legal entity"}
        <select value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Choose…</option>
          {options.map((o) => (
            <option key={o.v} value={o.v}>
              {o.l}
            </option>
          ))}
        </select>
      </label>
      <SubmitButton action={act} className="btn-ghost" disabled={!value}>
        Create from default
      </SubmitButton>
    </form>
  );
}

export function LetterTemplatesAdmin({ actor }: { actor: Actor }) {
  const [tick, setTick] = useState(0);
  const [type, setType] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const data = useServerValue(loadAll, tick);
  const types = data.value?.types ?? [];
  const templates = data.value?.templates ?? [];
  const current = type || types[0]?.type || "";
  const ofType = templates.filter((t) => t.letter_type === current).sort((a, b) => Number(!!a.country_code || !!a.legal_entity) - Number(!!b.country_code || !!b.legal_entity) || variantLabel(a).localeCompare(variantLabel(b)));
  const selected = ofType.find((t) => t.id === templateId) ?? ofType[0];

  if (!data.value) return <LoadState error={data.error} onRetry={data.retry} />;
  return (
    <Card title="Letter templates">
      <Banner message={msg} />
      <p className="note">
        Each letter has default wording; add a version for a country or a legal entity where the wording must differ. The employee's legal entity version is used first, then their
        country's, then the default. Every save is a new version and is recorded in the audit log.
      </p>
      <div className="lt-admin">
        <div className="lt-list" role="list" aria-label="Letter types">
          {types.map((t) => {
            const n = templates.filter((x) => x.letter_type === t.type).length;
            return (
              <button
                key={t.type}
                type="button"
                aria-pressed={current === t.type}
                onClick={() => {
                  setType(t.type);
                  setTemplateId("");
                  setMsg(null);
                }}
              >
                <span>{t.label}</span>
                <small>{n > 1 ? `${n} versions` : "default"}</small>
              </button>
            );
          })}
        </div>
        <div className="stack">
          <div className="pr-choice-row lt-variants" role="group" aria-label="Versions">
            {ofType.map((t) => (
              <button key={t.id} type="button" className="pr-choice" aria-pressed={selected?.id === t.id} onClick={() => setTemplateId(t.id)}>
                {variantLabel(t)} <small>v{t.version}{t.active ? "" : " · off"}</small>
              </button>
            ))}
          </div>
          <NewVariant
            type={current}
            templates={ofType}
            onCreated={(id) => {
              setTemplateId(id);
              setTick((n) => n + 1);
            }}
          />
          {selected ? (
            <Editor
              template={selected}
              placeholders={data.value.placeholders}
              actor={actor}
              onSaved={(text) => {
                setMsg({ tone: "ok", text });
                setTick((n) => n + 1);
              }}
            />
          ) : (
            <EmptyState title="No template yet" description="The built-in wording is used for this letter." />
          )}
        </div>
      </div>
    </Card>
  );
}
