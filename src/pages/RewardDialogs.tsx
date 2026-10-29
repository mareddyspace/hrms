import { useState, type ReactNode } from "react";
import { API_ENABLED } from "../api/client.ts";
import { ActionButton, Banner, Dialog, Field, SubmitButton, notify, useAction, type ActionResult } from "../components/ui.tsx";
import { DEMO_ACCOUNTS, type DemoAccount } from "../demoAccounts.ts";
import { todayISO } from "../model.ts";
import { DEPENDENT_RELATIONSHIPS, type CompCycle, type Dependent, type GradeBand } from "../data/rewardData.ts";
import {
  addBonus,
  addDependent,
  canProposeFor,
  createCompCycle,
  createCompProposal,
  currentPay,
  formatAmount,
  getRewardState,
  parseAmount,
  setPlanDependents,
  updateDependent,
  updateGradeBand,
  type RewardResult,
} from "../data/rewardLocal.ts";

type Done = (text: string) => void;

/** Success: toast the message, then let the parent show its notice and close the dialog. */
function finish(onDone: Done, text: string) {
  notify(text);
  onDone(text);
}

/** Shared shell: a form inside a dialog with an error line and Cancel / submit buttons. */
function FormDialog({
  open,
  title,
  submitLabel,
  onClose,
  onSubmit,
  error,
  children,
  extra,
}: {
  open: boolean;
  title: string;
  submitLabel: string;
  onClose: () => void;
  /** Return the error text (or false) on failure; anything else counts as success. */
  onSubmit: () => ActionResult | Promise<ActionResult>;
  error: string | null;
  children: ReactNode;
  extra?: ReactNode;
}) {
  const act = useAction();
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <form className="stack" onSubmit={act.submit(onSubmit)}>
        <div className="form-grid">{children}</div>
        {error && <Banner message={{ tone: "err", text: error }} />}
        <div className="dialog-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          {extra}
          <SubmitButton action={act} className="btn">
            {submitLabel}
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

const num = (v: string) => parseAmount(v);

/* ───────────── Compensation ───────────── */

export function NewCycleDialog({ actor, countries, onClose, onDone }: { actor: DemoAccount; countries: string[]; onClose: () => void; onDone: Done }) {
  const year = Number(todayISO().slice(0, 4));
  const [name, setName] = useState(`FY${year + 1} Annual compensation review`);
  const [opensOn, setOpensOn] = useState(todayISO());
  const [closesOn, setClosesOn] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(`${year + 1}-04-01`);
  const [budget, setBudget] = useState("8");
  const [picked, setPicked] = useState<string[]>(countries);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const err = await createCompCycle(actor, { name, opensOn, closesOn, effectiveDate, budgetPct: Number(budget), countries: picked });
    setError(err);
    if (!err) finish(onDone, `${name.trim()} created.`);
    return err;
  }

  return (
    <FormDialog open title="New review cycle" submitLabel="Create cycle" onClose={onClose} onSubmit={save} error={error}>
      <Field label="Name" wide>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
      </Field>
      <Field label="Opens">
        <input type="date" value={opensOn} onChange={(e) => setOpensOn(e.target.value)} required />
      </Field>
      <Field label="Closes">
        <input type="date" value={closesOn} onChange={(e) => setClosesOn(e.target.value)} required />
      </Field>
      <Field label="New pay effective">
        <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} required />
      </Field>
      <Field label="Budget (% of base)">
        <input type="number" min={0.1} max={50} step={0.1} value={budget} onChange={(e) => setBudget(e.target.value)} required />
      </Field>
      <div className="field wide">
        <span>Countries</span>
        <span className="checklist">
          {countries.map((c) => (
            <label key={c}>
              <input
                type="checkbox"
                checked={picked.includes(c)}
                onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c] : p.filter((x) => x !== c)))}
              />
              <span>{c}</span>
            </label>
          ))}
        </span>
      </div>
    </FormDialog>
  );
}

export function ProposeDialog({ actor, cycle, grades, onClose, onDone }: { actor: DemoAccount; cycle: CompCycle; grades: string[]; onClose: () => void; onDone: Done }) {
  const state = getRewardState();
  const people = DEMO_ACCOUNTS.filter(
    (a) =>
      canProposeFor(actor, a.id) &&
      (!a.countryName || cycle.countries.includes(a.countryName)) &&
      !state.reviews.some((r) => r.cycleId === cycle.id && r.employeeId === a.id && r.status !== "Rejected"),
  );
  const [employeeId, setEmployeeId] = useState(people[0]?.id ?? "");
  const pay = currentPay(state, employeeId);
  const person = people.find((p) => p.id === employeeId);
  const [grade, setGrade] = useState("");
  const [currentBase, setCurrentBase] = useState("");
  const [currentGrade, setCurrentGrade] = useState("");
  const [proposed, setProposed] = useState("");
  const [bonus, setBonus] = useState("");
  const [error, setError] = useState<string | null>(null);

  const base = pay ? parseAmount(pay.base) : num(currentBase);
  const pct = Number.isFinite(base) && base > 0 && num(proposed) > 0 ? Math.round(((num(proposed) - base) / base) * 1000) / 10 : null;

  // Backend mode: the manager enters the increase in percent; the server applies it to the current base
  // (which managers without pay access never see) and starts the approval chain straight away.
  const [increase, setIncrease] = useState("");
  const [busy, setBusy] = useState(false);
  const increasePct = increase.trim() === "" ? Number.NaN : Number(increase);

  async function save(submit: boolean) {
    if (busy) return false;
    setBusy(true);
    const err = await createCompProposal(actor, {
      cycleId: cycle.id,
      employeeId,
      proposedGrade: grade || pay?.grade || currentGrade,
      proposedBase: num(proposed),
      bonus: bonus.trim() ? num(bonus) : 0,
      currentBase: num(currentBase),
      currentGrade,
      submit,
      increasePct: API_ENABLED ? increasePct : undefined,
    });
    setBusy(false);
    setError(err);
    if (!err) finish(onDone, `${person?.fullName ?? "Proposal"}: ${submit || API_ENABLED ? "submitted" : "saved as draft"}.`);
    return err;
  }

  if (API_ENABLED && people.length) {
    return (
      <FormDialog open title={`Propose · ${cycle.name}`} submitLabel="Submit" onClose={onClose} onSubmit={() => save(true)} error={error}>
        <Field label="Employee" wide>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName} · {p.designation}
              </option>
            ))}
          </select>
        </Field>
        {pay && (
          <p className="note field wide">
            Current: {pay.grade} · {pay.base} (from {pay.effective})
          </p>
        )}
        <Field label="Proposed grade (optional)">
          <select value={grade} onChange={(e) => setGrade(e.target.value)}>
            <option value="">Keep current grade</option>
            {grades.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </Field>
        <Field label="Increase (%)">
          <input type="number" min={0} max={100} step={0.1} value={increase} onChange={(e) => setIncrease(e.target.value)} required />
        </Field>
        <Field label={`Bonus (optional, ${person?.currency ?? "INR"})`}>
          <input inputMode="numeric" value={bonus} onChange={(e) => setBonus(e.target.value)} />
        </Field>
        <p className="note field wide">
          {pay && Number.isFinite(increasePct) ? `New base about ${formatAmount(parseAmount(pay.base) * (1 + increasePct / 100), pay.currency)} · ` : ""}
          {cycle.budgetPct ? `Cycle budget ${cycle.budgetPct}%. ` : ""}Approvals follow the compensation workflow; amounts stay hidden from people without pay access.
        </p>
      </FormDialog>
    );
  }

  if (!people.length) {
    return (
      <Dialog open title="Propose a pay change" onClose={onClose}>
        <p className="note">Everyone you can propose for already has a proposal in this cycle.</p>
      </Dialog>
    );
  }

  return (
    <FormDialog
      open
      title={`Propose · ${cycle.name}`}
      submitLabel="Submit"
      onClose={onClose}
      onSubmit={() => save(true)}
      error={error}
      extra={
        <ActionButton className="btn-ghost" disabled={busy} onAction={() => save(false)}>
          Save draft
        </ActionButton>
      }
    >
      <Field label="Employee" wide>
        <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.fullName} · {p.designation}
            </option>
          ))}
        </select>
      </Field>
      {pay ? (
        <p className="note field wide">
          Current: {pay.grade} · {pay.base} (from {pay.effective})
        </p>
      ) : (
        <>
          <Field label={`Current base (${person?.currency ?? "INR"})`}>
            <input inputMode="numeric" value={currentBase} onChange={(e) => setCurrentBase(e.target.value)} required />
          </Field>
          <Field label="Current grade">
            <select value={currentGrade} onChange={(e) => setCurrentGrade(e.target.value)} required>
              <option value="">Pick</option>
              {grades.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </Field>
        </>
      )}
      <Field label="Proposed grade">
        <select value={grade || pay?.grade || currentGrade} onChange={(e) => setGrade(e.target.value)}>
          <option value="">Pick</option>
          {grades.map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
      </Field>
      <Field label={`Proposed base (${person?.currency ?? "INR"})`}>
        <input inputMode="numeric" value={proposed} onChange={(e) => setProposed(e.target.value)} required />
      </Field>
      <Field label="Bonus (optional)">
        <input inputMode="numeric" value={bonus} onChange={(e) => setBonus(e.target.value)} />
      </Field>
      <p className="note field">
        {pct === null ? " " : `Increase: ${pct}%${cycle.budgetPct ? ` · cycle budget ${cycle.budgetPct}%` : ""}`}
      </p>
    </FormDialog>
  );
}

export function BandDialog({ actor, band, onClose, onDone }: { actor: DemoAccount; band: GradeBand; onClose: () => void; onDone: Done }) {
  const [min, setMin] = useState(String(parseAmount(band.min)));
  const [mid, setMid] = useState(String(parseAmount(band.mid)));
  const [max, setMax] = useState(String(parseAmount(band.max)));
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const err = await updateGradeBand(actor, band.id, { min: num(min), mid: num(mid), max: num(max) });
    setError(err);
    if (!err) finish(onDone, `${band.grade} ${band.family} (${band.country}) range updated.`);
    return err;
  }
  return (
    <FormDialog open title={`${band.grade} · ${band.family} · ${band.country}`} submitLabel="Save range" onClose={onClose} onSubmit={save} error={error}>
      <Field label={`Min (${band.currency})`}>
        <input inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} required />
      </Field>
      <Field label={`Mid (${band.currency})`}>
        <input inputMode="numeric" value={mid} onChange={(e) => setMid(e.target.value)} required />
      </Field>
      <Field label={`Max (${band.currency})`}>
        <input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} required />
      </Field>
    </FormDialog>
  );
}

const BONUS_TYPES = ["Annual incentive", "Spot award", "Retention bonus", "Joining bonus", "Referral bonus"];

export function BonusDialog({ actor, onClose, onDone }: { actor: DemoAccount; onClose: () => void; onDone: Done }) {
  const people = DEMO_ACCOUNTS.filter((a) => a.id !== actor.id);
  const [employeeId, setEmployeeId] = useState(people[0]?.id ?? "");
  const [type, setType] = useState(BONUS_TYPES[1]);
  const [period, setPeriod] = useState(`Q${Math.floor(new Date().getMonth() / 3) + 1} ${new Date().getFullYear()}`);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const person = people.find((p) => p.id === employeeId);
  async function save() {
    const err: RewardResult = await addBonus(actor, { employeeId, type, period, amount: num(amount) });
    setError(err);
    if (!err) finish(onDone, `${type} recorded for ${person?.fullName ?? "employee"}.`);
    return err;
  }
  return (
    <FormDialog open title="Record a bonus" submitLabel="Save bonus" onClose={onClose} onSubmit={save} error={error}>
      <Field label="Employee" wide>
        <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          {people.map((p) => (
            <option key={p.id} value={p.id}>{p.fullName}</option>
          ))}
        </select>
      </Field>
      <Field label="Type">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {BONUS_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </Field>
      <Field label="Period">
        <input value={period} onChange={(e) => setPeriod(e.target.value)} maxLength={20} required />
      </Field>
      <Field label={`Amount (${person?.currency ?? "INR"})`}>
        <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </Field>
    </FormDialog>
  );
}

/* ───────────── Benefits ───────────── */

export function DependentDialog({ actor, row, onClose, onDone }: { actor: DemoAccount; row: Dependent | null; onClose: () => void; onDone: Done }) {
  const [name, setName] = useState(row?.name ?? "");
  const [relationship, setRelationship] = useState(row?.relationship ?? DEPENDENT_RELATIONSHIPS[0]);
  const [dob, setDob] = useState(row?.dateOfBirth ?? "");
  const [gender, setGender] = useState(row?.gender ?? "");
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const input = { name, relationship, dateOfBirth: dob, gender };
    const err = await (row ? updateDependent(actor, row.id, input) : addDependent(actor, input));
    setError(err);
    if (!err) finish(onDone, row ? `${name.trim()} updated. HR will verify the change.` : `${name.trim()} added. HR will verify.`);
    return err;
  }
  return (
    <FormDialog open title={row ? "Edit dependent" : "Add dependent"} submitLabel="Save" onClose={onClose} onSubmit={save} error={error}>
      <Field label="Full name" wide>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
      </Field>
      <Field label="Relationship">
        <select value={relationship} onChange={(e) => setRelationship(e.target.value)}>
          {DEPENDENT_RELATIONSHIPS.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </Field>
      <Field label="Date of birth">
        <input type="date" value={dob} max={todayISO()} onChange={(e) => setDob(e.target.value)} required />
      </Field>
      <Field label="Gender (optional)">
        <select value={gender} onChange={(e) => setGender(e.target.value)}>
          <option value="">Prefer not to say</option>
          <option value="Female">Female</option>
          <option value="Male">Male</option>
          <option value="Other">Other</option>
        </select>
      </Field>
    </FormDialog>
  );
}

/** Pick which verified dependents a plan covers. */
export function CoverDialog({
  actor,
  planId,
  planName,
  dependents,
  onClose,
  onDone,
}: {
  actor: DemoAccount;
  planId: string;
  planName: string;
  dependents: Dependent[];
  onClose: () => void;
  onDone: Done;
}) {
  const [picked, setPicked] = useState<string[]>(dependents.filter((d) => d.coveredPlans.includes(planName)).map((d) => d.id));
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const err = await setPlanDependents(actor, planId, picked);
    setError(err);
    if (!err) finish(onDone, `${planName}: cover updated.`);
    return err;
  }
  return (
    <FormDialog open title={`Who ${planName} covers`} submitLabel="Save" onClose={onClose} onSubmit={save} error={error}>
      <div className="field wide">
        {dependents.length ? (
          <span className="checklist">
            {dependents.map((d) => {
              const locked = d.verification !== "Verified" && !picked.includes(d.id);
              return (
                <label key={d.id}>
                  <input
                    type="checkbox"
                    disabled={locked}
                    checked={picked.includes(d.id)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, d.id] : p.filter((x) => x !== d.id)))}
                  />
                  <span>
                    {d.name} · {d.relationship}
                    {d.verification !== "Verified" && <span className="muted"> · {d.verification === "Rejected" ? "rejected by HR" : "awaiting HR check"}</span>}
                  </span>
                </label>
              );
            })}
          </span>
        ) : (
          <p className="note">Add dependents on the Dependents tab first.</p>
        )}
      </div>
    </FormDialog>
  );
}
