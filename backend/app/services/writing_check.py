"""Grammar and spelling suggestions for mail (POST /mail/check).

Uses the HR Copilot model (OpenRouter, app/services/ai_copilot.py) when a key is set; otherwise, or when the model
fails, a rule-based check of common mistakes. The same rules run in the browser in local mode
(src/data/writingCheck.ts). Suggestions carry character offsets so the page can apply one with a click.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

from app.services import ai_copilot

log = logging.getLogger(__name__)

MAX_TEXT = 6000


@dataclass
class Suggestion:
    start: int
    end: int
    original: str
    replacement: str
    message: str


# Common misspellings -> correct word (lower case).
MISSPELLINGS: dict[str, str] = {
    "teh": "the", "recieve": "receive", "recieved": "received", "seperate": "separate", "definately": "definitely",
    "untill": "until", "occured": "occurred", "occurence": "occurrence", "wich": "which", "thier": "their",
    "alot": "a lot", "accomodate": "accommodate", "acheive": "achieve", "adress": "address", "begining": "beginning",
    "beleive": "believe", "calender": "calendar", "collegue": "colleague", "comming": "coming", "commited": "committed",
    "concious": "conscious", "embarass": "embarrass", "enviroment": "environment", "existance": "existence",
    "goverment": "government", "grammer": "grammar", "harrass": "harass", "immediatly": "immediately",
    "independant": "independent", "knowlege": "knowledge", "liason": "liaison", "maintainance": "maintenance",
    "managment": "management", "neccessary": "necessary", "necesary": "necessary", "noticable": "noticeable",
    "occassion": "occasion", "persue": "pursue", "posession": "possession", "prefered": "preferred",
    "priviledge": "privilege", "publically": "publicly", "reccomend": "recommend", "recomend": "recommend",
    "refered": "referred", "relevent": "relevant", "remeber": "remember", "responsability": "responsibility",
    "schedual": "schedule", "sucess": "success", "succesful": "successful", "successfull": "successful",
    "tommorow": "tomorrow", "tomorow": "tomorrow", "truely": "truly", "wierd": "weird", "writting": "writing",
    "attendence": "attendance", "payslipp": "payslip", "regularisaton": "regularisation", "approvel": "approval",
    "absense": "absence", "buisness": "business", "carefull": "careful", "completly": "completely",
    "excercise": "exercise", "familar": "familiar", "finaly": "finally", "foward": "forward", "freind": "friend",
    "gaurd": "guard", "happend": "happened", "informations": "information", "occuring": "occurring",
    "recieving": "receiving", "reciept": "receipt", "sincerly": "sincerely", "thru": "through", "wheather": "whether",
    "dont": "don't", "doesnt": "doesn't", "didnt": "didn't", "cant": "can't", "wont": "won't", "isnt": "isn't",
    "im": "I'm", "ive": "I've", "id": None,  # type: ignore[dict-item]  # "id" is a real word; skipped below
}
MISSPELLINGS = {k: v for k, v in MISSPELLINGS.items() if v}

_PHRASES: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"\b(could|would|should|must) of\b", re.I), r"\1 have", "Use “have” after could/would/should."),
    (re.compile(r"\bthe the\b", re.I), "the", "Repeated word."),
    (re.compile(r"\bi\b(?!\.\w)"), "I", "Capitalise “I”."),
    (re.compile(r"\ba (?=[aeiou]\w)", re.I), "an ", "Use “an” before a vowel sound."),
    (re.compile(r"\bplease (?:kindly|do kindly)\b", re.I), "please", "“Please kindly” is redundant."),
    (re.compile(r"\bdo the needful\b", re.I), "take care of this", "Clearer: say what needs doing."),
    (re.compile(r"\brevert back\b", re.I), "reply", "“Revert back” means reply."),
    (re.compile(r"\bprepone\b", re.I), "bring forward", "Clearer in international English."),
    (re.compile(r"\b(\w+) \1\b", re.I), r"\1", "Repeated word."),
    (re.compile(r" {2,}"), " ", "Extra spaces."),
    (re.compile(r" +([,.;:!?])"), r"\1", "No space before punctuation."),
    (re.compile(r"([,;:])(?=[A-Za-z])"), r"\1 ", "Add a space after punctuation."),
]
# "a" before these is right even though they start with a vowel letter.
_A_EXCEPTIONS = re.compile(r"^a (?:uni|use|usu|eu|one|once|ur)", re.I)


def rule_suggestions(text: str) -> list[Suggestion]:
    out: list[Suggestion] = []
    taken: list[tuple[int, int]] = []

    def add(start: int, end: int, replacement: str, message: str) -> None:
        if any(start < e and end > s for s, e in taken):
            return
        original = text[start:end]
        if original == replacement:
            return
        taken.append((start, end))
        out.append(Suggestion(start, end, original, replacement, message))

    for m in re.finditer(r"[A-Za-z']+", text):
        word = m.group(0)
        fix = MISSPELLINGS.get(word.lower())
        if not fix:
            continue
        if word[0].isupper() and fix[0].islower():
            fix = fix[0].upper() + fix[1:]
        add(m.start(), m.end(), fix, f"Spelling: “{fix}”.")
    for pattern, repl, message in _PHRASES:
        for m in pattern.finditer(text):
            if pattern.pattern.startswith(r"\ba (?=") and _A_EXCEPTIONS.match(text[m.start():m.start() + 6]):
                continue
            add(m.start(), m.end(), m.expand(repl), message)
    # Sentence starts with a lower-case letter.
    for m in re.finditer(r"(?:^|[.!?]\s+)([a-z])", text):
        start = m.start(1)
        if re.search(r"\b(?:e\.g|i\.e|etc|vs)\.\s+$", text[max(0, start - 8):start], re.I):
            continue
        add(start, start + 1, m.group(1).upper(), "Start the sentence with a capital letter.")
    return sorted(out, key=lambda s: s.start)


_PROMPT = (
    "You are a careful proofreader for workplace email. Find spelling, grammar and punctuation mistakes in the "
    "user's text. Reply with JSON only: a list of objects with keys original (exact text copied from the input, "
    "as short as possible), replacement, and message (a few words). Do not rewrite style or tone. If there are no "
    "mistakes reply []."
)


def _ai_suggestions(text: str) -> list[Suggestion] | None:
    messages = [{"role": "system", "content": _PROMPT}, {"role": "user", "content": text}]
    try:
        answer, _model = ai_copilot._ask_models(messages)  # noqa: SLF001 - shared OpenRouter helper
    except Exception:  # noqa: BLE001 - never fail the check because of the model
        log.warning("Writing check model call failed; using rules")
        return None
    if not answer:
        return None
    match = re.search(r"\[.*\]", answer, re.S)
    if not match:
        return None
    try:
        items = json.loads(match.group(0))
    except ValueError:
        return None
    out: list[Suggestion] = []
    used: list[tuple[int, int]] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        original, replacement = str(item.get("original") or ""), str(item.get("replacement") or "")
        if not original or original == replacement:
            continue
        pos = text.find(original)
        while pos >= 0 and any(pos < e and pos + len(original) > s for s, e in used):
            pos = text.find(original, pos + 1)
        if pos < 0:
            continue
        used.append((pos, pos + len(original)))
        out.append(Suggestion(pos, pos + len(original), original, replacement, str(item.get("message") or "Suggestion")[:120]))
    return sorted(out, key=lambda s: s.start)


def check(text: str, user_id: str) -> tuple[str, list[Suggestion]]:
    """("ai" | "rules", suggestions)."""
    text = text[:MAX_TEXT]
    if ai_copilot.get_settings().ai_enabled and ai_copilot.allow_question(f"write:{user_id}"):
        found = _ai_suggestions(text)
        if found is not None:
            return "ai", found
    return "rules", rule_suggestions(text)
