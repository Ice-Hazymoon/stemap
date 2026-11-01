import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate, useRouter } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { z } from "zod";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Workspace } from "@/components/shell/workspace";
import { Diagram } from "@/features/journey/diagram";
import { mainPath, tableHues } from "@/features/journey/layout";
import { StepPanel } from "@/features/journey/step-panel";
import { atlasQuery, type ViewJourney } from "@/lib/api";
import { driftBy } from "@/lib/drift";
import { useLang } from "@/lib/lang";
import { useOpenItem } from "@/lib/nav";
import { useTrail, useVisit } from "@/lib/trail";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/journeys/$journeyId")({
  validateSearch: z.object({
    step: z.string().optional().catch(undefined),
    /** Subflow calls entered so far, as `journey/step`, newest last. */
    via: z.array(z.string()).optional().catch(undefined),
  }),
  component: JourneyPage,
});

function JourneyPage() {
  const { data: atlas } = useSuspenseQuery(atlasQuery);
  const { journeyId } = Route.useParams();
  const journey = atlas.journeys.find((j) => j.id === journeyId);
  // A link to a flow that no longer exists lands on the list, not on some other flow it never meant.
  if (!journey) return <Navigate to="/journeys" replace />;
  return <Loaded key={journey.id} journey={journey} />;
}

/** Only what the diagram cannot say by itself. A table here is a control: it traces that table through the flow. */
function Legend({ journey, pinned, moved, onTrace, onPin, onMoved, children }: { journey: ViewJourney; pinned: string | null; moved: number; onTrace: (t: string | null) => void; onPin: (t: string) => void; onMoved: () => void; children?: ReactNode }) {
  const hues = useMemo(() => [...tableHues(journey)], [journey]);
  const { t } = useLang();
  const bg = ["", "bg-sage", "bg-moss", "bg-sand", "bg-lilac"];
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t bg-card px-4 py-2 text-caption text-muted-foreground">
      {hues.length > 0 && (
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 max-md:hidden">{t("追踪表", "Trace")}</span>
          <ul aria-label={t("追踪一张表", "Trace a table")} className="flex min-w-0 flex-wrap items-center gap-1" onMouseLeave={() => onTrace(null)}>
            {hues.map(([table, hue]) => (
              <li key={table}><button title={t("看这张表从第一次写入到最后一次写入，点击固定", "Show this table from its first write to its last. Click to keep it")} aria-pressed={pinned === table} onClick={() => onPin(table)} onMouseEnter={() => onTrace(table)} onFocus={() => onTrace(table)} onBlur={() => onTrace(null)}
                className={cn("rounded-[3px] px-1.5 font-mono leading-[22px] text-[var(--chip-ink)] aria-pressed:shadow-[0_0_0_1.5px_var(--foreground)]", bg[hue])}>{table}</button></li>
            ))}
          </ul>
        </div>
      )}
      <ul aria-label={t("图例", "Legend")} className="flex items-center gap-x-4 max-md:hidden">
        <li className="flex items-center gap-1.5"><i aria-hidden className="block w-5 border-t border-dashed border-muted-foreground" />{t("失败或重试", "Failure or retry")}</li>
        <li title={t("代码索引没有找到这条连线，以文字说明为准", "The code index did not find this link, so it rests on the written step")} className="flex items-center gap-1.5"><i aria-hidden className="block w-5 border-t-2 border-dotted border-muted-foreground" />{t("未确认", "Unconfirmed")}</li>
      </ul>
      {moved > 0 && <button onClick={onMoved} title={t("跳到下一处：这一步说明依据的代码改了", "Go to the next step whose code has changed")} className="flex items-center gap-1.5 rounded-[3px] hover:text-foreground"><i aria-hidden className="size-[7px] rounded-full bg-amber" /><span className="tabular-nums">{t(`${moved} 处依据改了`, `${moved} changed`)}</span></button>}
      {children}
    </div>
  );
}

function Loaded({ journey }: { journey: ViewJourney }) {
  const { data: atlas } = useSuspenseQuery(atlasQuery);
  const { t } = useLang();
  const router = useRouter();
  const navigate = Route.useNavigate();
  const onItem = useOpenItem();
  const { step: stepId, via = [] } = Route.useSearch();
  const step = journey.steps.find((s) => s.id === stepId) ?? journey.steps[0]!;
  useVisit(journey.id, step.id);
  const trail = useTrail();
  const go = useCallback((id: string) => void navigate({ search: (p) => ({ ...p, step: id, i: undefined }) }), [navigate]);
  const enter = useCallback((sub: string) => {
    void navigate({ to: "/journeys/$journeyId", params: { journeyId: sub }, search: { via: [...via, `${journey.id}/${step.id}`] } });
  }, [navigate, via, journey.id, step.id]);
  const main = useMemo(() => mainPath(journey), [journey]);
  const foldable = journey.steps.length - main.size;
  const [fold, setFold] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // Hover looks, a click keeps: a pinned table stays traced while the reader walks the flow.
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const trace = hovered ?? pinned;
  // Crossing a chip on the way somewhere must not grey the whole canvas: only a pause counts as looking.
  const wait = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hover = useCallback((table: string | null) => {
    clearTimeout(wait.current);
    if (table) wait.current = setTimeout(() => setHovered(table), 140);
    else setHovered(null);
  }, []);
  useEffect(() => () => clearTimeout(wait.current), []);
  const pin = useCallback((table: string) => setPinned((p) => (p === table ? null : table)), []);
  const folded = (fold ?? journey.steps.length > 22) && foldable > 0 && main.has(step.id);
  const shown = useMemo<ViewJourney>(() => {
    if (!folded) return journey;
    return { ...journey, steps: journey.steps.filter((s) => main.has(s.id)).map((s) => ({ ...s, next: s.next.filter((n) => main.has(n.to)) })) };
  }, [journey, folded, main]);
  const driftSteps = useMemo(() => {
    const all = driftBy(atlas);
    return new Map(journey.steps.flatMap((s) => { const d = all.get(`flow/${journey.id}/${s.id}`); return d ? [[s.id, d] as const] : []; }));
  }, [atlas, journey]);
  // Walks the moved steps in flow order and comes round again, so the amber count is also the way through them.
  const nextMoved = useCallback(() => {
    const ids = journey.steps.filter((s) => driftSteps.has(s.id)).map((s) => s.id);
    const after = journey.steps.findIndex((s) => s.id === step.id);
    const next = journey.steps.slice(after + 1).find((s) => driftSteps.has(s.id))?.id ?? ids[0];
    if (next) go(next);
  }, [journey, driftSteps, step.id, go]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [role=dialog]")) return;
      if (e.key === "ArrowRight") { if (step.subflow) enter(step.subflow); else if (step.next[0]) go(step.next[0].to); }
      if (e.key === "ArrowLeft") router.history.back();
      if (e.key === "Escape") setPinned(null);
      if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) { const n = step.next[Number(e.key) - 1]; if (n) go(n.to); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, go, enter, router]);
  return (
    <Workspace
      main={
        <div className="flex h-full min-h-0 flex-col">
          <div className="relative min-h-0 flex-1">
            <ReactFlowProvider><Diagram journey={shown} full={journey} active={step.id} trail={trail} atlas={atlas} preview={preview} drift={driftSteps} trace={trace} pinned={pinned} onTrace={hover} onPin={pin} onPick={go} /></ReactFlowProvider>
          </div>
          <Legend journey={journey} pinned={pinned} moved={driftSteps.size} onTrace={hover} onPin={pin} onMoved={nextMoved}>
            {foldable > 0 && (
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <Switch id="failures" size="sm" checked={!folded} onCheckedChange={(on) => setFold(!on)} />
                <Label htmlFor="failures" className="text-caption font-normal text-muted-foreground">{t("显示失败分支", "Show failure branches")}<span className="font-mono tabular-nums">{foldable}</span></Label>
              </div>
            )}
          </Legend>
        </div>
      }
      side={
        <StepPanel journey={journey} atlas={atlas} step={step} trail={trail} via={via} drift={driftSteps.get(step.id)} onGo={go} onEnter={enter}
          onReturn={(j, s, v) => void navigate({ to: "/journeys/$journeyId", params: { journeyId: j }, search: { step: s, via: v } })}
          onModule={(id) => onItem({ id: `module:${atlas.nodes[id] ? id : id.split(".")[0]!}`, kind: "module" })} onPreview={setPreview} />
      }
    />
  );
}
