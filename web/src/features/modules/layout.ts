import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { Atlas, ViewNode } from "@/lib/api";

const elk = new ELK();
// One line per box: a domain reads as a short list at full size, not as a scaled-down grid.
const SIZE = { module: { width: 212, height: 30 }, capability: { width: 196, height: 30 } };
const packing = (top: number) => ({
  "elk.algorithm": "rectpacking",
  "elk.padding": `[top=${top},left=6,bottom=6,right=6]`,
  "elk.spacing.nodeNode": "2",
  "elk.aspectRatio": "0.2",
});

export interface Placed {
  id: string; parent?: string; x: number; y: number; width: number; height: number;
  node: ViewNode; open: boolean;
}

function toElk(atlas: Atlas, id: string, expanded: Set<string>, lines: boolean): ElkNode {
  const n = atlas.nodes[id]!;
  const open = n.kind === "domain" || (expanded.has(id) && n.children.length > 0);
  if (!open) return { id, ...(n.kind === "module" ? SIZE.module : SIZE.capability) };
  // A domain's one-liner is written in English, so a Chinese reader's header has no second line to leave room for.
  const top = n.kind !== "domain" ? 32 : lines && n.oneLine ? 58 : 36;
  return { id, layoutOptions: packing(top), children: n.children.filter((c) => atlas.nodes[c]).map((c) => toElk(atlas, c, expanded, lines)) };
}

/** The tree is packed, not ranked: 263 relations would turn a layered layout into a hairball. */
export async function layoutTree(atlas: Atlas, focus: string, expanded: Set<string>, ratio: number, lines: boolean): Promise<Placed[]> {
  const root = atlas.nodes[focus]!;
  const open = new Set(expanded).add(focus);
  const graph: ElkNode = {
    id: "__root",
    layoutOptions: { ...packing(10), "elk.padding": "[top=12,left=12,bottom=12,right=12]", "elk.aspectRatio": ratio.toFixed(2), "elk.spacing.nodeNode": "10" },
    children: root.kind === "system" ? root.children.map((c) => toElk(atlas, c, expanded, lines)) : [toElk(atlas, focus, open, lines)],
  };
  const done = await elk.layout(graph);
  const out: Placed[] = [];
  const walk = (e: ElkNode, parent?: string) => {
    for (const c of e.children ?? []) {
      const node = atlas.nodes[c.id]!;
      out.push({ id: c.id, parent, x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 0, height: c.height ?? 0, node, open: !!c.children?.length });
      walk(c, c.id);
    }
  };
  walk(done);
  return out;
}
