import { existsSync, readdirSync } from "node:fs";
import { CODE_EXT } from "./symbols";
import { join } from "node:path";

export const SKIP_DIR = new Set(["node_modules", "dist", "build", "out", "coverage", "tests", "__tests__", ".nuxt", ".next", ".output", "_example", "test", "e2e"]);
export { CODE_EXT };
const isCode = (name: string) => CODE_EXT.some((x) => name.endsWith(x)) && !/\.(d|test|spec|stories)\.[a-z]+$/.test(name);

/** Collect source files under `dir` (relative to `base`); symlinks are skipped so a broken one cannot throw. */
export function walkFiles(base: string, dir: string, out: string[]) {
  for (const e of readdirSync(join(base, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) walkFiles(base, rel, out);
    } else if (e.isFile() && isCode(e.name)) out.push(rel);
  }
}

/** A map can name its source folders; otherwise every top-level folder that holds source code is one. */
export function sourceRoots(base: string, include: string[] = []): string[] {
  if (include.length) return include.filter((r) => existsSync(join(base, r)));
  const roots: string[] = [];
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIR.has(e.name)) continue;
    const files: string[] = [];
    walkFiles(base, e.name, files);
    if (files.length) roots.push(e.name);
  }
  return roots;
}
