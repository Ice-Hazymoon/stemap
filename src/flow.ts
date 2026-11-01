import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { align } from "./align";
import { ATLAS_FORMAT, buildAtlas, type Atlas } from "./bundle";
import { buildIndex, type CodeIndex } from "./codeindex";
import { readLock } from "./lock";
import { dirSource, loadMap, mapClaims, mapDir, treeSource, type LoadedMap } from "./map";
import { homeOf } from "./repo";
import { buildSeed, fileModules, type Seed } from "./seed";
import { currentSha, ensureSnapshot, headSha } from "./snapshot";
import { compileSite, isStamped, siteDir } from "./site";
import { gitTree, type Tree } from "./tree";
import { VERSION } from "./version";
import { CODE_EXT, SKIP_DIR } from "./walk";

const git = (repo: string, args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "ignore"] });

/** Framework and size come from the committed tree, never from the working tree. */
export function describeRepo(repo: string): { framework: string; files: number } {
  headSha(repo);
  const names = git(repo, ["-c", "core.quotepath=off", "ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  const files = names.filter((f) => CODE_EXT.some((x) => f.endsWith(x)) && !f.split("/").some((p) => SKIP_DIR.has(p))).length;
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(git(repo, ["show", "HEAD:package.json"])) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    deps = { ...pkg.devDependencies, ...pkg.dependencies };
  } catch { /* no package.json at the root */ }
  const known: [string, string][] = [["nuxt", "Nuxt"], ["next", "Next.js"], ["@remix-run/react", "Remix"], ["astro", "Astro"], ["@sveltejs/kit", "SvelteKit"], ["vue", "Vue"], ["react", "React"], ["hono", "Hono"], ["express", "Express"], ["typescript", "TypeScript"]];
  return { framework: known.find(([d]) => d in deps)?.[1] ?? (names.some((f) => f.endsWith(".ts")) ? "TypeScript" : "JavaScript"), files };
}

const newest = (dir: string): number => {
  if (!existsSync(dir)) return 0;
  return Math.max(statSync(dir).mtimeMs, ...readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs)));
};

/** The atlas is current when it was written after HEAD moved and after the last change to the map. */
export function upToDate(repo: string): boolean {
  const home = homeOf(repo);
  const cur = join(home, "CURRENT"), atlas = join(home, "atlas.json");
  if (currentSha(home) !== headSha(repo) || !existsSync(atlas)) return false;
  const at = statSync(atlas).mtimeMs;
  if (at < statSync(cur).mtimeMs || at < newest(mapDir(repo))) return false;
  // A new version of the tool may index the same commit differently.
  try { const a = JSON.parse(readFileSync(atlas, "utf8")) as Atlas; return a.format === ATLAS_FORMAT && a.tool === VERSION; } catch { return false; }
}

export function freePort(from: number, host: string): Promise<number> {
  const free = (port: number) => new Promise<boolean>((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, host, () => probe.close(() => done(true)));
  });
  return (async () => { for (let p = from; p < from + 200; p++) if (await free(p)) return p; throw new Error(`no free port from ${from}`); })();
}

export type RunStep = <T>(label: string, run: () => Promise<T> | T) => Promise<T>;
const plain: RunStep = async (_, run) => run();

export interface Built { commit: string; root: string; tree: Tree; map: LoadedMap; seed: Seed; index: CodeIndex; atlas: Atlas }

/**
 * Everything for one commit, with no side effect but the snapshot: a commit other than the served
 * one can be measured without touching what the viewer shows. The map comes from the working tree
 * for HEAD, because a map being written is not committed yet, and from the commit for any other ref.
 */
export async function compute(repo: string, ref = "HEAD", step: RunStep = plain): Promise<Built> {
  const head = ref === "HEAD";
  const snap = await step("Snapshot", () => ensureSnapshot(repo, ref, head));
  const tree = gitTree(repo, snap.sha);
  const dir = mapDir(repo);
  const inRepo = dir === join(repo, ".stemap");
  const map = loadMap(head || !inRepo ? dirSource(dir) : treeSource(tree));
  const lock = head || !inRepo ? readLock(dir) : new Map();
  const seed = await step("Modules", () => buildSeed({ repo, root: snap.dir, commit: snap.sha, map, files: tree.list() }));
  const index = await step("Index", () => buildIndex({ root: snap.dir, commit: snap.sha, repo, include: map.config.include, moduleOf: fileModules(seed) }));
  const atlas = await step("Bundle", () => buildAtlas({ repo, commit: snap.sha, tree, map, seed, index, aligned: align(tree, mapClaims(map), lock) }));
  return { commit: snap.sha, root: snap.dir, tree, map, seed, index, atlas };
}

/** Save one commit's results where the query commands read them. */
export async function build(repo: string, step: RunStep = plain): Promise<Built> {
  const b = await compute(repo, "HEAD", step);
  const home = homeOf(repo);
  writeFileSync(join(home, "seed.json"), JSON.stringify(b.seed));
  writeFileSync(join(home, "index.json"), JSON.stringify(b.index));
  writeFileSync(join(home, "atlas.json"), JSON.stringify(b.atlas));
  return b;
}

/** The compiled page for HEAD: rebuilt only when the commit, the map or the tool changed. */
export async function page(repo: string, step: RunStep = plain) {
  const dir = siteDir(homeOf(repo));
  const entry = join(dir, "index.html");
  const current = upToDate(repo) && existsSync(entry) && statSync(entry).mtimeMs >= statSync(join(homeOf(repo), "atlas.json")).mtimeMs && isStamped(readFileSync(entry, "utf8"));
  if (current) return { entry, built: null };
  const b = await build(repo, step);
  await step("Page", () => compileSite(b, repo, dir));
  return { entry, built: b };
}

export async function ensureTarget(repo: string): Promise<{ home: string; root: string }> {
  if (!upToDate(repo)) await build(repo, async (_, run) => run());
  const home = homeOf(repo);
  return { home, root: join(home, currentSha(home) ?? "") };
}
