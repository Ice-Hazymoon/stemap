import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Atlas } from "@/lib/api";

export const TermContext = createContext<Atlas["glossary"]>([]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const inlineCode = "rounded-sm bg-muted px-1 py-px font-mono text-[.86em] ring-1 ring-inset ring-border break-words";

/** Backticks become code; glossary words carry their definition. The text itself is never rewritten. */
export function Prose({ text, plain }: { text: string; plain?: boolean }) {
  const glossary = useContext(TermContext);
  const re = useMemo(() => {
    if (plain || !glossary.length) return null;
    const words = glossary.map((t) => escapeRe(t.term)).sort((a, b) => b.length - a.length);
    return new RegExp(`\\b(${words.join("|")})(s|es)?\\b`, "gi");
  }, [glossary, plain]);
  const parts: ReactNode[] = [];
  text.split(/(`[^`]+`)/).forEach((seg, i) => {
    if (seg.startsWith("`") && seg.endsWith("`") && seg.length > 1) { parts.push(<code key={i} className={inlineCode}>{seg.slice(1, -1)}</code>); return; }
    if (!re) { parts.push(seg); return; }
    let last = 0;
    for (const m of seg.matchAll(re)) {
      const def = glossary.find((t) => t.term.toLowerCase() === m[1]!.toLowerCase());
      parts.push(seg.slice(last, m.index));
      parts.push(<span key={`${i}-${m.index}`} className="cursor-help hover:shadow-[inset_0_-1px_0_currentColor]" title={def?.definition}>{m[0]}</span>);
      last = m.index + m[0].length;
    }
    parts.push(seg.slice(last));
  });
  return <>{parts}</>;
}
