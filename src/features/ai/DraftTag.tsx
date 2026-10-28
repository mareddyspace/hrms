import "./ai.css";

/** Marks generated text as a draft that a person must check. */
export function DraftTag({ text = "Draft — review before sharing" }: { text?: string }) {
  return <span className="ai-draft-tag">{text}</span>;
}
