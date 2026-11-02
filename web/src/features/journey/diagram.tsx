import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { BaseEdge, EdgeLabelRenderer, MarkerType, Panel, ReactFlow, useReactFlow, useStore, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { LocateFixed, Maximize, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Atlas, ViewJourney, ViewStep } from "@/lib/api";
import type { DriftItem } from "@/lib/drift";
import { useLang } from "@/lib/lang";
import { cn } from "@/lib/utils";
import { keepMeasured } from "@/lib/flow";
import { fitChips, layoutFlow, stepTables, tableHues, traceWires, wirePath, type Inlined, type Placed, type Point, type WhenBox } from "./layout";
import { StepCard, type Card } from "./step-card";

interface FlowData extends Record<string, unknown> { points?: Point[]; when?: WhenBox; trace: string | null; failure: boolean; back: boolean; on: boolean; unconfirmed: boolean; onPick: (id: string) => void }
type IntroNode = Node<{ title: string; goal: string }, "intro">;

export const WIRE = ["var(--foreground)", "var(--teal)", "var(--moss-ink)", "var(--sand-ink)", "var(--violet)"];

const Intro = ({ data }: NodeProps<IntroNode>) => (
  <div>
    <h1 className="text-display font-semibold tracking-[-0.01em]">{data.title}</h1>
    <p className="mt-2 max-w-[56ch] text-ui leading-normal text-pretty text-muted-foreground">{data.goal}</p>
  </div>
);

/** Rose outranks the active ink: a failure path has to stay a failure path while the reader stands on the fork. */
const wireColour = (d: Pick<FlowData, "trace" | "on" | "failure">) => d.trace ?? (d.failure ? (d.on ? "var(--destructive)" : "color-mix(in oklch, var(--destructive) 55%, var(--edge))") : d.on ? "var(--foreground)" : "var(--edge)");

function Wire({ id, target, data, markerEnd }: EdgeProps<Edge<FlowData>>) {
  if (!data?.points) return null;
  const { when } = data;
  return (
    <>
      <g style={{ "--wire": wireColour(data) } as React.CSSProperties}>
        <BaseEdge id={id} path={wirePath(data.points)} markerEnd={markerEnd} className="flow-path" data-traced={!!data.trace} data-on={data.on} data-failure={data.failure} data-back={data.back} data-unconfirmed={data.unconfirmed} />
      </g>
      {/* The condition sits on its wire, so a fork reads without opening anything; a click follows that branch. */}
      {when && (
        <EdgeLabelRenderer>
          <button title={when.text} onClick={() => data.onPick(target)} data-on={data.on} data-failure={data.failure}
            className="flow-when nodrag nopan" style={{ transform: `translate(${when.x}px, ${when.y}px)`, width: when.width, height: when.height }}><span>{when.text}</span></button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** Branches of the whole flow that the folded view leaves out at this step. */
const hiddenOut = (full: ViewJourney, shown: ViewJourney, id: string) => {
  const ids = new Set(shown.steps.map((s) => s.id));
  return (full.steps.find((s) => s.id === id)?.next ?? []).filter((n) => !ids.has(n.to)).length;
};

const nodeTypes = { card: StepCard, intro: Intro };
const edgeTypes = { wire: Wire };

/** A flow outgrows the screen, so a rail keeps the whole length and your place in view. */
function Rail({ steps, pos, height, active, trail, moved, title, onPick }: { steps: ViewStep[]; pos: Map<string, Placed>; height: number; active: string; trail: string[]; moved: Map<string, DriftItem>; title: (s: ViewStep) => string; onPick: (id: string) => void }) {
  const { t } = useLang();
  if (steps.length < 12) return null;
  return (
    <div role="navigation" aria-label={t("流程全貌", "Flow overview")} className="absolute top-3 right-1 bottom-3 z-[6] w-3">
      {steps.map((s) => (
        <button key={s.id} aria-label={title(s)} title={title(s)} onClick={() => onPick(s.id)} style={{ top: `${((pos.get(s.id)?.y ?? 0) / height) * 100}%` }}
          className={cn(
            "absolute right-0 h-px w-1.5 bg-edge transition-[width,background-color] duration-100 after:absolute after:-inset-x-1 after:-inset-y-1 hover:w-3 hover:bg-foreground",
            s.kind === "decision" && "bg-test",
            moved.has(s.id) && "w-2.5 bg-amber",
            trail.includes(s.id) && "bg-foreground/60",
            s.id === active && "h-0.5 w-3 bg-foreground",
          )} />
      ))}
    </div>
  );
}

export function ZoomControls({ onLocate }: { onLocate?: () => void }) {
  const flow = useReactFlow();
  const { t } = useLang();
  const button = "size-7 text-muted-foreground";
  return (
    <Panel position="bottom-left" className="m-2.5! flex flex-col rounded-md bg-card p-0.5 shadow-raised">
      <Button variant="ghost" size="icon" className={button} aria-label={t("放大", "Zoom in")} title={t("放大", "Zoom in")} onClick={() => void flow.zoomIn({ duration: 160 })}><Plus /></Button>
      <Button variant="ghost" size="icon" className={button} aria-label={t("缩小", "Zoom out")} title={t("缩小", "Zoom out")} onClick={() => void flow.zoomOut({ duration: 160 })}><Minus /></Button>
      <Button variant="ghost" size="icon" className={button} aria-label={t("显示整条流程", "Fit the whole flow")} title={t("显示整条流程", "Fit the whole flow")} onClick={() => void flow.fitView({ duration: 240, padding: 0.04 })}><Maximize /></Button>
      {onLocate && <Button variant="ghost" size="icon" className={button} aria-label={t("回到当前步骤", "Back to this step")} title={t("回到当前步骤", "Back to this step")} onClick={onLocate}><LocateFixed /></Button>}
    </Panel>
  );
}

export function Diagram({ journey, full, inlined, active, trail, atlas, preview, drift, trace, pinned, onTrace, onPin, onPick, onEnter, onToggle }: {
  /** `inlined` says which subflows are open here; `journey` and `full` carry its flat steps, with and without folded failures. */
  journey: ViewJourney; full: ViewJourney; inlined: Inlined; active: string; trail: string[]; atlas: Atlas; preview: string | null; drift: Map<string, DriftItem>; trace: string | null; pinned: string | null; onTrace: (table: string | null) => void; onPin: (table: string) => void; onPick: (id: string) => void; onEnter: (sub: string, from: string) => void; onToggle: (key: string) => void;
}) {
  const flow = useReactFlow();
  // Bumped by the locate button: the camera effect already knows where the active step is.
  const [locate, setLocate] = useState(0);
  const { lang, t } = useLang();
  const title = useMemo(() => (s: ViewStep) => t(s.titleZh, s.title), [t]);
  const { data: placed } = useQuery({
    queryKey: ["flow-layout", journey.id, journey.steps.length, [...new Set(inlined.within.values())].join(), lang],
    queryFn: () => layoutFlow(journey, title, (n) => (lang === "zh" ? n.whenZh ?? n.when : n.when), (s) => hiddenOut(full, journey, s.id), inlined.within),
    staleTime: Infinity,
    // The last layout stays up while the next one runs, so opening a block never blanks the page.
    placeholderData: keepPreviousData,
  });
  const hues = useMemo(() => tableHues(full), [full]);
  const traced = useMemo(() => (trace ? traceWires(full, trace) : null), [full, trace]);

  const { nodes, edges } = useMemo(() => {
    if (!placed) return { nodes: [] as Node[], edges: [] as Edge<FlowData>[] };
    const { pos, routes, labels, width } = placed;
    const count = new Map<string, number>();
    for (const s of full.steps) count.set(s.module, (count.get(s.module) ?? 0) + 1);
    // The flow's main module is on nearly every node, so only a change of module earns the space.
    const home = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    const seen = new Set(trail);
    // The title sits over the entry, where the camera starts: a wide flow would leave the far left corner off screen.
    const intro: IntroNode = {
      id: "intro", type: "intro", position: { x: Math.max(0, Math.min(pos.get(journey.steps[0]!.id)?.x ?? 0, width - 460)), y: 0 }, draggable: false, selectable: false, zIndex: 1,
      style: { width: 460 }, data: { title: t(journey.titleZh, journey.title), goal: t(journey.goalZh, journey.goal) },
    };
    const groups = new Set(inlined.within.values());
    const cards: Card[] = journey.steps.flatMap((s) => {
      const p = pos.get(s.id);
      if (!p) return [];
      const tables = stepTables(s).sort((a, b) => (hues.get(a) ?? 9) - (hues.get(b) ?? 9));
      const { shown, more } = fitChips(tables);
      const hiddenBranches = hiddenOut(full, journey, s.id);
      const open = groups.has(s.id);
      const sub = atlas.journeys.find((x) => x.id === s.subflow);
      return [{
        // A box sits under what it holds, and a box inside a box above the one around it.
        id: s.id, type: "card" as const, position: { x: p.x, y: p.y }, draggable: false, zIndex: open ? 2 + s.id.split("/").length : 10, style: { width: p.width, height: p.height },
        data: {
          box: { w: p.width, h: p.height }, step: s, title: title(s), active: s.id === active, passed: seen.has(s.id) && s.id !== active, preview: s.id === preview,
          place: s.module === home ? "" : s.module, chips: shown.map((table) => ({ table, hue: hues.get(table) ?? 0 })), more,
          drift: drift.get(s.id)?.state, onTrace, writesTraced: !!trace && stepTables(s).includes(trace),
          subSteps: sub?.steps.length ?? 0, open, canOpen: !!sub?.steps.length && !inlined.origin.get(s.id)?.path.includes(sub.id), onToggle,
          foldWord: open ? t("收起", "Collapse") : t("在这里展开", "Expand here"), openWord: t("打开这条流程", "Open this flow"), stepsWord: t("步", "steps"), testWord: t("判断", "Decision"), waysWord: t("路", "ways"),
          hiddenBranches: hiddenBranches, stub: p.stub, foldNote: t(`${hiddenBranches} 个失败分支已折叠`, `${hiddenBranches} failure branches folded`), onPin, onEnter,
        },
      }];
    });
    const rawEdge = (from: string, to: string) => {
      const o = inlined.origin.get(from);
      return `${o?.journey.id ?? journey.id}/${o?.step.id ?? from}>${to.slice(o?.prefix.length ?? 0)}`;
    };
    const edges: Edge<FlowData>[] = journey.steps.flatMap((s) => s.next.flatMap((n) => {
      const id = `${s.id}>${n.to}`;
      const points = routes.get(id);
      if (!points) return [];
      const on = (s.id === active && (!preview || n.to === preview)) || (seen.has(s.id) && seen.has(n.to));
      const data: FlowData = { points, when: labels.get(id), trace: traced?.has(id) ? WIRE[hues.get(trace!) ?? 0]! : null, failure: !!n.failure, back: points[0]![1] > points.at(-1)![1], on, unconfirmed: atlas.support?.edges[rawEdge(s.id, n.to)] === false, onPick };
      return [{ id, source: s.id, target: n.to, type: "wire", sourceHandle: "out", targetHandle: "in", zIndex: on ? 12 : 11, markerEnd: { type: MarkerType.ArrowClosed, markerUnits: "userSpaceOnUse", width: 20, height: 20, color: wireColour(data) }, data }];
    }));
    return { nodes: keepMeasured(flow, [intro, ...cards] as Node[]), edges };
  }, [placed, journey, full, inlined, active, trail, t, title, atlas, preview, drift, hues, trace, traced, onTrace, onPin, onPick, onEnter, onToggle, flow]);

  // The flow fits when there is room. Below 80% nodes stop being readable, so the camera follows the active step at reading size.
  const width = useStore((s) => s.width);
  const viewH = useStore((s) => s.height);
  useEffect(() => {
    const p = placed?.pos.get(active);
    if (!placed || !p || !width || !viewH) return;
    const fit = (width - 72) / placed.width;
    const zoom = fit >= 0.8 ? Math.min(1, fit) : 0.92;
    const span = placed.width * zoom;
    const x = fit >= 0.8 ? Math.max(36, (width - 18 - span) / 2) : Math.max(width - 36 - span, Math.min(36, width / 2 - (p.x + p.width / 2) * zoom));
    // The first step always opens with the flow's title in view, however far a loop pushed it down.
    // An opened box can be taller than the screen: the reader wants its head, not its middle.
    const y = active === journey.steps[0]?.id ? 28 : Math.min(28, viewH * 0.36 - (p.y + Math.min(p.height, 120) / 2) * zoom);
    void flow.setViewport({ x, y, zoom }, { duration: 280 });
  }, [active, placed, flow, width, viewH, journey, locate]);

  // Keeping a table is asking to see its whole stretch, and most of it starts out of view.
  useEffect(() => {
    if (!pinned || !placed) return;
    const ids = new Set([...traceWires(full, pinned)].flatMap((w) => w.split(">")));
    for (const s of full.steps) if (stepTables(s).includes(pinned)) ids.add(s.id);
    const boxes = [...ids].flatMap((id) => placed.pos.get(id) ?? []);
    if (!boxes.length) return;
    const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.width)), bottom = Math.max(...boxes.map((b) => b.y + b.height));
    // A stretch too long to read at once starts at its first step: a whole flow at 30% is a picture, not a page.
    if ((bottom - y) * 0.6 > viewH || (right - x) * 0.6 > width) {
      const first = boxes.reduce((a, b) => (b.y < a.y ? b : a));
      void flow.setCenter(first.x + first.width / 2, first.y + viewH * 0.3, { zoom: 0.8, duration: 320 });
    } else void flow.fitBounds({ x, y, width: right - x, height: bottom - y }, { padding: 0.08, duration: 320 });
  }, [pinned, placed, full, flow, viewH, width]);

  const ordered = useMemo(() => [...journey.steps].sort((a, b) => (placed?.pos.get(a.id)?.y ?? 0) - (placed?.pos.get(b.id)?.y ?? 0)), [journey, placed]);
  return (
    <ReactFlow data-tracing={!!trace} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodeClick={(_, n) => { if (n.type === "card") onPick(n.id); }}
      nodesConnectable={false} nodesDraggable={false} elementsSelectable={false} nodesFocusable={false} edgesFocusable={false} minZoom={0.2} maxZoom={1.1}
      panOnScroll zoomOnScroll={false} proOptions={{ hideAttribution: true }}>
      {placed && <Rail steps={ordered} pos={placed.pos} height={placed.height} active={active} trail={trail} moved={drift} title={title} onPick={onPick} />}
      <ZoomControls onLocate={() => setLocate((n) => n + 1)} />
    </ReactFlow>
  );
}
