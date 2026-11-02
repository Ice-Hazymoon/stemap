import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { logicQuery, type Cond, type LogicNode } from "@/lib/api";
import { useLang } from "@/lib/lang";
import type { SourceRef } from "@/lib/nav";
import { cn } from "@/lib/utils";

/** Cuts code wherever `starts` says a new piece begins, but never inside a bracket. */
function outside(code: string, starts: (i: number) => boolean) {
  const out: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < code.length; i++) {
    if ("([{".includes(code[i]!)) depth++;
    else if (")]}".includes(code[i]!)) depth = Math.max(depth - 1, 0);
    else if (!depth && i > from && starts(i)) { out.push(code.slice(from, i)); from = i; }
  }
  return [...out, code.slice(from)];
}

const Whole = ({ children }: { children: ReactNode }) => <span className="inline-block max-w-full [overflow-wrap:anywhere]">{children}</span>;

/**
 * Wraps the way a person would: between words first, then before a chain dot, and inside a bracket only as a last resort.
 * Each level stays whole while it fits, which is what ranks the three: `.where(eq(a, b))` moves down as one piece.
 */
const Soft = ({ text }: { text: string }) => <>{outside(text, (i) => text[i - 1] === " ").map((word, i) => {
  const code = word.trimEnd();
  const chain = outside(code, (k) => code[k] === "." && /[\w)\]]/.test(code[k - 1]!) && /[A-Za-z_$#]/.test(code[k + 1] ?? ""));
  return <Fragment key={i}><Whole>{chain.map((p, k) => <Whole key={k}>{p.split(/(?<=[(,.])/).map((part, n) => <Fragment key={n}>{n > 0 && <wbr />}{part}</Fragment>)}</Whole>)}</Whole>{word !== code && " "}</Fragment>;
})}</>;

/** Lines inside a node, so a branch that holds a cited line opens by itself. */
function lines(n: LogicNode): number[] {
  const list = (x: LogicNode[]) => x.flatMap(lines);
  switch (n.t) {
    case "if": return [n.line, ...list(n.then), ...list(n.else)];
    case "switch": return [n.line, ...n.cases.flatMap((c) => [c.line, ...list(c.body)])];
    case "try": return [n.line, ...list(n.body), ...list(n.handler)];
    case "loop": case "scope": return [n.line, ...list(n.body)];
    default: return [n.line];
  }
}

interface Ctx { hits: Set<number>; open: (line: number) => void }
/**
 * Verb, then code. The code starts on one edge, so the verbs read as an outline of the function.
 * Top-aligned on one line height: a baseline would drop the verb to the last line of wrapped code.
 */
const row = "grid grid-cols-[4rem_minmax(0,1fr)] items-start gap-x-2";
/** The rail is the same rail as the fork above it: a test. The fill says this step cites these lines. Each appears once, on the outermost box. */
const box = (hit: boolean, test: boolean, depth: number) => cn("rounded-r-[4px] border-l-2 py-0.5 pr-1.5", depth > 0 ? "pl-2" : "pl-3.5", test ? "border-test" : "border-transparent", hit && "bg-hit");
const codeLink = "-mx-1 min-w-0 justify-self-start rounded-sm px-1 text-left font-mono text-caption leading-5 text-balance hover:bg-accent";
const Verb = ({ tone = "quiet", children }: { tone?: "quiet" | "plain" | "test" | "fail"; children: string }) => (
  <span className={cn("text-caption leading-5", { quiet: "text-muted-foreground", plain: "font-medium", test: "font-medium text-test", fail: "font-medium text-destructive" }[tone])}>{children}</span>
);
const Code = ({ muted, children }: { muted?: boolean; children: string }) => <code className={cn("min-w-0 font-mono text-caption leading-5 text-balance", muted && "text-muted-foreground")}><Soft text={children} /></code>;

function CondView({ c, ctx }: { c: Cond; ctx: Ctx }) {
  const { t } = useLang();
  if (c.op === "leaf") {
    return (
      <button title={t(`第 ${c.line} 行`, `Line ${c.line}`)} onClick={() => ctx.open(c.line)} className={codeLink}>
        <Soft text={c.text} />
      </button>
    );
  }
  const items = c.op === "not" ? [c.item] : c.items;
  return (
    <div className="grid min-w-0 gap-0.5">
      <span className="text-caption leading-5 text-muted-foreground">{c.op === "not" ? t("非", "Not") : c.op === "and" ? t("同时满足", "All of") : t("满足任一", "Any of")}</span>
      <div className="grid min-w-0 gap-px border-l-[1.5px] border-border pl-2">{items.map((x, i) => <CondView key={i} c={x} ctx={ctx} />)}</div>
    </div>
  );
}

/** The rail tells the arms apart before the label does: ink for the test passing, rose for the error path. */
const RAIL = { yes: "border-foreground/35", no: "border-border", case: "border-border", error: "border-destructive/45" };

function Branch({ label, kind, body, ctx, depth }: { label: string; kind: keyof typeof RAIL; body: LogicNode[]; ctx: Ctx; depth: number }) {
  const { t } = useLang();
  const has = body.some((n) => lines(n).some((l) => ctx.hits.has(l)));
  const [open, setOpen] = useState(has || depth < 2);
  useEffect(() => { if (has) setOpen(true); }, [has]);
  const count = lines({ t: "scope", text: "", body, line: 0 }).length - 1;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("ml-3 min-w-0 border-l-[1.5px] pl-2", RAIL[kind])}>
      <CollapsibleTrigger className="group/branch flex min-h-[21px] w-full items-center gap-0.5 text-left text-caption font-medium hover:text-foreground">
        <ChevronRight size={12} className="shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]/branch:rotate-90" aria-hidden />
        <span className={cn(kind === "no" && "text-muted-foreground", kind === "error" && "text-destructive", kind === "case" && "font-mono text-caption font-normal break-words")}>{label}</span>
        {!open && <span className="ml-1.5 font-mono text-caption font-normal text-muted-foreground">{count} {t("个节点", "nodes")}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-px pb-1.5"><Nodes list={body} ctx={ctx} depth={depth + 1} /></CollapsibleContent>
    </Collapsible>
  );
}

/** `return throwApiError(...)` is a throw in all but name, and a reader looks for failures by what they do. */
const fails = (n: Extract<LogicNode, { t: "return" | "throw" | "call" }>) => n.t === "throw" || (n.t === "return" && /^(throw\w*|createError)\b/.test(n.text ?? ""));

/** `if (bad) throw` is the commonest test in real code. It reads as one gate rather than a branch to open. */
const guardOf = (n: LogicNode) => {
  if (n.t !== "if" || n.else.length || n.then.length !== 1) return null;
  const only = n.then[0]!;
  return only.t === "return" || only.t === "throw" ? only : null;
};

/** With `box` the row stands alone; without it, it sits inside a guard that already drew the rail and the fill. */
function End({ n, ctx, box: own }: { n: Extract<LogicNode, { t: "return" | "throw" | "call" }>; ctx: Ctx; box?: string }) {
  const failed = fails(n);
  const { t } = useLang();
  const tag = failed ? t("抛错", "Throw") : n.t === "return" ? (n.text ? t("返回", "Return") : t("到此结束", "Stop here")) : t("调用", "Call");
  return (
    <button title={t(`第 ${n.line} 行`, `Line ${n.line}`)} onClick={() => ctx.open(n.line)} className={cn(row, "text-left hover:bg-accent", own ? `w-full ${own}` : "-mx-1 rounded-sm px-1")}>
      <Verb tone={failed ? "fail" : "quiet"}>{tag}</Verb>
      {n.text && <Code muted>{n.text}</Code>}
    </button>
  );
}

function Nodes({ list, ctx, depth }: { list: LogicNode[]; ctx: Ctx; depth: number }) {
  const { t } = useLang();
  if (!list.length) return <p className="py-0.5 text-caption text-muted-foreground">{t("继续执行下一行", "Goes on to the next line")}</p>;
  return (
    <ol className="grid min-w-0 gap-1.5">
      {list.map((n, i) => {
        const hit = ctx.hits.has(n.line);
        if (n.t === "return" || n.t === "throw" || n.t === "call") return <li key={i}><End n={n} ctx={ctx} box={box(hit, false, depth)} /></li>;
        const guard = guardOf(n);
        if (n.t === "if" && guard) {
          return (
            <li key={i} className={cn("grid min-w-0 gap-px", box(lines(n).some((l) => ctx.hits.has(l)), true, depth))}>
              <div className={row}><Verb tone="test">{t("拦下，如果", "Stops if")}</Verb><CondView c={n.cond} ctx={ctx} /></div>
              <End n={guard} ctx={ctx} />
            </li>
          );
        }
        if (n.t === "if") {
          return (
            <li key={i} className="grid min-w-0 gap-0.5">
              <div className={cn(row, box(hit, true, depth))}><Verb tone="test">{t("如果", "If")}</Verb><CondView c={n.cond} ctx={ctx} /></div>
              <Branch label={t("成立", "Then")} kind="yes" body={n.then} ctx={ctx} depth={depth} />
              {n.else.length > 0 && <Branch label={t("否则", "Else")} kind="no" body={n.else} ctx={ctx} depth={depth} />}
            </li>
          );
        }
        if (n.t === "switch") {
          return (
            <li key={i} className="grid min-w-0 gap-0.5">
              <div className={cn(row, box(hit, true, depth))}><Verb tone="test">{t("分支", "Switch")}</Verb><button title={t(`第 ${n.line} 行`, `Line ${n.line}`)} className={codeLink} onClick={() => ctx.open(n.line)}><Soft text={n.text} /></button></div>
              {n.cases.map((c, k) => <Branch key={k} label={c.label === "default" ? t("其他", "Otherwise") : c.label} kind="case" body={c.body} ctx={ctx} depth={depth} />)}
            </li>
          );
        }
        if (n.t === "try") {
          return (
            <li key={i} className="grid min-w-0 gap-0.5">
              <Branch label={t("尝试", "Try")} kind="yes" body={n.body} ctx={ctx} depth={depth} />
              <Branch label={t("出错时", "On error")} kind="error" body={n.handler} ctx={ctx} depth={depth} />
            </li>
          );
        }
        if (n.t === "loop") {
          return (
            <li key={i} className="grid min-w-0 gap-0.5">
              <div className={cn(row, box(hit, false, depth))}><Verb tone="plain">{t("遍历", "For each")}</Verb><button title={t(`第 ${n.line} 行`, `Line ${n.line}`)} className={codeLink} onClick={() => ctx.open(n.line)}><Soft text={n.text} /></button></div>
              <Branch label={t("每一项", "Each item")} kind="no" body={n.body} ctx={ctx} depth={depth} />
            </li>
          );
        }
        if (n.t === "scope") return <li key={i}><Branch label={n.text} kind="case" body={n.body} ctx={ctx} depth={depth - 1} /></li>;
        return null;
      })}
    </ol>
  );
}

export function LogicView({ id, cited, onOpen }: { id: string; cited?: number[]; onOpen: (r: SourceRef) => void }) {
  const { t } = useLang();
  const { data: tree, isPending } = useQuery(logicQuery(id));
  const hits = useMemo(() => new Set(cited), [cited]);
  if (isPending) return <div className="grid gap-2"><Skeleton className="h-4" /><Skeleton className="h-4 w-2/3" /></div>;
  if (!tree || !tree.branches) return <p className="text-caption text-muted-foreground">{t("这个函数没有分支，一路执行到底。", "This function runs straight through, with no branch.")}</p>;
  const ctx: Ctx = { hits, open: (line) => onOpen({ path: tree.file, startLine: line, endLine: line }) };
  return (
    <div className="min-w-0">
      <Nodes list={tree.nodes} ctx={ctx} depth={0} />
      {tree.truncated && <p className="mt-2 text-caption text-muted-foreground">{t("函数太长，只显示前面一部分，其余请看源码。", "This function is long, so only its first part shows. Open the code for the rest.")}</p>}
    </div>
  );
}

/** Decisions open by default; once the reader toggles it, that choice holds for the whole walk. */
export function StepLogic({ fns, open, onToggle, cited, onOpen }: { fns: { id: string; label: string }[]; open: boolean; onToggle: (open: boolean) => void; cited: number[]; onOpen: (r: SourceRef) => void }) {
  const { t } = useLang();
  const [at, setAt] = useState(0);
  const fn = fns[Math.min(at, fns.length - 1)];
  if (!fn) return null;
  return (
    <Collapsible open={open} onOpenChange={onToggle}>
      <CollapsibleTrigger className="group/logic mb-2 flex w-full items-center gap-1.5 text-left">
        <ChevronRight size={14} className="shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]/logic:rotate-90" aria-hidden />
        <h3 className="shrink-0 text-ui font-semibold">{t("判断逻辑", "Decision logic")}</h3>
        {fns.length === 1 ? <code className="ml-auto min-w-0 truncate pl-3 font-mono text-caption text-muted-foreground">{fn.label}</code> : <span className="ml-auto pl-3 text-caption text-muted-foreground">{t("来自代码", "from the code")}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {fns.length > 1 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {fns.map((f, i) => (
              <Button key={f.id} size="sm" variant={i === at ? "secondary" : "outline"} aria-pressed={i === at} onClick={() => setAt(i)}
                className={cn("h-7 max-w-full px-2 font-mono text-caption", i === at && "bg-primary text-primary-foreground hover:bg-primary")}><span className="truncate">{f.label}</span></Button>
            ))}
          </div>
        )}
        <LogicView key={fn.id} id={fn.id} cited={cited} onOpen={onOpen} />
      </CollapsibleContent>
    </Collapsible>
  );
}

