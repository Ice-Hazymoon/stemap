import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ArrowRight, ChevronLeft, ChevronRight, ChevronUp, CornerUpLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LANE_NAME, LANE_ZH } from "@/components/shell/icons";
import { Empty, Section } from "@/components/shell/section";
import { inlineCode, Prose } from "@/components/shell/prose";
import { Groups } from "@/features/inspector/link-groups";
import { StepLogic } from "@/features/logic/logic-view";
import { WIRE } from "@/features/journey/diagram";
import { tableOf } from "@/features/journey/layout";
import { TestMark } from "@/features/journey/step-card";
import { entityQuery, sourceQuery, type Atlas, type EntityView, type ViewJourney, type ViewStep } from "@/lib/api";
import { driftCopy, type DriftItem } from "@/lib/drift";
import { useLang } from "@/lib/lang";
import { useOpenItem, useOpenSource } from "@/lib/nav";
import { cn } from "@/lib/utils";

const Jump = ({ small, title, meta, back, onClick }: { small: string; title: string; meta?: string; back?: boolean; onClick: () => void }) => (
  <button onClick={onClick} className="group/jump flex w-full items-center gap-3 rounded-[4px] py-2.5 pr-3 pl-3.5 text-left shadow-raised transition-shadow duration-150 ease-out hover:shadow-raised-hover">
    <span className="grid min-w-0 flex-1 gap-0.5"><small className="text-caption text-muted-foreground">{small}</small><strong className="truncate text-ui font-medium">{title}</strong>{meta && <span className="truncate font-mono text-caption text-muted-foreground">{meta}</span>}</span>
    {back ? <CornerUpLeft size={15} aria-hidden /> : <ArrowRight size={15} aria-hidden className="transition-transform duration-150 ease-out group-hover/jump:translate-x-0.5" />}
  </button>
);

/** The cited lines themselves, because the point of a claim is that a reader can check it without leaving. */
function Quote({ a, onOpen, onLinks, links }: { a: NonNullable<EntityView["anchors"]>[number]; onOpen: () => void; onLinks?: () => void; links: string }) {
  const { data: source } = useQuery({ ...sourceQuery(a.path), retry: false });
  const lines = source?.split("\n").slice(a.line - 1, Math.min(a.endLine, a.line + 2)) ?? [];
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return (
    <div className="group/quote relative">
      <button onClick={onOpen} title={a.path} className="block w-full border-l-2 border-border py-0.5 pl-3 text-left font-mono text-caption leading-[1.6] transition-colors duration-150 ease-out hover:border-foreground">
        <span className="block truncate pr-10 text-muted-foreground">{a.label ?? a.path.split("/").pop()}:{a.line}</span>
        {lines.map((l, i) => <span key={i} className="block truncate">{l.slice(Number.isFinite(indent) ? indent : 0)}</span>)}
      </button>
      {onLinks && <button className="absolute top-0.5 right-0 font-mono text-caption text-muted-foreground underline-offset-2 opacity-0 transition-opacity duration-150 group-hover/quote:opacity-100 hover:underline focus-visible:opacity-100 [@media(hover:none)]:opacity-100" onClick={onLinks}>{links}</button>}
    </div>
  );
}

/** One line for anything that weakens trust in the sentence. Verified is the default, so it says nothing. */
function Trust({ step, drift }: { step: ViewStep; drift?: DriftItem }) {
  const { t } = useLang();
  const failed = step.claim.status === "unverified";
  if (!drift && !failed) return null;
  return (
    <details className="group/trust text-ui">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-foreground [&::-webkit-details-marker]:hidden">
        <i aria-hidden className={cn("size-2 shrink-0 rounded-full", failed ? "bg-destructive" : "bg-amber")} />
        <span className="min-w-0 flex-1">{failed ? t("这句话的依据在代码里找不到", "The code this sentence cites was not found") : drift ? driftCopy(drift.state, "step", t("zh", "en") === "zh") : ""}</span>
        <ChevronRight size={14} aria-hidden className="shrink-0 text-muted-foreground transition-transform duration-150 group-open/trust:rotate-90" />
      </summary>
      <div className="grid gap-1 pt-2 pl-4 text-caption text-muted-foreground [overflow-wrap:anywhere]">
        {failed && step.claim.faults.map((f, i) => <p key={i}>{f.replace(/^evidence: /, "")}</p>)}
        {drift?.paths.map((p) => <code key={p} className="font-mono">{p}</code>)}
        <p>{t("对照下面的代码重读。说得不对，运行 stemap fix 让本机代理改。", "Reread it against the code below. If it is wrong, stemap fix has a local agent correct it.")}</p>
      </div>
    </details>
  );
}

export function StepPanel({ journey, atlas, step, trail, via, drift, hues, room, onGo, onEnter, onReturn, onModule, onPreview }: {
  journey: ViewJourney; atlas: Atlas; step: ViewStep; trail: string[]; via: string[]; drift?: DriftItem; hues: Map<string, number>;
  /** The opened subflow this step sits in. Its pill can be a long way up the page, so it can be shut from here too. */
  room?: { title: string; onFold: () => void }; onGo: (id: string) => void;
  onEnter: (sub: string) => void; onReturn: (j: string, s: string, via: string[]) => void; onModule: (id: string) => void; onPreview: (id: string | null) => void;
}) {
  const { lang, t } = useLang();
  const router = useRouter();
  const onItem = useOpenItem();
  const onOpen = useOpenSource();
  // Both survive a step change: walking a journey with the logic open must not close it each time.
  const [tab, setTab] = useState("step");
  const [logicOpen, setLogicOpen] = useState<boolean | null>(null);
  const { data: view } = useQuery(entityQuery(`step:${journey.id}/${step.id}`));
  const idx = journey.steps.indexOf(step);
  const byId = (id: string) => journey.steps.find((s) => s.id === id);
  const sub = step.subflow ? atlas.journeys.find((j) => j.id === step.subflow) : undefined;
  // A journey can have several callers; the one the reader came through wins.
  const caller = (() => {
    const top = via.at(-1);
    if (top) { const [j, s] = top.split("/"); return { j: j!, s: s!, via: via.slice(0, -1) }; }
    for (const j of atlas.journeys) for (const s of j.steps) if (s.subflow === journey.id) return { j: j.id, s: s.id, via: [] as string[] };
    return null;
  })();
  const parent = caller ? atlas.journeys.find((j) => j.id === caller.j) : undefined;
  const parentStep = parent?.steps.find((s) => s.id === caller?.s);
  const resume = parentStep?.next.map((n) => parent!.steps.find((s) => s.id === n.to)).find(Boolean);
  const go = step.next[0];
  const groups = view?.groups ?? [];
  const linkCount = groups.filter((g) => ["cross", "entry", "tables"].includes(g.key)).reduce((n, g) => n + g.total, 0);
  const fns = groups.find((g) => g.key === "code")?.items.map((x) => ({ id: x.id, label: x.label })) ?? [];
  const cited = step.claim.refs.flatMap((r) => Array.from({ length: r.endLine - r.startLine + 1 }, (_, i) => r.startLine + i));
  const anchors = view?.anchors ?? step.claim.refs.map((r) => ({ path: r.path, line: r.startLine, endLine: r.endLine, fn: null, label: null }));
  const failure = step.kind === "failure";
  const zh = lang === "zh" ? step.zh : undefined;
  return (
    <aside aria-label={t("步骤", "Step")} className="flex h-full min-w-0 flex-col">
      {room && (
        <button onClick={room.onFold} className="flex shrink-0 items-center gap-1.5 border-b px-6 py-2 text-left text-caption text-muted-foreground transition-colors duration-150 ease-out hover:bg-muted hover:text-foreground">
          <ChevronUp size={14} aria-hidden className="shrink-0" /><span className="truncate">{t(`收起 ${room.title}`, `Collapse ${room.title}`)}</span>
        </button>
      )}
      <div className="flex shrink-0 items-center gap-2 pt-4 pr-3 pl-6">
        <span className="flex min-w-0 items-center gap-1 font-mono text-caption text-muted-foreground">
          {t(LANE_ZH[step.lane], (LANE_NAME[step.lane] ?? "").toLowerCase())}<span aria-hidden>·</span>
          <button className="min-w-0 truncate underline-offset-2 hover:text-foreground hover:underline" onClick={() => onModule(step.module)}>{step.module}</button>
        </span>
        <div className="ml-auto flex shrink-0 items-center font-mono text-caption tabular-nums">
          <Button variant="ghost" size="icon" className="size-8" title="←" aria-label={t("上一步", "Previous step")} disabled={trail.length < 2} onClick={() => router.history.back()}><ChevronLeft /></Button>
          <span className="min-w-10 text-center text-muted-foreground">{idx + 1}/{journey.steps.length}</span>
          <Button variant="ghost" size="icon" className="size-8" title="→" aria-label={t("下一步", "Next step")} disabled={!go && !sub} onClick={() => { if (sub) onEnter(sub.id); else if (go) onGo(go.to); }}><ChevronRight /></Button>
        </div>
      </div>
      <header className="px-6 pt-1 pb-3">
        <h2 className={cn("text-title font-semibold break-words", failure && "text-destructive")}>{t(step.titleZh, step.title)}</h2>
      </header>
      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="w-full justify-start gap-4 border-b px-6">
          <TabsTrigger value="step" className="flex-none px-0 text-ui">{t("说明", "Overview")}</TabsTrigger>
          <TabsTrigger value="links" disabled={!linkCount} className="flex-none px-0 text-ui">{t("关联", "Links")}{linkCount > 0 && <span className="font-mono text-caption text-muted-foreground tabular-nums">{linkCount}</span>}</TabsTrigger>
        </TabsList>
        <TabsContent value="step" key={step.id} className="min-h-0 overflow-auto px-6 pt-5 pb-8">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
            {/* The sentence and its proof stay one block: a claim without its code is only an opinion. */}
            <div className="grid gap-3">
              <Trust step={step} drift={drift} />
              <p className="max-w-[62ch] text-body text-pretty" lang={zh ? "zh" : "en"}>{zh ?? <Prose text={step.claim.text} />}</p>
              {anchors.length > 0 && (
                <div className="mt-1 grid grid-cols-[minmax(0,1fr)] gap-2.5">
                  <span className="text-caption text-muted-foreground">{t("依据", "Evidence")}</span>
                  {anchors.map((a, i) => <Quote key={i} a={a} links={t("关联", "Links")} onOpen={() => onOpen({ path: a.path, startLine: a.line, endLine: a.endLine })} onLinks={a.fn ? () => onItem({ id: a.fn!, kind: "fn" }) : undefined} />)}
                </div>
              )}
              {zh && (
                <details className="group/ste text-caption text-muted-foreground">
                  <summary className="flex w-fit cursor-pointer list-none items-center gap-1 hover:text-foreground [&::-webkit-details-marker]:hidden"><ChevronRight size={12} aria-hidden className="transition-transform duration-150 group-open/ste:rotate-90" />{t("英文原句", "English source")}</summary>
                  <p className="pt-1 leading-relaxed"><Prose text={step.claim.text} /></p>
                </details>
              )}
            </div>
            {sub && <Jump small={t("这一步是一条完整流程", "This step is a whole flow")} title={t(sub.titleZh, sub.title)} meta={`${sub.steps.length} ${t("步", "steps")}`} onClick={() => onEnter(sub.id)} />}
            {step.writes.length > 0 && (
              <Section title={t("写入", "Writes")}>
                <ul className="grid gap-2.5">
                  {step.writes.map((w, i) => {
                    const state = atlas.support?.writes[`${journey.id}/${step.id}/${i}`] ?? "other";
                    const table = tableOf(w.target);
                    return (
                      <li key={i} className="grid grid-cols-[3px_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                        <i aria-hidden className="row-span-2" style={{ background: hues.has(table) ? WIRE[hues.get(table)!] : "var(--border)" }} />
                        <span className="flex flex-wrap items-center gap-x-2">
                          {state === "other" ? <code className="font-mono text-caption break-all">{w.target}</code>
                            : <button className="font-mono text-caption break-all underline decoration-border underline-offset-2 hover:decoration-foreground" onClick={() => onItem({ id: `table:${table}`, kind: "table" })}>{w.target}</button>}
                          {state === "none" && <small title={t("代码索引没有追到这次写入", "The code index could not trace this write")} className="text-caption text-warn">{t("未确认", "Not confirmed")}</small>}
                        </span>
                        <p className="text-ui text-muted-foreground">{t(w.changeZh, w.change)}</p>
                      </li>
                    );
                  })}
                </ul>
              </Section>
            )}
            {step.next.length > 0 && (
              <Section title={step.next.length > 1 ? t("接下来取决于", "What happens next depends on") : t("下一步", "Next")} mark={step.kind === "decision" ? <TestMark /> : undefined}>
                {/* The rail is the fork from the map: each row reads as "if this, go there". */}
                <div className={cn("grid gap-px", step.next.length > 1 && "border-l-2 border-test pl-1.5")} onMouseLeave={() => onPreview(null)}>
                  {step.next.map((n, i) => {
                    const target = byId(n.to);
                    const name = target ? t(target.titleZh, target.title) : n.to;
                    const when = n.when ? t(n.whenZh, n.when) : undefined;
                    return (
                      <button key={n.to} onMouseEnter={() => onPreview(n.to)} onFocus={() => onPreview(n.to)} onBlur={() => onPreview(null)} onClick={() => { onPreview(null); onGo(n.to); }}
                        className={cn("group/next relative grid w-full gap-px rounded-[4px] py-1.5 pr-8 pl-2 text-left transition-colors duration-150 ease-out hover:bg-muted", n.failure && "text-destructive")}>
                        {step.next.length > 1 && i < 9 && <Kbd aria-hidden className="absolute top-1/2 right-1.5 -translate-y-1/2 font-mono tabular-nums group-hover/next:bg-background max-md:hidden">{i + 1}</Kbd>}
                        {when && <span className="text-ui">{when}</span>}
                        <span className={cn("flex min-w-0 items-center gap-1.5", when ? "text-caption" : "text-ui font-medium", when && !n.failure && "text-muted-foreground")}>
                          <ArrowRight size={12} aria-hidden className="shrink-0 transition-transform duration-150 ease-out group-hover/next:translate-x-0.5" /><span className="min-w-0 truncate">{name}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Section>
            )}
            {!step.next.length && !caller && <p className="text-ui text-muted-foreground">{failure ? t("流程在这里以失败结束。", "The flow stops here with a failure.") : t("流程到此完成。", "The flow is complete.")}</p>}
            {!step.next.length && caller && parent && (
              <Jump back small={failure ? t("子流程在此失败，返回", "This subflow fails here. Return to") : t("子流程到此结束，返回", "This subflow ends. Return to")} title={t(parent.titleZh, parent.title)}
                meta={resume && !failure ? t(resume.titleZh, resume.title) : undefined} onClick={() => onReturn(caller.j, failure ? caller.s : resume?.id ?? caller.s, caller.via)} />
            )}
            {fns.length > 0 && <StepLogic key={step.id} open={logicOpen ?? step.kind === "decision"} onToggle={setLogicOpen} onOpen={onOpen} fns={fns} cited={cited} />}
          </div>
        </TabsContent>
        <TabsContent value="links" className="min-h-0 overflow-auto px-6 pt-5 pb-8">
          {view && linkCount ? <div className="grid gap-5"><Groups view={view} onItem={onItem} only={["cross", "entry", "tables"]} /></div> : <Empty>{t("代码索引没有找到这一步的关联。", "The index found no link for this step.")}</Empty>}
        </TabsContent>
      </Tabs>
    </aside>
  );
}
