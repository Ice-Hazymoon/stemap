import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Glob } from "./glob";
import { sourceRoots, walkFiles } from "./walk";
import type { LoadedMap } from "./map";

/** Module layout and file sizes for one commit: the map's modules when it has any, else the source folders. */
export interface SeedNode { id: string; parent: string | null; title?: string; titleZh?: string; note?: string; paths: string[]; fileCount: number; lines: number }
export interface SeedEdge { from: string; to: string; kind: string; note: string; evidence: { path: string; contains: string }[] }
export interface Seed {
  commit: string;
  groups: { title: string; titleZh?: string; modules: string[] }[];
  nodes: SeedNode[];
  edges: SeedEdge[];
  files: Record<string, { lines: number; commits90d: number }>;
}
type RawNode = { id: string; parent?: string; title?: string; titleZh?: string; note?: string; paths: string[] };
type Layout = { nodes: RawNode[]; groups: Seed["groups"] };

function mapLayout(map: LoadedMap): Layout {
  const nodes: RawNode[] = [];
  for (const { doc } of map.modules) {
    nodes.push({ id: doc.id, title: doc.title, titleZh: doc.titleZh, note: doc.note, paths: doc.paths });
    for (const c of doc.children) nodes.push({ id: c.id, parent: doc.id, title: c.title, titleZh: c.titleZh, note: c.note, paths: c.paths });
  }
  const listed = new Set(map.system?.groups.flatMap((g) => g.modules));
  const rest = map.modules.map((m) => m.doc.id).filter((id) => !listed.has(id));
  const groups = (map.system?.groups ?? []).map((g) => ({ title: g.title, titleZh: g.titleZh, modules: g.modules }));
  return { nodes, groups: rest.length ? [...groups, { title: "Modules", modules: rest }] : groups };
}

const CONTAINERS = new Set(["packages", "apps", "libs", "services", "modules", "src"]);
const idOf = (s: string) => s.replace(/[^\w-]+/g, "-");

/** Without modules in the map, a module is a top-level source folder; a container such as `packages` yields its children. */
export function folderLayout(root: string, include: string[]): Layout {
  const hasCode = (dir: string) => { const out: string[] = []; walkFiles(root, dir, out); return out.length > 0; };
  const nodes: RawNode[] = [];
  const groups = new Map<string, string[]>();
  const used = new Set<string>();
  const add = (group: string, name: string, paths: string[]) => {
    let id = idOf(name);
    if (used.has(id)) id = idOf(`${group}-${name}`);
    used.add(id);
    nodes.push({ id, paths });
    groups.set(group, [...(groups.get(group) ?? []), id]);
  };
  for (const top of sourceRoots(root, include)) {
    const kids = CONTAINERS.has(top)
      ? readdirSync(join(root, top), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && hasCode(`${top}/${e.name}`)).map((e) => e.name)
      : [];
    if (kids.length < 2) { add("Modules", top, [`${top}/**`]); continue; }
    for (const k of kids) add(top, k, [`${top}/${k}/**`]);
    // Files directly in the container belong to no child, so they get a module of their own.
    if (readdirSync(join(root, top), { withFileTypes: true }).some((e) => e.isFile())) add(top, top, [`${top}/*`]);
  }
  return { nodes, groups: [...groups].map(([title, modules]) => ({ title, modules })) };
}

async function churn(repo: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  let out = "";
  try { out = (await promisify(execFile)("git", ["-C", repo, "-c", "core.quotepath=off", "log", "--since=90.days", "--name-only", "--format="], { maxBuffer: 1 << 29 })).stdout; } catch { /* history is optional */ }
  for (const f of out.split("\n")) if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  return counts;
}

export async function buildSeed(input: { repo: string; root: string; commit: string; map: LoadedMap; files: string[] }): Promise<Seed> {
  const { repo, root, commit, map, files: all } = input;
  const { nodes: rawNodes, groups } = map.modules.length ? mapLayout(map) : folderLayout(root, map.config.include);
  const hot = await churn(repo);
  const files: Seed["files"] = {};
  const nodes: SeedNode[] = rawNodes.map((n) => {
    const globs = n.paths.map((p) => new Glob(p));
    const hits = all.filter((f) => globs.some((g) => g.match(f)));
    let lines = 0;
    for (const f of hits) {
      if (!files[f]) {
        let count = 0;
        try { count = readFileSync(join(root, f), "utf8").split("\n").length; } catch { /* binary or excluded */ }
        files[f] = { lines: count, commits90d: hot.get(f) ?? 0 };
      }
      lines += files[f]!.lines;
    }
    return { id: n.id, parent: n.parent ?? null, title: n.title, titleZh: n.titleZh, note: n.note, paths: n.paths, fileCount: hits.length, lines };
  });
  return { commit, groups, nodes, edges: [], files };
}

/** A file belongs to the most specific module that lists it. */
export function fileModules(seed: Seed) {
  const list = seed.nodes.map((n) => ({ id: n.id, depth: n.parent ? 1 : 0, globs: n.paths.map((p) => new Glob(p)) }));
  return (file: string) => {
    let best: { id: string; depth: number } | null = null;
    for (const n of list) if ((!best || n.depth > best.depth) && n.globs.some((g) => g.match(file))) best = n;
    return best?.id ?? null;
  };
}
