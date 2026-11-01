import { useMemo } from "react";
import { getBezierPath, Position } from "@xyflow/react";
import type { Crossings } from "@/lib/api";
import { useLang } from "@/lib/lang";
import { cn } from "@/lib/utils";

const NODE_W = 168, NODE_H = 48, GAP_X = 72, GAP_Y = 24;
type At = { x: number; y: number };

/** Calls and required order read left to right; data links stay hidden until a journey is chosen. */
function layout(c: Crossings) {
  const edges = c.links.filter((l) => l.subflow || l.after);
  const rank = new Map(c.journeys.map((j) => [j.id, 0]));
  for (let i = 0; i < c.journeys.length; i++) for (const e of edges) {
    rank.set(e.to, Math.max(rank.get(e.to)!, Math.min(rank.get(e.from)! + 1, c.journeys.length - 1)));
  }
  const cols = new Map<number, string[]>();
  for (const j of c.journeys) { const r = rank.get(j.id)!; cols.set(r, [...(cols.get(r) ?? []), j.id]); }
  const pos = new Map<string, At>();
  for (const [r, ids] of cols) ids.forEach((id, i) => pos.set(id, { x: r * (NODE_W + GAP_X), y: i * (NODE_H + GAP_Y) }));
  const width = Math.max(...[...cols.keys()].map((r) => (r + 1) * (NODE_W + GAP_X))) - GAP_X;
  const height = Math.max(...[...cols.values()].map((v) => v.length)) * (NODE_H + GAP_Y) - GAP_Y;
  return { pos, width, height, edges };
}

/** Sideways between columns, straight down inside one, so a link never doubles back through its own card. */
function wire(a: At, b: At) {
  const down = a.x === b.x, forward = b.x >= a.x, below = b.y >= a.y;
  const [path] = getBezierPath(down
    ? { sourceX: a.x + NODE_W / 2, sourceY: a.y + (below ? NODE_H : 0), sourcePosition: below ? Position.Bottom : Position.Top, targetX: b.x + NODE_W / 2, targetY: b.y + (below ? 0 : NODE_H), targetPosition: below ? Position.Top : Position.Bottom }
    : { sourceX: a.x + (forward ? NODE_W : 0), sourceY: a.y + NODE_H / 2, sourcePosition: forward ? Position.Right : Position.Left, targetX: b.x + (forward ? 0 : NODE_W), targetY: b.y + NODE_H / 2, targetPosition: forward ? Position.Left : Position.Right });
  return path;
}

/** Two flows that lead into each other are one relation, so they share one line with a head at each end. */
function pairs<T extends { from: string; to: string }>(links: T[]) {
  const out = new Map<string, T & { both: boolean }>();
  for (const l of links) {
    const back = out.get(`${l.to}>${l.from}`);
    if (back) back.both = true;
    else out.set(`${l.from}>${l.to}`, { ...l, both: false });
  }
  return [...out.values()];
}

const TIP = { call: "stroke-muted-foreground", after: "stroke-edge", data: "stroke-edge" };

export function Relations({ c, selected, onPick }: { c: Crossings; selected?: string; onPick: (id: string) => void }) {
  const { t } = useLang();
  const { pos, width, height, edges } = useMemo(() => layout(c), [c]);
  const lines = useMemo(() => pairs(edges), [edges]);
  const data = selected ? c.links.filter((l) => l.data.length && (l.from === selected || l.to === selected) && !l.subflow && !l.after) : [];
  return (
    <div className="overflow-x-auto px-px pt-3.5 pb-1">
      <div className="relative" style={{ width, height }}>
        <svg width={width} height={height} aria-hidden className="pointer-events-none absolute inset-0 overflow-visible fill-none">
          <defs>
            {(["call", "after", "data"] as const).map((k) => (
              <marker key={k} id={`rel-${k}`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M1,1 L9,5 L1,9" fill="none" className={TIP[k]} strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
              </marker>
            ))}
          </defs>
          {pairs(data).map((l) => <path key={`d${l.from}${l.to}`} d={wire(pos.get(l.from)!, pos.get(l.to)!)} className="stroke-edge" strokeWidth={1.25} strokeDasharray="1 4" strokeLinecap="round" markerEnd="url(#rel-data)" markerStart={l.both ? "url(#rel-data)" : undefined} />)}
          {lines.map((l) => {
            const k = l.subflow ? "call" : "after";
            return <path key={`${l.from}${l.to}`} d={wire(pos.get(l.from)!, pos.get(l.to)!)} className={l.subflow ? "stroke-muted-foreground" : "stroke-edge"} strokeWidth={1.25} strokeDasharray={l.subflow ? undefined : "4 4"} markerEnd={`url(#rel-${k})`} markerStart={l.both ? `url(#rel-${k})` : undefined} />;
          })}
        </svg>
        {c.journeys.map((j) => {
          const p = pos.get(j.id)!;
          const near = selected === j.id || data.some((l) => l.from === j.id || l.to === j.id);
          return (
            <button key={j.id} onClick={() => onPick(j.id)} title={t(j.titleZh, j.title)} style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }} className={cn(
              "absolute rounded-[4px] bg-card px-3 text-left text-ui leading-tight font-medium shadow-raised transition-[opacity,box-shadow] duration-150 ease-out hover:shadow-raised-hover",
              selected === j.id && "bg-primary text-primary-foreground shadow-none",
              selected && !near && "opacity-45",
            )}><span className="line-clamp-2">{t(j.titleZh, j.title)}</span></button>
          );
        })}
      </div>
    </div>
  );
}
