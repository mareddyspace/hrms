/*
 * Public pages, no sign-in: the careers page (open job posts and the application form) and the candidate's offer
 * page (reached through the link the recruiter passes on). Backend mode talks to /public/*; without the backend they
 * read and write this browser's demo data.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, useParams } from "react-router-dom";
import { ActionButton, Banner, Field, SubmitButton, useAction } from "../components/ui.tsx";
import { API_ENABLED } from "../api/client.ts";
import { apiAnswerOffer, apiApplyCareers, apiCareerPost, apiCareers, apiErrorText, apiPublicOffer, type PublicOfferOut, type PublicPostingOut } from "../api/syncTalent.ts";
import { answerOfferByToken, applyFromCareers, getTalentState, offerByToken, openPostings, requisitionByPosting, subscribeTalent } from "../data/talentLocal.ts";
import type { Requisition } from "../data/talentData.ts";
import { letterDocumentHtml, offerLetterHtml } from "../data/letterTemplates.ts";
import { formatShortDate } from "../model.ts";
import { money } from "../countryPay.ts";
import { COMPANY_NAME } from "../brand.ts";
import "./publicHiring.css";

/** "Bengaluru, India" stays as it is; "Bengaluru" + "India" becomes "Bengaluru, India" (no "India, India"). */
function placeOf(location: string, country: string): string {
  if (!country || location.trim().toLowerCase().endsWith(country.trim().toLowerCase())) return location;
  return location ? `${location}, ${country}` : country;
}

type Msg = { tone: "ok" | "err"; text: string } | null;

function toPublic(r: Requisition): PublicPostingOut {
  const p = r.posting!;
  return { id: p.id, title: p.title, department: r.department, location: p.location, country_name: r.country, employment_type: p.employmentType, description: p.description, closing_date: p.closingDate, openings: r.openings };
}

function useLocalPostings(): PublicPostingOut[] {
  const talent = useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
  return useMemo(() => openPostings(talent.requisitions, true).map(toPublic), [talent.requisitions]);
}

function PublicShell({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    document.title = `Careers · ${COMPANY_NAME}`;
  }, []);
  return (
    <div className="pub">
      <header className="pub-head">
        <Link to="/careers" className="pub-brand">{COMPANY_NAME} careers</Link>
      </header>
      <main className="pub-main">{children}</main>
    </div>
  );
}

export function CareersPage() {
  const local = useLocalPostings();
  const [rows, setRows] = useState<PublicPostingOut[] | null>(API_ENABLED ? null : local);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!API_ENABLED) return;
    apiCareers().then(setRows, (e: unknown) => setError(apiErrorText(e)));
  }, []);
  const list = API_ENABLED ? rows : local;
  return (
    <PublicShell>
      <h1>Open jobs</h1>
      {error && <p className="note err">{error}</p>}
      {!list ? (
        <p className="muted">Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted">No open jobs right now. Check back soon.</p>
      ) : (
        <ul className="pub-list">
          {list.map((p) => (
            <li key={p.id} className="card">
              <Link to={`/careers/${p.id}`} className="pub-title">{p.title}</Link>
              <p className="muted">
                {p.department} · {placeOf(p.location, p.country_name)} · {p.employment_type} · apply by {formatShortDate(p.closing_date)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </PublicShell>
  );
}

const EMPTY = { name: "", email: "", phone: "", coverNote: "", website: "" };

export function CareerPostPage() {
  const { postingId = "" } = useParams();
  const talent = useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
  const localReq = API_ENABLED ? undefined : requisitionByPosting(talent.requisitions, postingId);
  const localPost = localReq && openPostings([localReq], true).length ? toPublic(localReq) : null;
  const [server, setServer] = useState<PublicPostingOut | null | undefined>(undefined);
  const [form, setForm] = useState(EMPTY);
  const [cv, setCv] = useState<File | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [sent, setSent] = useState(false);
  const action = useAction();
  useEffect(() => {
    if (!API_ENABLED) return;
    apiCareerPost(postingId).then(setServer, () => setServer(null));
  }, [postingId]);
  const post = API_ENABLED ? server : localPost;
  const set = (patch: Partial<typeof EMPTY>) => setForm((f) => ({ ...f, ...patch }));

  if (post === undefined) return <PublicShell><p className="muted">Loading…</p></PublicShell>;
  if (!post) {
    return (
      <PublicShell>
        <h1>This job is not open</h1>
        <p><Link to="/careers">See open jobs</Link></p>
      </PublicShell>
    );
  }

  async function submit(): Promise<string | null> {
    const error = API_ENABLED ? await apiApplyCareers(postingId, { ...form, cvFile: cv }) : applyFromCareers(postingId, { ...form, cvFile: cv });
    setMsg(error ? { tone: "err", text: error } : null);
    if (!error) setSent(true);
    return error;
  }

  return (
    <PublicShell>
      <p><Link to="/careers">← All jobs</Link></p>
      <h1>{post.title}</h1>
      <p className="muted">
        {post.department} · {placeOf(post.location, post.country_name)} · {post.employment_type} · {post.openings} {post.openings === 1 ? "opening" : "openings"} · apply by {formatShortDate(post.closing_date)}
      </p>
      <div className="pub-desc">{post.description}</div>
      <section className="card">
        <h2>Apply</h2>
        {sent ? (
          <p className="note ok">Thanks, {form.name.trim().split(" ")[0]}. Your application for {post.title} is in. The recruiting team will be in touch by email.</p>
        ) : (
          <form className="stack" onSubmit={action.submit(submit)}>
            <div className="form-grid-2">
              <Field label="Full name">
                <input value={form.name} maxLength={200} autoComplete="name" onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <Field label="Email">
                <input type="email" value={form.email} maxLength={255} autoComplete="email" onChange={(e) => set({ email: e.target.value })} />
              </Field>
              <Field label="Phone">
                <input type="tel" value={form.phone} maxLength={64} autoComplete="tel" onChange={(e) => set({ phone: e.target.value })} />
              </Field>
              <Field label="CV (PDF, DOC, DOCX or TXT, up to 5 MB)">
                <input type="file" accept=".pdf,.doc,.docx,.txt" onChange={(e) => setCv(e.target.files?.[0] ?? null)} />
              </Field>
              <Field label="Cover note (optional)" wide>
                <textarea rows={4} maxLength={3000} value={form.coverNote} onChange={(e) => set({ coverNote: e.target.value })} />
              </Field>
            </div>
            {/* Left empty by people; bots fill it in. */}
            <input className="pub-trap" tabIndex={-1} autoComplete="off" aria-hidden="true" value={form.website} onChange={(e) => set({ website: e.target.value })} />
            <Banner message={msg} />
            <div>
              <SubmitButton action={action} className="btn" disabled={!form.name.trim() || !form.email.trim() || !cv}>
                Send application
              </SubmitButton>
            </div>
          </form>
        )}
      </section>
    </PublicShell>
  );
}

type OfferView = Pick<PublicOfferOut, "candidate_name" | "title" | "department" | "location" | "grade" | "base_salary" | "currency" | "start_date" | "status" | "responded_on" | "letter">;

const LOCAL_STATUS: Record<string, OfferView["status"]> = { Sent: "sent", Accepted: "accepted", Declined: "declined" };

function localOffer(token: string): OfferView | null {
  const hit = offerByToken(token);
  if (!hit) return null;
  const { offer, req, candidate } = hit;
  return {
    candidate_name: candidate?.name ?? offer.candidateName,
    title: req?.title ?? offer.role,
    department: req?.department ?? "",
    location: req?.location ?? "",
    grade: offer.grade,
    base_salary: offer.baseSalary,
    currency: offer.currency,
    start_date: offer.startDate,
    status: LOCAL_STATUS[offer.status] ?? "withdrawn",
    responded_on: offer.respondedOn ?? null,
    letter: offer.letter ?? null,
  };
}

export function OfferAnswerPage() {
  const { token = "" } = useParams();
  useSyncExternalStore(subscribeTalent, getTalentState, getTalentState);
  const [server, setServer] = useState<OfferView | null | undefined>(undefined);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [declining, setDeclining] = useState(false);
  const accept = useAction();
  const decline = useAction();
  useEffect(() => {
    if (!API_ENABLED) return;
    apiPublicOffer(token).then(setServer, () => setServer(null));
  }, [token]);
  const offer = API_ENABLED ? server : localOffer(token);

  if (offer === undefined) return <PublicShell><p className="muted">Loading…</p></PublicShell>;
  if (!offer) {
    return (
      <PublicShell>
        <h1>This offer link is not valid</h1>
        <p className="muted">Ask the recruiter who sent it for a new link.</p>
      </PublicShell>
    );
  }

  async function answer(yes: boolean): Promise<string | null> {
    try {
      if (API_ENABLED) setServer(await apiAnswerOffer(token, yes, note));
      else {
        const error = answerOfferByToken(token, yes, note);
        if (error) throw new Error(error);
      }
      setMsg({ tone: "ok", text: yes ? "Thank you. Your acceptance is recorded — HR will be in touch about your first day." : "Your answer is recorded. Thank you for letting us know." });
      return null;
    } catch (e) {
      const text = apiErrorText(e);
      setMsg({ tone: "err", text });
      return text;
    }
  }

  const html = offer.letter ? letterDocumentHtml(offerLetterHtml(offer.letter, API_ENABLED), { title: offer.letter.title, draft: false }) : "";
  return (
    <PublicShell>
      <h1>Your offer, {offer.candidate_name.split(" ")[0]}</h1>
      <p>
        <strong>{offer.title}</strong> · {offer.department} · {offer.location} · grade {offer.grade} · {money(offer.base_salary, offer.currency)} a year · start {formatShortDate(offer.start_date)}
      </p>
      {html && <iframe className="pub-letter" title="Offer letter" srcDoc={html} sandbox="" />}
      <Banner message={msg} />
      {offer.status === "sent" ? (
        <section className="card stack">
          <Field label={declining ? "Reason (optional)" : "Message to the team (optional)"} wide>
            <input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="row-gap">
            {!declining ? (
              <>
                <ActionButton action={accept} className="btn" onAction={() => answer(true)}>
                  Accept offer
                </ActionButton>
                <button type="button" className="btn-ghost" onClick={() => setDeclining(true)}>
                  Decline
                </button>
              </>
            ) : (
              <>
                <ActionButton action={decline} className="btn" onAction={() => answer(false)}>
                  Decline offer
                </ActionButton>
                <button type="button" className="btn-ghost" onClick={() => setDeclining(false)}>
                  Back
                </button>
              </>
            )}
          </div>
        </section>
      ) : (
        <p className="note">
          {offer.status === "accepted"
            ? `You accepted this offer${offer.responded_on ? ` on ${formatShortDate(offer.responded_on)}` : ""}. Welcome aboard!`
            : offer.status === "declined"
              ? `You declined this offer${offer.responded_on ? ` on ${formatShortDate(offer.responded_on)}` : ""}.`
              : "This offer is no longer open."}
        </p>
      )}
    </PublicShell>
  );
}
