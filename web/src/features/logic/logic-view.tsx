import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronRight, CornerDownLeft, OctagonAlert, Repeat, ShieldAlert, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { TestMark } from "@/features/journey/step-card";
import { logicQuery, type Cond, type LogicNode } from "@/lib/api";
import { useLang } from "@/lib/lang";
import type { SourceRef } from "@/lib/nav";
import { cn } from "@/lib/utils";

/** Long identifiers break after a dot, never at a random letter. */
const Soft = ({ text }: { text: string }) => <>{text.split(/(?<=[.(,])/).map((part, i) => <span key={i}>{i > 0 && <wbr />}{part}</span>)}</>;

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
const Line = ({ n }: { n: number }) => <span className="ml-auto shrink-0 pl-2 font-mono text-caption leading-5 text-muted-foreground opacity-0 transition-opacity group-hover/line:opacity-100">{n}</span>;
const hitCode = "bg-hit shadow-[inset_2px_0_0_var(--foreground)]";

const OP_STYLE = {
  and: { label: ["同时满足", "All of"], tag: "text-muted-foreground", rail: "border-border" },
  or: { label: ["满足任一", "Any of"], tag: "text-muted-foreground", rail: "border-border" },
} as const;

function CondView({ c, ctx }: { c: Cond; ctx: Ctx }) {
  const { t } = useLang();
  if (c.op === "leaf") {
    return (
      <button title={t(`第 ${c.line} 行`, `Line ${c.line}`)} onClick={() => ctx.open(c.line)} className={cn("block max-w-full min-w-0 rounded-sm px-1 text-left font-mono text-caption leading-[19px] hover:bg-accent", ctx.hits.has(c.line) && hitCode)}>
        <Soft text={c.text} />
      </button>
    );
  }
  const style = c.op === "not" ? null : OP_STYLE[c.op];
  const items = c.op === "not" ? [c.item] : c.items;
  return (
    <div className="flex min-w-0 flex-1 gap-1.5">
      <span className={cn("self-start rounded-[3px] px-1 text-caption leading-4 font-medium", style?.tag ?? "text-muted-foreground")}>{style ? t(style.label[0], style.label[1]) : t("非", "Not")}</span>
      <div className={cn("grid min-w-0 flex-1 gap-px border-l-[1.5px] pl-1.5", style?.rail ?? "border-destructive/40")}>{items.map((x, i) => <CondView key={i} c={x} ctx={ctx} />)}</div>
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
    <Collapsible open={open} onOpenChange={setOpen} className={cn("ml-2.5 min-w-0 border-l-[1.5px] pl-2.5", RAIL[kind])}>
      <CollapsibleTrigger className="group/branch flex min-h-[21px] w-full items-center gap-0.5 text-left text-caption font-medium hover:text-foreground">
        <ChevronRight size={12} className="shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]/branch:rotate-90" aria-hidden />
        <span className={cn(kind === "no" && "text-muted-foreground", kind === "error" && "text-destructive", kind === "case" && "font-mono text-caption font-normal break-words")}>{label}</span>
        {!open && <span className="ml-1.5 font-mono text-caption font-normal text-muted-foreground">{count} {t("个节点", "nodes")}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-px pb-1.5"><Nodes list={body} ctx={ctx} depth={depth + 1} /></CollapsibleContent>
    </Collapsible>
  );
}

const block = "rounded-[4px] py-1 pr-1.5 pl-1.5";
const testRow = cn("group/line flex items-start gap-1.5 bg-test-soft", block);
const loopRow = cn("group/line flex items-start gap-1.5 bg-muted", block);
/** A construct always opens with its mark and word, so an `if` and a `switch` are told apart without reading the code. */
const Kw = ({ mark, test, children }: { mark: ReactNode; test?: boolean; children: string }) => <span className={cn("flex h-[19px] shrink-0 items-center gap-1 text-caption font-medium", test && "text-test")}>{mark}{children}</span>;
const Glyph = ({ icon: Icon }: { icon: LucideIcon }) => <Icon size={13} strokeWidth={1.75} aria-hidden />;

/** `return throwApiError(...)` is a throw in all but name, and a reader looks for failures by what they do. */
const fails = (n: Extract<LogicNode, { t: "return" | "throw" | "call" }>) => n.t === "throw" || (n.t === "return" && /^(throw\w*|createError)\b/.test(n.text ?? ""));

/** `if (bad) throw` is the commonest test in real code. It reads as one gate rather than a branch to open. */
const guardOf = (n: LogicNode) => {
  if (n.t !== "if" || n.else.length || n.then.length !== 1) return null;
  const only = n.then[0]!;
  return only.t === "return" || only.t === "throw" ? only : null;
};

function End({ n, ctx }: { n: Extract<LogicNode, { t: "return" | "throw" | "call" }>; ctx: Ctx }) {
  const failed = fails(n);
  const Icon = failed ? OctagonAlert : n.t === "return" ? CornerDownLeft : ArrowRight;
  const { t } = useLang();
  const tag = failed ? t("抛错", "Throw") : n.t === "return" ? (n.text ? t("返回", "Return") : t("到此结束", "Stop here")) : t("调用", "Call");
  const tone = failed ? "text-destructive" : n.t === "return" ? "text-foreground" : "text-muted-foreground";
  return (
    <button onClick={() => ctx.open(n.line)} className={cn("group/line flex w-full items-baseline gap-1.5 rounded-sm px-1 py-px text-left hover:bg-accent", ctx.hits.has(n.line) && hitCode)}>
      <Icon size={12} aria-hidden className={cn("shrink-0 translate-y-0.5", tone)} />
      <span className={cn("shrink-0 text-caption font-medium", tone)}>{tag}</span>
      {n.text && <code className="min-w-0 font-mono text-caption break-words text-muted-foreground"><Soft text={n.text} /></code>}
      <Line n={n.line} />
    </button>
  );
}

function Nodes({ list, ctx, depth }: { list: LogicNode[]; ctx: Ctx; depth: number }) {
  const { t } = useLang();
  if (!list.length) return <p className="py-0.5 text-caption text-muted-foreground">{t("继续执行下一行", "Goes on to the next line")}</p>;
  return (
    <ol className="grid min-w-0 gap-1">
      {list.map((n, i) => {
        const hit = ctx.hits.has(n.line);
        if (n.t === "return" || n.t === "throw" || n.t === "call") return <li key={i}><End n={n} ctx={ctx} /></li>;
        const guard = guardOf(n);
        if (n.t === "if" && guard) {
          return (
            <li key={i} className={cn("grid min-w-0 gap-px bg-test-soft", block, hit && hitCode)}>
              <div className="group/line flex items-start gap-1.5"><Kw test mark={<Glyph icon={ShieldAlert} />}>{t("拦下，如果", "Stops if")}</Kw><CondView c={n.cond} ctx={ctx} /><Line n={n.line} /></div>
              <End n={guard} ctx={ctx} />
            </li>
          );
        }
        if (n.t === "if") {
          return (
            <li key={i} className="grid min-w-0 gap-0.5">
              <div className={cn(testRow, hit && hitCode)}><Kw test mark={<TestMark size={13} />}>{t("如果", "If")}</Kw><CondView c={n.cond} ctx={ctx} /><Line n={n.line} /></div>
              <Branch label={t("成立", "Then")} kind="yes" body={n.then} ctx={ctx} depth={depth} />
              {n.else.length > 0 && <Branch label={t("否则", "Else")} kind="no" body={n.else} ctx={ctx} depth={depth} />}
            </li>
          );
        }
        if (n.t === "switch") {
          return (
            <li key={i} className="grid min-w-0 gap-0.5">
              <div className={testRow}><Kw test mark={<TestMark size={13} />}>{t("分支", "Switch")}</Kw><button className="min-w-0 px-1 text-left font-mono text-caption leading-[19px]" onClick={() => ctx.open(n.line)}><Soft text={n.text} /></button><Line n={n.line} /></div>
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
              <div className={loopRow}><Kw mark={<Glyph icon={Repeat} />}>{t("遍历", "For each")}</Kw><button className="min-w-0 px-1 text-left font-mono text-caption leading-[19px]" onClick={() => ctx.open(n.line)}><Soft text={n.text} /></button><Line n={n.line} /></div>
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
      <CollapsibleTrigger className="group/logic mb-2 flex w-full items-center gap-1 text-left">
        <ChevronRight size={13} className="text-muted-foreground transition-transform duration-150 group-data-[state=open]/logic:rotate-90" aria-hidden />
        <h3 className="text-ui font-semibold">{t("判断逻辑", "Decision logic")}</h3>
        <span className="ml-auto text-caption text-muted-foreground">{t("来自代码", "from the code")}</span>
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

