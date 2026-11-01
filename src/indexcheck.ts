import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeIndex } from "./codeindex";

const FLOOR = 0.95;

/**
 * Self-check after each rebuild, using a different method from the parser: plain text. A callee name
 * must appear in the caller's lines, and a grep for table writes must land on an indexed operation.
 */
export function checkIndex(ix: CodeIndex, root: string) {
  const cache = new Map<string, string[]>();
  const lines = (f: string) => cache.get(f) ?? cache.set(f, readFileSync(join(root, f), "utf8").split("\n")).get(f)!;
  const edges: [number, number][] = [];
  ix.calls.forEach((cs, a) => cs.forEach((b) => edges.push([a, b])));
  // A fixed seed keeps two runs on one commit comparable.
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let sampled = 0, found = 0;
  for (let i = 0; i < 3000 && edges.length; i++) {
    const [a, b] = edges[Math.floor(next() * edges.length)]!;
    const from = ix.fns[a]!, to = ix.fns[b]!;
    if (to.name === "<module>" || to.name === "default") continue;
    sampled++;
    const body = from.name === "<module>" ? lines(from.file) : lines(from.file).slice(from.line - 1, from.end);
    if (body.join("\n").includes(to.name)) found++;
  }
  const indexed = new Set(ix.tableOps.filter((o) => o.op !== "read").map((o) => `${ix.fns[o.fn]!.file}:${o.line}`));
  let writes = 0, hit = 0;
  for (const f of Object.keys(ix.files)) {
    if (!f.startsWith("server/")) continue;
    lines(f).forEach((l, i) => {
      if (!/\.(insert|update|delete)\(tables\.\w+\)/.test(l) || /^\s*(\*|\/\/)/.test(l)) return;
      writes++;
      if (indexed.has(`${f}:${i + 1}`)) hit++;
    });
  }
  // A repo with no sampled calls or no table writes has nothing to miss, so that rate is 1.
  const precision = sampled ? found / sampled : 1, recall = writes ? hit / writes : 1;
  return { sampled, precision, writes, recall, ok: precision >= FLOOR && recall >= FLOOR };
}
