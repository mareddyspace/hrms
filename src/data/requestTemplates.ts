import { useRef, useState } from "react";

/**
 * Starter text for request forms. When someone picks a type, category or reason, the matching
 * template is placed in the description box. "___" marks a blank the person must fill in;
 * submitting while a blank is left is rejected.
 */
export const TEMPLATE_BLANK = "___";
export const TEMPLATE_BLANKS_ERROR = "Fill in the blanks in the description.";

const DEFAULT = "*";

export const REQUEST_TEMPLATES = {
  leave: {
    pto: "Taking planned time off for ___. Work handed over to ___.",
    casual: "Need the day off for ___.",
    sick: "Unwell and advised rest. Expected back on ___.",
    wfh: "Working from home due to ___. Reachable on chat and phone.",
    emergency_wfh: "Need to work from home urgently because ___. Reachable on chat and phone.",
    comp_off: "Compensatory off for working on ___ (___).",
    unpaid: "Requesting unpaid leave for ___. Work handed over to ___.",
    bereavement: "Bereavement leave following the loss of my ___.",
    [DEFAULT]: "Requesting leave for ___.",
  },
  leavePermission: {
    sick: "Was unwell on these dates and could not apply in time because ___.",
    [DEFAULT]: "Requesting permission to apply for past dates. I was away because ___ and could not apply in time because ___.",
  },
  expense: {
    Travel: "Travel from ___ to ___ for ___ (client/project).",
    Food: "Meal during ___ with ___ (client/team).",
    Lodging: "Stay at ___ from ___ to ___ for ___.",
    Supplies: "Purchased ___ for ___.",
    Other: "Expense for ___ because ___.",
    [DEFAULT]: "Expense for ___ because ___.",
  },
  reimbursement: {
    Internet: "Home internet bill for ___ (month), used for work.",
    Books: "Purchased ___ (book/course) for ___.",
    Medical: "Medical expense for ___ on ___.",
    Conveyance: "Travel from ___ to ___ on ___ for work.",
    Other: "Reimbursement for ___ because ___.",
    [DEFAULT]: "Reimbursement for ___ because ___.",
  },
  cashAdvance: {
    "Business trip": "Advance for trip to ___ from ___ to ___. Estimated costs: ___.",
    "Client entertainment": "Advance for meeting with ___ (client) on ___. Estimated cost: ___.",
    "Local conveyance": "Advance for local travel to ___ on ___ for ___.",
    "Training / event": "Advance to attend ___ (training/event) on ___. Covers ___.",
    "Emergency purchase": "Urgent purchase of ___ needed because ___.",
    Other: "Advance needed for ___ because ___.",
    [DEFAULT]: "Advance needed for ___ because ___.",
  },
  asset: {
    Laptop: "Replacement/new laptop needed because ___.",
    Monitor: "Additional monitor needed for ___.",
    "Keyboard and mouse": "Keyboard/mouse needed because ___.",
    Headset: "Headset needed for ___ (calls/meetings).",
    "Mobile phone": "Work phone needed for ___.",
    "Docking station": "Docking station needed to connect ___.",
    Chair: "Ergonomic chair needed because ___.",
    [DEFAULT]: "Need ___ because ___.",
  },
  software: {
    [DEFAULT]: "Need ___ for ___. Used ___ times a week.",
  },
  hrRequest: {
    "Payroll provider": "Question about my payslip for ___: ___.",
    Benefits: "Query about my ___ benefit: ___.",
    Documents: "Please issue a ___ letter for ___ (purpose). Needed by ___.",
    Leave: "Query about my ___ leave balance: ___.",
    "Profile correction": "Please update my ___ from ___ to ___.",
    Other: "I need help with ___.",
    [DEFAULT]: "I need help with ___.",
  },
  grievance: {
    Grievance: "On ___ at ___, ___ happened. It affected me by ___. I have already tried ___.",
    "Harassment/POSH": "On ___ at ___, I experienced ___. Witnesses (if any): ___.",
    Discrimination: "On ___, I was treated unfairly when ___. I believe this was because of ___.",
    "Ethics/whistleblowing": "I want to report ___ observed on ___ at ___. Evidence available: ___.",
    Safety: "Safety concern at ___ (location): ___. First noticed on ___.",
    [DEFAULT]: "On ___ at ___, ___ happened.",
  },
  resignation: {
    "Career growth": "I am resigning from my role as ___ to pursue a new opportunity. My last working day will be ___.",
    Compensation: "I am resigning from my role as ___. My last working day will be ___.",
    Relocation: "I am resigning from my role as ___ as I am relocating to ___. My last working day will be ___.",
    "Higher studies": "I am resigning from my role as ___ to pursue ___. My last working day will be ___.",
    [DEFAULT]: "I am resigning from my role as ___. My last working day will be ___.",
  },
} satisfies Record<string, Record<string, string>>;

export type TemplateForm = keyof typeof REQUEST_TEMPLATES;

/** Common assets offered as suggestions in the asset request form. */
export const ASSET_SUGGESTIONS = Object.keys(REQUEST_TEMPLATES.asset).filter((key) => key !== DEFAULT);

/** Template for an option, falling back to the form's default. Empty option gives "". */
export function requestTemplate(form: TemplateForm, option: string): string {
  if (!option.trim()) return "";
  const table: Record<string, string> = REQUEST_TEMPLATES[form];
  const exact = table[option] ?? Object.entries(table).find(([key]) => key.toLowerCase() === option.trim().toLowerCase())?.[1];
  return exact ?? table[DEFAULT] ?? "";
}

/** True when the form has its own template for this option (not just the fallback). */
export function hasOwnTemplate(form: TemplateForm, option: string): boolean {
  const table: Record<string, string> = REQUEST_TEMPLATES[form];
  return Object.keys(table).some((key) => key !== DEFAULT && key.toLowerCase() === option.trim().toLowerCase());
}

export function hasTemplateBlanks(text: string): boolean {
  return text.includes(TEMPLATE_BLANK);
}

/** Focus the field and select the first blank so typing replaces it. */
export function focusFirstBlank(el: HTMLInputElement | HTMLTextAreaElement | null) {
  if (!el) return;
  el.focus();
  const at = el.value.indexOf(TEMPLATE_BLANK);
  if (at >= 0) el.setSelectionRange(at, at + TEMPLATE_BLANK.length);
  else el.setSelectionRange(el.value.length, el.value.length);
}

/**
 * Description state that can be filled from a template. A template only replaces the text when it
 * is empty or still exactly the previous auto-filled template, so typed text is never overwritten.
 */
export function useTemplatedText<E extends HTMLInputElement | HTMLTextAreaElement = HTMLTextAreaElement>() {
  const [value, setValue] = useState("");
  const lastAuto = useRef("");
  // Focus-fill happens once per form cycle so a deliberately cleared box stays empty.
  const focusFilled = useRef(false);
  const ref = useRef<E>(null);

  function apply(next: string, focus: boolean) {
    const replaceable = value.trim() === "" || value === lastAuto.current;
    if (!replaceable || next === value) {
      if (next && focus && next === value) requestAnimationFrame(() => focusFirstBlank(ref.current));
      return;
    }
    lastAuto.current = next;
    setValue(next);
    if (next && focus) requestAnimationFrame(() => focusFirstBlank(ref.current));
  }

  return {
    value,
    setValue,
    ref,
    /** Fill from the template for the chosen option and move focus to the first blank. */
    fill(form: TemplateForm, option: string, options: { focus?: boolean } = {}) {
      apply(requestTemplate(form, option), options.focus !== false);
    },
    /** Swap to a new template only when the text is still the previous auto-template. */
    swapIfAuto(form: TemplateForm, option: string) {
      if (lastAuto.current && value === lastAuto.current) apply(requestTemplate(form, option), false);
    },
    /** Fill an empty box when it gets focus (for forms whose option is preselected). */
    fillIfEmpty(form: TemplateForm, option: string) {
      const next = requestTemplate(form, option);
      if (!next || value.trim() !== "" || focusFilled.current) return;
      focusFilled.current = true;
      apply(next, true);
    },
    reset(text = "") {
      lastAuto.current = "";
      focusFilled.current = false;
      setValue(text);
    },
  };
}
