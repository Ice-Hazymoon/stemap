import { memo, useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, useStore, type Node, type NodeProps } from "@xyflow/react";
import { ChevronRight } from "lucide-react";
import { Prose } from "@/components/shell/prose";
import { ZoomControls } from "@/features/journey/diagram";
import type { Atlas, ViewNode } from "@/lib/api";
import { keepMeasured } from "@/lib/flow";
import { useLang } from "@/lib/lang";
import { cn } from "@/lib/utils";
import { ancestors } from "./tree";
import { layoutTree } from "./layout";

interface BoxData extends Record<string, unknown> {
  node: ViewNode; open: boolean; dim: boolean; selected: boolean;
  onToggle: (id: string) => void;
}
type Box = Node<BoxData, "box">;
const hidden = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 };

const BoxNode = memo(function BoxNode({ data }: NodeProps<Box>) {
  const { node, open, dim, selected, onToggle } = data;
  const { lang, t } = useLang();
  const domain = node.kind === "domain";
  // What holds other boxes is outlined, not filled: its children are separate nodes in their own ink and would vanish.
  const holds = domain || open;
  const toggle = t(`${open ? "收起" : "展开"} ${node.children.length} 个子模块`, `${open ? "Collapse" : "Expand"} ${node.children.length} sub-modules`);
  return (
    <div className={cn(
      "group/box flex size-full flex-col justify-center rounded-md px-2 transition-[opacity,background-color,box-shadow] duration-150",
      domain ? "justify-start rounded-md bg-card px-3.5 py-2.5 shadow-raised" : "hover:bg-accent",
      open && !domain && "justify-start bg-muted pt-1.5",
      selected && (holds ? "shadow-[var(--selected)]" : "bg-primary text-primary-foreground hover:bg-primary"),
      dim && "opacity-50",
    )}>
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
      <div className="flex min-w-0 items-center gap-2">
        <span title={node.zh} className={cn("min-w-0 flex-1 truncate text-ui", domain ? "font-semibold" : "font-normal")}>{domain && lang === "zh" && node.zh ? node.zh : node.title}</span>
        {!domain && node.children.length > 0 && (
          <button className="nodrag flex h-[18px] shrink-0 items-center gap-0.5 rounded-sm px-1 font-mono text-caption tabular-nums opacity-70 hover:opacity-100" aria-expanded={open} aria-label={toggle} title={toggle}
            onClick={(e) => { e.stopPropagation(); onToggle(node.id); }}>{node.children.length}<ChevronRight size={12} aria-hidden className={cn("transition-transform duration-150", open && "rotate-90")} /></button>
        )}
      </div>
      {domain && node.oneLine && lang !== "zh" && <p className="mt-0.5 line-clamp-1 text-caption text-muted-foreground"><Prose text={node.oneLine.text} plain /></p>}
    </div>
  );
});

const nodeTypes = { box: BoxNode };

/**
 * What the selection touches stays at full strength and the rest recedes. Lines across this grid would run over the text,
 * and the panel's Links tab already says which way each relation goes.
 */
function linksFor(atlas: Atlas, selected: string, visible: Set<string>) {
  const up = (id: string) => ancestors(atlas, id).reverse().find((n) => visible.has(n.id))?.id;
  const inScope = (id: string) => ancestors(atlas, id).some((n) => n.id === selected);
  const counts = new Map<string, { source: string; target: string; count: number }>();
  for (const e of atlas.edges) {
    const f = inScope(e.from), t = inScope(e.to);
    if (f === t) continue;
    const source = up(e.from), target = up(e.to);
    if (!source || !target || source === target) continue;
    const key = `${source}>${target}`;
    const c = counts.get(key) ?? { source, target, count: 0 };
    c.count++;
    counts.set(key, c);
  }
  return [...counts.values()];
}

interface CanvasProps { atlas: Atlas; selected: string; focus: string; expanded: Set<string>; onSelect: (id: string) => void; onToggle: (id: string) => void }

function Inner({ atlas, selected, focus, expanded, onSelect, onToggle }: CanvasProps) {
  const flow = useReactFlow();
  const { lang, t } = useLang();
  // The first ratio holds, so that opening the source panel does not reshuffle the map.
  const live = useStore((s) => (s.width && s.height ? s.width / s.height : 0));
  const first = useRef(0);
  if (!first.current && live) first.current = live;
  const ratio = first.current;
  const { data: placed = [] } = useQuery({
    queryKey: ["module-layout", focus, [...expanded].sort(), ratio, lang], enabled: !!ratio,
    queryFn: () => layoutTree(atlas, focus, expanded, ratio, lang !== "zh"),
  });
  useEffect(() => { if (placed.length) requestAnimationFrame(() => void flow.fitView({ padding: 0.02, duration: 240, maxZoom: 1 })); }, [placed, flow]);

  const nodes = useMemo<Box[]>(() => {
    const links = linksFor(atlas, selected, new Set(placed.map((p) => p.id)));
    const lit = new Set(links.flatMap((l) => [l.source, l.target]));
    const chain = new Set(ancestors(atlas, selected).map((n) => n.id));
    return keepMeasured(flow, placed.map((p) => ({
      id: p.id, type: "box", position: { x: p.x, y: p.y }, parentId: p.parent, draggable: false,
      style: { width: p.width, height: p.height },
      zIndex: p.node.kind === "domain" ? 0 : p.node.kind === "module" ? 2 : 3,
      data: { node: p.node, open: p.open, onToggle, selected: p.id === selected, dim: links.length > 0 && !lit.has(p.id) && !chain.has(p.id) && p.node.kind !== "domain" },
    })));
  }, [placed, atlas, selected, onToggle, flow]);

  const picked = atlas.nodes[selected];
  const name = (picked?.kind === "domain" && lang === "zh" && picked.zh) || picked?.title || "";
  const dimmed = nodes.some((n) => n.data.dim);
  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <ReactFlow nodes={nodes} nodeTypes={nodeTypes}
          onNodeClick={(_, n) => onSelect(n.id)} onNodeDoubleClick={(_, n) => onToggle(n.id)} onPaneClick={() => onSelect(focus)}
          nodesConnectable={false} nodesDraggable={false} elementsSelectable={false} nodesFocusable={false} minZoom={0.12} maxZoom={1.6} fitView fitViewOptions={{ padding: 0.02, maxZoom: 1 }} proOptions={{ hideAttribution: true }} />
        <ZoomControls />
      </div>
      {/* Fading boxes without a word looks like a loading state: the line always says what the page is showing. */}
      <p className="shrink-0 truncate border-t bg-card px-4 text-caption leading-9 text-muted-foreground">
        {dimmed ? t(`和 ${name} 有依赖的模块保持深色，其余变淡。点空白处取消。`, `Modules linked to ${name} stay dark, the rest fade. Click empty space to clear.`) : t("点模块看说明，点数字展开子模块。", "Click a module to read about it, click its number to open it.")}
      </p>
    </div>
  );
}

export const ModuleCanvas = (p: CanvasProps) => <ReactFlowProvider><Inner {...p} /></ReactFlowProvider>;
