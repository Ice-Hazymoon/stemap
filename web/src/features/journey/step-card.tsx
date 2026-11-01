import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ArrowUpRight, Split } from "lucide-react";
import type { ViewStep } from "@/lib/api";
import { DriftDot, type DriftState } from "@/lib/drift";
import { cn } from "@/lib/utils";
import { diamondPath } from "./layout";

export interface CardData extends Record<string, unknown> {
  box: { w: number; h: number }; step: ViewStep; title: string; active: boolean; passed: boolean; preview: boolean; place: string;
  chips: { table: string; hue: number }[]; more: number; hiddenBranches: number; stub?: number; foldNote: string; drift?: DriftState; subSteps: number; stepsWord: string; testWord: string; waysWord: string; writesTraced: boolean;
  onTrace: (table: string | null) => void;
  onPin: (table: string) => void;
}
export type Card = Node<CardData, "card">;

const CHIP_BG = ["bg-[color-mix(in_oklch,currentColor_9%,transparent)] text-inherit", "bg-sage", "bg-moss", "bg-sand", "bg-lilac"];
const hidden = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 };

function Chips({ chips, more, onTrace, onPin }: Pick<CardData, "chips" | "more" | "onTrace" | "onPin">) {
  if (!chips.length) return null;
  return (
    <span className="relative flex min-w-0 items-center gap-1 font-mono text-caption leading-[22px]" onMouseLeave={() => onTrace(null)}>
      {chips.map((c) => <span key={c.table} title={c.table} onMouseEnter={() => onTrace(c.table)} onClick={(e) => { e.stopPropagation(); onPin(c.table); }} className={cn("min-w-0 cursor-pointer truncate rounded-[3px] px-1.5 text-[var(--chip-ink)]", CHIP_BG[c.hue])}>{c.table}</span>)}
      {more > 0 && <span className="shrink-0 pl-0.5 opacity-60">+{more}</span>}
    </span>
  );
}

/** One sign for "the flow forks here", the same on the node, in the legend, in the panel and in the logic tree. */
export const TestMark = ({ size = 14 }: { size?: number }) => <Split size={size} strokeWidth={2.25} aria-hidden className="shrink-0 rotate-180 text-test" />;

const state = (d: CardData) => (d.active ? "active" : d.preview ? "preview" : d.passed ? "passed" : undefined);

function Shape({ data }: { data: CardData }) {
  const { step, title, chips, more, subSteps, place, drift, onTrace, onPin } = data;
  const common = { "data-kind": step.kind, "data-state": state(data), "data-writes": data.writesTraced };
  if (step.kind === "start") return (
    <div {...common} className="flow-node flex h-full items-center gap-2 px-3.5 text-ui font-medium">
      <i aria-hidden className="size-2.5 shrink-0 rounded-full bg-current" /><span className="line-clamp-2 leading-tight">{title}</span>{drift && <DriftDot state={drift} />}
    </div>
  );
  if (step.kind === "end" || step.kind === "failure") return (
    <div {...common} className="flow-node flex h-full items-center justify-center gap-1.5 px-3.5 text-center text-ui font-medium">
      <span className="line-clamp-2 leading-tight">{title}</span>{drift && <DriftDot state={drift} />}
    </div>
  );
  if (step.kind === "subflow") return (
    <div {...common} className="flow-node flex h-full items-center gap-2 pr-2 pl-5">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui font-medium">{title}</span>
        <span className="font-mono text-caption leading-4 tabular-nums opacity-65">{subSteps} {data.stepsWord}</span>
      </span>
      <span className="grid size-8 shrink-0 place-items-center"><ArrowUpRight size={15} strokeWidth={2} /></span>
    </div>
  );
  const test = step.kind === "decision", ways = step.next.length + data.hiddenBranches;
  return (
    <div {...common} className={cn("flow-node flex h-full flex-col justify-center gap-1", test ? "px-6" : "px-3")}>
      {test && <svg aria-hidden width={data.box.w} height={data.box.h} className="flow-test absolute inset-0"><path d={diamondPath(data.box.w, data.box.h)} /></svg>}
      {/* Shape, colour, icon and words all say "test", so it still reads when the map is zoomed out or the colour is lost. */}
      {test && <span className="flow-test-tag relative flex items-center gap-1 text-caption leading-4 font-medium"><Split size={12} strokeWidth={2.5} aria-hidden className="rotate-180" />{data.testWord}{ways > 1 && <span className="font-normal tabular-nums">· {ways} {data.waysWord}</span>}</span>}
      <span className="relative flex min-w-0 items-start gap-1.5 text-ui font-medium"><span className="line-clamp-2 leading-[1.3]">{title}</span>{drift && <DriftDot state={drift} className="mt-1.5" />}</span>
      {place && <span className="relative truncate font-mono text-caption leading-4 opacity-65">{place}</span>}
      <Chips chips={chips} more={more} onTrace={onTrace} onPin={onPin} />
    </div>
  );
}

export const StepCard = memo(function StepCard({ data }: NodeProps<Card>) {
  return (
    <div className="relative h-full" title={data.title}>
      <Handle id="in" type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <Handle id="out" type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
      <Shape data={data} />
      {/* A folded branch still shows where the flow can fail: a stub of its dashed wire and how many leave here. */}
      {data.hiddenBranches > 0 && (
        <span role="img" aria-label={data.foldNote} title={data.foldNote} style={{ left: data.stub ?? data.box.w - 28 }} className="absolute top-full flex h-3.5 items-end gap-1 font-mono text-caption leading-none text-destructive">
          <i aria-hidden className="h-full w-0 border-l border-dashed border-current" />{data.hiddenBranches}
        </span>
      )}
    </div>
  );
});
