import type { Atlas, ViewNode } from "@/lib/api";

export function ancestors(atlas: Atlas, id: string): ViewNode[] {
  const out: ViewNode[] = [];
  for (let n = atlas.nodes[id]; n; n = n.parent ? atlas.nodes[n.parent] : undefined) out.unshift(n);
  return out;
}
