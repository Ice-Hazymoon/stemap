import { useQuery } from "@tanstack/react-query";
import type { ViewJourney } from "@/lib/api";
import { useLang } from "@/lib/lang";
import { INTRO_H, layoutFlow, wirePath, type Point } from "./layout";

const W = 360, H = 64, PAD = 4;

/** The same numbers wherever a flow is summed up: how long it is, where it forks, how much needs rereading. */
export function FlowFacts({ j, moved }: { j: ViewJourney; moved: number }) {
  const { t } = useLang();
  const decisions = j.steps.filter((s) => s.kind === "decision").length;
  return (
    <span className="flex items-center gap-2 font-mono text-caption text-muted-foreground tabular-nums">
      <span>{j.steps.length} {t("步", "steps")}</span>
      {decisions > 0 && <span>{decisions} {t("判断", decisions === 1 ? "decision" : "decisions")}</span>}
      {moved > 0 && <span title={t(`${moved} 处依据的代码改了`, `${moved} rest on changed code`)} className="inline-flex items-center gap-1 text-foreground"><i aria-hidden className="size-[7px] rounded-full bg-amber" />{moved}</span>}
    </span>
  );
}

/**
 * The flow's real shape on its side, so time runs left to right: a line is a line and a bushy flow looks bushy.
 * Each axis fits alone, because this is a fingerprint and not a map. Tests are the coloured stretches.
 */
export function FlowGlyph({ j }: { j: ViewJourney }) {
  const { t } = useLang();
  // Conditions take room on the map only: the fingerprint is the shape, so it has its own layout key.
  const { data } = useQuery({ queryKey: ["flow-glyph", j.id, j.steps.length], queryFn: () => layoutFlow(j, (s) => t(s.titleZh, s.title)), staleTime: Infinity });
  if (!data) return <div style={{ aspectRatio: `${W} / ${H}` }} />;
  const toX = (y: number) => PAD + ((y - INTRO_H) / Math.max(1, data.height - INTRO_H)) * (W - PAD * 2);
  // A narrow flow stays narrow: fitting it to the full height would turn a small offset into a jump.
  const span = Math.max(data.width, 680);
  const toY = (x: number) => H / 2 + ((x - data.width / 2) / span) * (H - PAD * 2);
  const on = ([x, y]: Point): Point => [Math.round(toX(y) * 10) / 10, Math.round(toY(x) * 10) / 10];
  return (
    <svg aria-hidden viewBox={`0 0 ${W} ${H}`} className="block w-full overflow-visible">
      <g fill="none" stroke="var(--edge)" strokeWidth={0.75} strokeLinecap="round">
        {[...data.routes].map(([id, points]) => <path key={id} d={wirePath(points.map(on))} />)}
        {/* Each step is a stretch of the line and a test is the coloured part of it, so wires and steps join up. */}
        {j.steps.map((s) => {
          const b = data.pos.get(s.id);
          if (!b) return null;
          const test = s.kind === "decision", y = toY(b.x + b.width / 2);
          return <path key={s.id} d={`M${toX(b.y)},${y} L${toX(b.y + b.height)},${y}`} stroke={test ? "var(--test)" : undefined} strokeWidth={test ? 2 : undefined} />;
        })}
      </g>
    </svg>
  );
}
