import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeIndex } from "./codeindex";

/** Entry points ranked by the data they can change, which is a fair proxy for what a reader must understand first. */
export interface Candidate { kind: "page" | "route" | "queue" | "task"; label: string; file: string; tables: string[]; reach: number }

export function candidates(home: string): Candidate[] {
  const ix = JSON.parse(readFileSync(join(home, "index.json"), "utf8")) as CodeIndex;
  const writes = new Map<number, Set<string>>();
  for (const o of ix.tableOps) if (o.op !== "read") (writes.get(o.fn) ?? writes.set(o.fn, new Set()).get(o.fn)!).add(o.table);
  const walk = (start: number) => {
    const seen = new Set([start]);
    const tables = new Set<string>();
    let frontier = [start];
    for (let depth = 0; depth < 6 && frontier.length; depth++) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const t of writes.get(id) ?? []) tables.add(t);
        for (const c of ix.calls[id] ?? []) if (!seen.has(c)) { seen.add(c); next.push(c); }
      }
      frontier = next;
    }
    return { tables: [...tables].sort(), reach: seen.size };
  };
  const moduleOf = new Map(ix.fns.filter((f) => f.kind === "module").map((f) => [f.file, f.id]));
  const out: Candidate[] = [];
  for (const r of ix.routes) if (r.fn !== null) out.push({ kind: "route", label: `${r.method} ${r.path}`, file: r.file, ...walk(r.fn) });
  for (const p of ix.pages) { const id = moduleOf.get(p.file); if (id !== undefined) out.push({ kind: "page", label: p.path, file: p.file, ...walk(id) }); }
  for (const q of ix.queues) if (q.consumer !== null) out.push({ kind: "queue", label: q.name, file: q.file, ...walk(q.consumer) });
  for (const f of ix.fns) if (f.kind === "task") out.push({ kind: "task", label: f.name, file: f.file, ...walk(f.id) });
  return out.sort((a, b) => b.tables.length - a.tables.length || b.reach - a.reach);
}
