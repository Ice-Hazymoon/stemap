import type { Atlas } from "@/lib/api";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Lang = "zh" | "en";
const KEY = "stemap.lang";

function saved(): Lang {
  // Storage can throw in private windows; the language is only a convenience.
  try { return localStorage.getItem(KEY) === "zh" ? "zh" : "en"; } catch { return "en"; }
}

/** English always exists; Chinese is offered only when the atlas carries some. */
export const atlasHasZh = (a: Atlas) =>
  a.journeys.some((j) => j.titleZh || j.steps.some((s) => s.zh)) || Object.values(a.nodes).some((n) => n.zh);

const Ctx = createContext<{ lang: Lang; hasZh: boolean; setLang: (l: Lang) => void; t: (zh: string | undefined, en: string) => string }>({ lang: "en", hasZh: false, setLang: () => undefined, t: (_, en) => en });

/** Content and interface share the switch: a Chinese reader should not read English around Chinese sentences. */
export function LangProvider({ hasZh, children }: { hasZh: boolean; children: ReactNode }) {
  const [choice, set] = useState<Lang>(saved);
  const lang: Lang = hasZh ? choice : "en";
  // Screen readers and the browser's own line breaking read this, not the words on the page.
  useEffect(() => { document.documentElement.lang = lang === "zh" ? "zh-CN" : "en"; }, [lang]);
  const value = useMemo(() => ({
    lang, hasZh,
    setLang: (l: Lang) => { set(l); try { localStorage.setItem(KEY, l); } catch { /* the choice lasts for this page */ } },
    t: (zh: string | undefined, en: string) => (lang === "zh" ? zh ?? en : en),
  }), [lang, hasZh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useLang = () => useContext(Ctx);
