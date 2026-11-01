import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { entityQuery, sourceQuery } from "@/lib/api";
import { useLang } from "@/lib/lang";
import { useCloseSource, useOpenItem, type SourceRef } from "@/lib/nav";

const LANGS: Record<string, string> = { ts: "ts", tsx: "tsx", vue: "vue", js: "js", mjs: "js", json: "json", md: "md", css: "css", html: "html", yml: "yaml", yaml: "yaml", sql: "sql" };
const MAX = 240_000;

/** A file on screen answers "who depends on this" without leaving the code. */
function Used({ path }: { path: string }) {
  const { t } = useLang();
  const onItem = useOpenItem();
  const { data: view } = useQuery(entityQuery(`file:${path}`));
  const hits = view?.groups.find((g) => g.key === "impact");
  return (
    <div className="ml-auto flex min-w-0 items-center justify-end gap-1.5 overflow-hidden">
      {hits?.items.slice(0, 2).map((x) => (
        <button key={x.id} onClick={() => onItem(x)} title={x.hint ? t(x.hintZh, x.hint) : undefined} className="min-w-0">
          <span className="block max-w-40 truncate rounded-[3px] bg-muted px-2 text-caption leading-[22px] text-foreground hover:bg-accent">{t(x.labelZh, x.label)}</span>
        </button>
      ))}
      <Button variant="link" size="sm" className="h-auto shrink-0 p-0 text-caption" onClick={() => onItem({ id: `file:${path}`, kind: "file" })}>{hits ? t(`全部 ${hits.total} 项关联`, `All ${hits.total} links`) : t("关联", "Links")}</Button>
    </div>
  );
}

/** Grammars and themes bundle into the page, and the JavaScript regex engine needs no wasm fetch on file://. */
let shiki: Promise<HighlighterCore> | null = null;
const highlighter = () => (shiki ??= createHighlighterCore({
  themes: [import("@shikijs/themes/github-light-default"), import("@shikijs/themes/github-dark-default")],
  langs: [
    import("@shikijs/langs/typescript"), import("@shikijs/langs/tsx"), import("@shikijs/langs/javascript"), import("@shikijs/langs/jsx"), import("@shikijs/langs/vue"),
    import("@shikijs/langs/json"), import("@shikijs/langs/yaml"), import("@shikijs/langs/css"), import("@shikijs/langs/html"), import("@shikijs/langs/markdown"), import("@shikijs/langs/sql"), import("@shikijs/langs/shellscript"),
  ],
  engine: createJavaScriptRegexEngine(),
}));

async function highlight(code: string, target: SourceRef) {
  if (code.length > MAX) return `<pre>${code.replace(/[&<]/g, (c) => (c === "&" ? "&amp;" : "&lt;"))}</pre>`;
  const lang = LANGS[target.path.split(".").pop() ?? ""] ?? "text";
  const shiki = await highlighter();
  const known = shiki.getLoadedLanguages().includes(lang);
  // A whole-file open has no cited line to mark.
  const mark = (line: number) => line >= target.startLine && line <= target.endLine && target.startLine + target.endLine > 2;
  return shiki.codeToHtml(code, {
    lang: known ? lang : "text", themes: { light: "github-light-default", dark: "github-dark-default" }, defaultColor: false,
    transformers: [{ line(node, line) { node.properties["data-line"] = line; if (mark(line)) this.addClassToHast(node, "hit"); } }],
  });
}

export function SourcePanel({ target }: { target: SourceRef }) {
  const { t } = useLang();
  const close = useCloseSource();
  const code = useQuery(sourceQuery(target.path));
  const html = useQuery({ queryKey: ["highlight", target], enabled: code.data !== undefined, queryFn: () => highlight(code.data!, target) });
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (html.data) box.current?.querySelector(`[data-line="${Math.max(1, target.startLine - 4)}"]`)?.scrollIntoView({ block: "start" });
  }, [html.data, target]);
  const parts = target.path.split("/");
  const name = parts.pop();
  const copy = () => { void navigator.clipboard?.writeText(target.path).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }); };
  return (
    <section aria-label={t("源代码", "Source file")} className="flex h-full min-w-0 flex-col bg-card">
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b pr-1.5 pl-3.5 text-muted-foreground">
        <span title={target.path} className="flex min-w-[60px] font-mono text-caption whitespace-nowrap">
          <span className="min-w-0 truncate">{parts.join("/")}/</span>
          <strong className="shrink-0 font-medium text-foreground">{name}</strong>
          {target.startLine > 1 && <span className="shrink-0">:{target.startLine}</span>}
        </span>
        <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={copied ? t("路径已复制", "Path copied") : t("复制路径", "Copy path")} onClick={copy}>{copied ? <Check /> : <Copy />}</Button>
        <Used path={target.path} />
        <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t("关闭源码", "Close source")} onClick={close}><X /></Button>
      </header>
      {code.isError ? <p className="p-4 text-ui text-muted-foreground">{t("这个文件不在快照里。", "This file is not in the snapshot.")}</p>
        : !html.data ? <div className="grid gap-2.5 p-4"><Skeleton className="h-3.5" /><Skeleton className="h-3.5 w-4/5" /><Skeleton className="h-3.5 w-3/5" /><Skeleton className="h-3.5 w-2/3" /></div>
        : <div ref={box} className="code-view min-h-0 flex-1 overflow-auto" dangerouslySetInnerHTML={{ __html: html.data }} />}
    </section>
  );
}
