/**
 * Grammar and spelling suggestions for the mail compose box.
 * Backend mode asks POST /mail/check (the HR Copilot model when a key is set, else the server's rules);
 * local mode, or when the server can't be reached, uses the same rules here
 * (backend/app/services/writing_check.py).
 */
import { API_ENABLED, api } from "../api/client.ts";

export interface WritingSuggestion {
  start: number;
  end: number;
  original: string;
  replacement: string;
  message: string;
}

const MISSPELLINGS: Record<string, string> = {
  teh: "the", recieve: "receive", recieved: "received", seperate: "separate", definately: "definitely", untill: "until",
  occured: "occurred", occurence: "occurrence", wich: "which", thier: "their", alot: "a lot", accomodate: "accommodate",
  acheive: "achieve", adress: "address", begining: "beginning", beleive: "believe", calender: "calendar",
  collegue: "colleague", comming: "coming", commited: "committed", concious: "conscious", embarass: "embarrass",
  enviroment: "environment", existance: "existence", goverment: "government", grammer: "grammar", harrass: "harass",
  immediatly: "immediately", independant: "independent", knowlege: "knowledge", liason: "liaison",
  maintainance: "maintenance", managment: "management", neccessary: "necessary", necesary: "necessary",
  noticable: "noticeable", occassion: "occasion", persue: "pursue", posession: "possession", prefered: "preferred",
  priviledge: "privilege", publically: "publicly", reccomend: "recommend", recomend: "recommend", refered: "referred",
  relevent: "relevant", remeber: "remember", responsability: "responsibility", schedual: "schedule", sucess: "success",
  succesful: "successful", successfull: "successful", tommorow: "tomorrow", tomorow: "tomorrow", truely: "truly",
  wierd: "weird", writting: "writing", attendence: "attendance", payslipp: "payslip", approvel: "approval",
  absense: "absence", buisness: "business", carefull: "careful", completly: "completely", excercise: "exercise",
  familar: "familiar", finaly: "finally", foward: "forward", freind: "friend", gaurd: "guard", happend: "happened",
  informations: "information", occuring: "occurring", recieving: "receiving", reciept: "receipt", sincerly: "sincerely",
  thru: "through", wheather: "whether", dont: "don't", doesnt: "doesn't", didnt: "didn't", cant: "can't", wont: "won't",
  isnt: "isn't", im: "I'm", ive: "I've",
};

const PHRASES: [RegExp, string, string][] = [
  [/\b(could|would|should|must) of\b/gi, "$1 have", "Use “have” after could/would/should."],
  [/\bthe the\b/gi, "the", "Repeated word."],
  [/\bi\b(?!\.\w)/g, "I", "Capitalise “I”."],
  [/\ba (?=[aeiou]\w)/gi, "an ", "Use “an” before a vowel sound."],
  [/\bplease (?:kindly|do kindly)\b/gi, "please", "“Please kindly” is redundant."],
  [/\bdo the needful\b/gi, "take care of this", "Clearer: say what needs doing."],
  [/\brevert back\b/gi, "reply", "“Revert back” means reply."],
  [/\bprepone\b/gi, "bring forward", "Clearer in international English."],
  [/\b(\w+) \1\b/gi, "$1", "Repeated word."],
  [/ {2,}/g, " ", "Extra spaces."],
  [/ +([,.;:!?])/g, "$1", "No space before punctuation."],
  [/([,;:])(?=[A-Za-z])/g, "$1 ", "Add a space after punctuation."],
];
const A_EXCEPTIONS = /^a (?:uni|use|usu|eu|one|once|ur)/i;

/** Rule-based suggestions (offsets into `text`), sorted by position. */
export function ruleSuggestions(text: string): WritingSuggestion[] {
  const out: WritingSuggestion[] = [];
  const taken: [number, number][] = [];
  const add = (start: number, end: number, replacement: string, message: string) => {
    if (taken.some(([s, e]) => start < e && end > s)) return;
    const original = text.slice(start, end);
    if (original === replacement) return;
    taken.push([start, end]);
    out.push({ start, end, original, replacement, message });
  };
  for (const m of text.matchAll(/[A-Za-z']+/g)) {
    let fix = MISSPELLINGS[m[0].toLowerCase()];
    if (!fix) continue;
    if (/^[A-Z]/.test(m[0]) && /^[a-z]/.test(fix)) fix = fix[0].toUpperCase() + fix.slice(1);
    add(m.index!, m.index! + m[0].length, fix, `Spelling: “${fix}”.`);
  }
  for (const [pattern, repl, message] of PHRASES) {
    for (const m of text.matchAll(pattern)) {
      if (pattern.source.startsWith("\\ba (?=") && A_EXCEPTIONS.test(text.slice(m.index!, m.index! + 6))) continue;
      add(m.index!, m.index! + m[0].length, m[0].replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), repl), message);
    }
  }
  for (const m of text.matchAll(/(?:^|[.!?]\s+)([a-z])/g)) {
    const start = m.index! + m[0].length - 1;
    if (/\b(?:e\.g|i\.e|etc|vs)\.\s+$/i.test(text.slice(Math.max(0, start - 8), start))) continue;
    add(start, start + 1, m[1].toUpperCase(), "Start the sentence with a capital letter.");
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Suggestions for the text, and where they came from ("ai" = HR Copilot model, "rules" = built-in checks). */
export async function checkWriting(text: string): Promise<{ source: "ai" | "rules"; suggestions: WritingSuggestion[] }> {
  if (API_ENABLED) {
    try {
      const out = await api.post<{ source: "ai" | "rules"; suggestions: WritingSuggestion[] }>("/mail/check", { text });
      // The server may have read a different version if the text changed meanwhile; keep only matching ones.
      return { source: out.source, suggestions: out.suggestions.filter((s) => text.slice(s.start, s.end) === s.original) };
    } catch {
      /* fall back to the rules below */
    }
  }
  return { source: "rules", suggestions: ruleSuggestions(text) };
}

/** Applies one suggestion; later suggestions' offsets shift by the length change. */
export function applySuggestion(text: string, s: WritingSuggestion): string {
  return text.slice(0, s.start) + s.replacement + text.slice(s.end);
}

/** Applies several (non-overlapping) suggestions at once. */
export function applyAll(text: string, list: WritingSuggestion[]): string {
  return [...list].sort((a, b) => b.start - a.start).reduce(applySuggestion, text);
}
