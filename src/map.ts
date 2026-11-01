import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { homeOf } from "./repo";
import { GlossaryDoc, JourneyDoc, ModuleDoc, SystemDoc, flowClaims, moduleClaims, systemClaims, termClaims, type ClaimRef, type Term } from "./schema";
import type { Tree } from "./tree";

/**
 * The map on disk: plain text that travels with the code. Facts the index can compute are never
 * stored here. Only judgments live in it: intent, boundaries, invariants and flows.
 */
export const Config = z.object({
  version: z.literal(1).default(1),
  name: z.string().optional(),
  /** Content languages. `en` is always written; `zh` makes the Chinese fields required. */
  languages: z.array(z.enum(["en", "zh"])).default(["en"]),
  /** Folders to index. Empty means every top-level folder with source code. */
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  /** The branch `stemap check` compares with when no --base is given. */
  base: z.string().default("main"),
  /** Check claims with an ASD-STE100 checker when one is installed. */
  ste: z.boolean().default(false),
}).strict();
export type Config = z.infer<typeof Config>;

export interface MapSource { read(rel: string): string | null; list(rel: string): string[] }

export const LOCK = "stemap.lock";
export const REPO_DIR = ".stemap";

/** The map lives in the repo; a repo that cannot take one keeps it in the local data folder. */
export function mapDir(repo: string): string {
  const inside = join(repo, REPO_DIR);
  if (existsSync(inside)) return inside;
  const local = join(homeOf(repo), "map");
  return existsSync(local) ? local : inside;
}

export const hasMap = (repo: string) => existsSync(join(mapDir(repo), "config.yaml"));

export const dirSource = (dir: string): MapSource => ({
  read: (rel) => { const f = join(dir, rel); return existsSync(f) && statSync(f).isFile() ? readFileSync(f, "utf8") : null; },
  list: (rel) => { const d = join(dir, rel); return existsSync(d) ? readdirSync(d).sort() : []; },
});

export const treeSource = (tree: Tree, prefix = REPO_DIR): MapSource => {
  const paths = tree.list().filter((p) => p.startsWith(`${prefix}/`));
  return {
    read: (rel) => tree.read(`${prefix}/${rel}`),
    list: (rel) => paths.filter((p) => dirname(p) === join(prefix, rel)).map((p) => p.slice(p.lastIndexOf("/") + 1)).sort(),
  };
};

export interface Doc<T> { file: string; doc: T }
export interface LoadedMap {
  config: Config;
  system: SystemDoc | null;
  glossary: Term[];
  modules: Doc<ModuleDoc>[];
  flows: Doc<JourneyDoc>[];
  /** A broken file is reported, never thrown: one bad merge must not hide the rest of the map. */
  errors: { file: string; message: string }[];
}

export const parseDocText = (file: string, text: string): unknown => (file.endsWith(".json") ? JSON.parse(text) : parseYaml(text));

export function loadMap(src: MapSource): LoadedMap {
  const errors: LoadedMap["errors"] = [];
  const one = <S extends z.ZodType>(schema: S, file: string): z.output<S> | null => {
    const text = src.read(file);
    if (text === null) return null;
    try {
      const r = schema.safeParse(parseDocText(file, text) ?? {});
      if (r.success) return r.data;
      errors.push({ file, message: r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    } catch (e) { errors.push({ file, message: String(e instanceof Error ? e.message : e) }); }
    return null;
  };
  const many = <S extends z.ZodType>(schema: S, dir: string) => src.list(dir).filter((f) => /\.ya?ml$/.test(f)).flatMap((f) => {
    const file = `${dir}/${f}`;
    const doc = one(schema, file);
    return doc ? [{ file, doc }] : [];
  });
  return {
    config: one(Config, "config.yaml") ?? Config.parse({}),
    system: one(SystemDoc, "system.yaml"),
    glossary: one(GlossaryDoc, "glossary.yaml")?.terms ?? [],
    modules: many(ModuleDoc, "modules"),
    flows: many(JourneyDoc, "flows"),
    errors,
  };
}

export interface MapClaim extends ClaimRef { file: string }

/** Every claim in the map, in a stable order. */
export function mapClaims(m: LoadedMap): MapClaim[] {
  const out: MapClaim[] = [];
  const add = (file: string, list: ClaimRef[]) => { for (const c of list) out.push({ ...c, file }); };
  if (m.system) add("system.yaml", systemClaims(m.system));
  add("glossary.yaml", termClaims(m.glossary));
  for (const d of m.modules) add(d.file, [...moduleClaims(d.doc), ...termClaims(d.doc.terms)]);
  for (const d of m.flows) add(d.file, flowClaims(d.doc));
  // One sentence can appear twice in a document with different evidence; each copy needs its own lock line.
  const seen = new Map<string, number>();
  return out.map((c) => {
    const n = (seen.get(c.id) ?? 0) + 1;
    seen.set(c.id, n);
    return n > 1 ? { ...c, id: `${c.id}-${n}` } : c;
  });
}

export function docClaims(file: string, m: LoadedMap): MapClaim[] {
  return mapClaims(m).filter((c) => c.file === file);
}

/** Long quotes stay on one line, so one changed line in a map reads as one changed line in a PR. */
export const toYaml = (doc: unknown) => stringifyYaml(doc, { lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" });

export function saveText(dir: string, file: string, text: string) {
  const full = join(dir, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

export const relativeToMap = (dir: string, file: string) => relative(dir, file).split("\\").join("/");
