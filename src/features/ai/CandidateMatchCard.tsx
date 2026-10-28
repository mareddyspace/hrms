import { useEffect, useMemo, useState } from "react";
import type { Candidate, Requisition } from "../../data/talentData.ts";
import { API_ENABLED } from "../../api/client.ts";
import { apiCandidateMatch, type MatchOut } from "../../api/syncTalent.ts";
import { matchCandidate, needsForRequisition, type MatchResult } from "./candidateMatch.ts";
import { DraftTag } from "./DraftTag.tsx";
import "./ai.css";

/** Rule-based fit against the requisition, with interview questions aimed at the gaps. Backend mode: worked out by the server. */
export function CandidateMatchCard({ candidate, req }: { candidate: Candidate; req: Requisition | undefined }) {
  const needs = useMemo(() => (req && !API_ENABLED ? needsForRequisition(req) : null), [req]);
  const local = useMemo(() => (needs ? matchCandidate(candidate, needs) : null), [candidate, needs]);
  const [server, setServer] = useState<{ key: string; match: MatchOut | null; error?: string } | null>(null);
  // Refetch when the candidate's details change.
  const key = `${candidate.id}|${candidate.requisitionId}|${candidate.skills.join(",")}|${candidate.experienceYears}|${candidate.resumeNote}`;

  useEffect(() => {
    if (!API_ENABLED || !req) return;
    let live = true;
    apiCandidateMatch(candidate.id)
      .then((match) => live && setServer({ key, match }))
      .catch((error: unknown) => live && setServer({ key, match: null, error: error instanceof Error ? error.message : "The match could not be worked out." }));
    return () => {
      live = false;
    };
  }, [key, candidate.id, req]);

  if (!req) return null;
  if (API_ENABLED && (!server || server.key !== key)) return null;
  if (API_ENABLED && server && !server.match) return <p className="ai-note">Match to job: {server.error}</p>;
  const result: MatchResult | null = API_ENABLED ? (server?.match ?? null) : local;
  const source = API_ENABLED ? (server?.match?.source ?? "") : (needs?.source ?? "");
  if (!result) return null;

  return (
    <section className="ai-box" aria-label="Match to job">
      <div className="ai-head">
        <h3>Match to job · {req.title}</h3>
        <DraftTag text="Draft — for discussion only" />
      </div>
      <div className="ai-score">
        <span className="ai-score-num">{result.score}%</span>
        <div className="ai-score-track" role="progressbar" aria-valuenow={result.score} aria-valuemin={0} aria-valuemax={100}>
          <div className="ai-score-fill" style={{ width: `${result.score}%` }} />
        </div>
        <span className="muted">{result.band} fit</span>
      </div>
      <p>{result.summary}</p>
      <div className="ai-chips" aria-label="Skills">
        {result.matched.map((s) => (
          <span key={s} className="ai-chip is-ok">✓ {s}</span>
        ))}
        {result.missing.map((s) => (
          <span key={s} className="ai-chip is-miss">Missing: {s}</span>
        ))}
        {result.preferredMatched.map((s) => (
          <span key={`p-${s}`} className="ai-chip">Bonus: {s}</span>
        ))}
      </div>
      <p className="muted">
        Experience: {result.years} yrs vs {result.yearsNeeded}+ needed · Based on {source}.
      </p>
      <strong>Suggested interview questions</strong>
      <ol className="ai-bullets">
        {result.questions.map((q) => (
          <li key={q}>{q}</li>
        ))}
      </ol>
    </section>
  );
}
