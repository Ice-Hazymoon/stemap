import type { Atlas } from "@/lib/api";
import { useLang } from "@/lib/lang";
import { cn } from "@/lib/utils";

export type DriftItem = Atlas["drift"]["items"][number];
export type DriftState = DriftItem["state"];

/** One sentence per state, so a reader knows what moved and what to do about it. */
const COPY: Record<DriftState, [string, string]> = {
  changed: ["这句话依据的代码改过了", "The code behind this step has changed"],
  lost: ["这句话引用的那行代码不见了", "The line this step quotes is gone"],
  unlocked: ["这句话是新写的，还没核对", "New, not checked yet"],
  edited: ["这句话改过，还没核对", "Edited, not checked yet"],
};
export const driftCopy = (state: DriftState, noun = "step", zh = false) => (zh ? COPY[state][0] : COPY[state][1].replace("this step", `this ${noun}`));

export const driftBy = (atlas: Atlas) => new Map(atlas.drift.items.map((d) => [d.id, d]));
export const movedIn = (atlas: Atlas, journey: string) => atlas.drift.items.filter((d) => d.id.startsWith(`flow/${journey}/`)).length;

/** A dot is enough on a dense surface; the sentence is the tooltip. */
export function DriftDot({ state, noun, className }: { state: DriftState; noun?: string; className?: string }) {
  const note = driftCopy(state, noun, useLang().lang === "zh");
  return <i role="img" aria-label={note} title={note} className={cn("inline-block size-[7px] shrink-0 rounded-full bg-amber align-middle", className)} />;
}
