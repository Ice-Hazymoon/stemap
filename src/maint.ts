import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { align, anchorKey, anchorsOf, claimFingerprint, entryFor, type AlignReport, type Drift } from "./align";
import type { CodeIndex } from "./codeindex";
import { Glob } from "./glob";
import { gate, type GateReport } from "./gate";
import { readLock, writeLock, type LockEntry } from "./lock";
import { dirSource, docClaims, loadMap, mapClaims, mapDir, parseDocText, REPO_DIR, saveText, toYaml, type LoadedMap, type MapClaim } from "./map";
import { homeOf } from "./repo";
import { GlossaryDoc, JourneyDoc, ModuleDoc, SystemDoc, type Term } from "./schema";
import { topSymbols, type Locator } from "./symbols";
import { gitTree, workTree, type Tree } from "./tree";

/** A hint: code one or two calls below a claim changed, while the claim's own code did not. */
export interface Hint { claim: MapClaim; symbol: string; via: string }

export interface Workspace { repo: string; dir: string; map: LoadedMap; lock: Map<string, LockEntry[]>; tree: Tree }

export function open(repo: string): Workspace {
  const dir = mapDir(repo);
  if (!existsSync(join(dir, "config.yaml"))) throw new Error(`no map in ${repo}; run \`stemap init\` first`);
  return { repo, dir, map: loadMap(dirSource(dir)), lock: readLock(dir), tree: workTree(repo) };
}

const git = (repo: string, args: string[]) => {
  try { return execFileSync("git", ["-C", repo, "-c", "core.quotepath=off", ...args], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
};

/** Where this branch left the base, or null when the base is not here, as in a shallow clone. */
export function findBase(repo: string, base: string): string | null {
  return git(repo, ["merge-base", "HEAD", base]) || git(repo, ["merge-base", "HEAD", `origin/${base}`]) || null;
}

/** For advice only: with no base in reach, compare with HEAD and give fewer hints. */
export const baseOf = (repo: string, base: string) => findBase(repo, base) ?? "HEAD";

const ACTION: Record<Drift["state"], string> = {
  changed: "reread it; if it still holds: stemap confirm <id> -m \"why\"; if not, fix the claim and stemap write <file>",
  lost: "the quoted line is gone; fix evidence in the file, then stemap write <file>",
  unlocked: "stemap write <file>",
  edited: "stemap write <file>",
};

export function changedFiles(repo: string, base: string): string[] {
  const out = [git(repo, ["diff", "--name-only", "--no-renames", base]), git(repo, ["ls-files", "-o", "--exclude-standard"])];
  return [...new Set(out.flatMap((s) => (s ?? "").split("\n")).filter(Boolean))];
}

/**
 * Claims whose functions call changed code within two hops. The call graph comes from the last
 * saved index, which may lag: a hint is advice, and the hash comparison is what blocks.
 */
export function hints(w: Workspace, report: AlignReport, base: string, index: CodeIndex | null): Hint[] {
  if (!index) return [];
  const baseTree = gitTree(w.repo, base);
  const changed = new Set<string>();
  for (const f of changedFiles(w.repo, base)) {
    const now = w.tree.read(f), before = baseTree.read(f);
    if (now === null || before === null) continue;
    const a = topSymbols(f, before), b = topSymbols(f, now);
    for (const [name, h] of b) if (a.has(name) && a.get(name) !== h) changed.add(`${f}#${name}`);
  }
  if (!changed.size) return [];
  const callers: number[][] = index.fns.map(() => []);
  index.calls.forEach((cs, a) => cs.forEach((b) => callers[b]!.push(a)));
  const up = new Map<number, string>();
  for (const f of index.fns) {
    const key = `${f.file}#${f.name}`;
    if (!changed.has(key)) continue;
    let frontier = [f.id];
    for (let hop = 0; hop < 2; hop++) {
      frontier = frontier.flatMap((id) => callers[id]!).filter((id) => !up.has(id) && (up.set(id, key), true));
    }
  }
  const byName = new Map(index.fns.map((f) => [`${f.file}#${f.name}`, f.id]));
  const blocked = new Set(report.drift.map((d) => d.claim.id));
  const cache = new Map<string, Locator>();
  const out: Hint[] = [];
  for (const c of mapClaims(w.map)) {
    if (blocked.has(c.id)) continue;
    for (const a of anchorsOf(w.tree, c, cache)) {
      const top = a.located?.symbol.split(".")[0];
      const id = top ? byName.get(`${a.path}#${top}`) : undefined;
      const via = id === undefined ? undefined : up.get(id);
      if (via) { out.push({ claim: c, symbol: anchorKey(a), via }); break; }
    }
  }
  return out;
}

const loadIndex = (repo: string): CodeIndex | null => {
  const f = join(homeOf(repo), "index.json");
  try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) as CodeIndex : null; } catch { return null; }
};

export interface StatusReport { checked: number; drift: Drift[]; hints: Hint[]; errors: LoadedMap["errors"]; docs: string }

export function status(w: Workspace, opts: { files?: string[]; hints?: boolean } = {}): StatusReport {
  const report = align(w.tree, mapClaims(w.map), w.lock);
  const only = opts.files?.length ? new Set(opts.files) : null;
  // A path may be cited code or a map document: the reader touched either one.
  const drift = only ? report.drift.filter((d) => only.has(`${REPO_DIR}/${d.claim.file}`) || d.anchors.some((a) => only.has(a.path))) : report.drift;
  const list = opts.hints === false ? [] : hints(w, report, baseOf(w.repo, w.map.config.base), loadIndex(w.repo));
  // Messages name documents by a path that opens from the repository root, not from inside the map.
  const docs = w.dir === join(w.repo, REPO_DIR) ? REPO_DIR : w.dir;
  return { checked: report.checked, drift, hints: only ? list.filter((h) => only.has(h.via.split("#")[0]!)) : list, errors: w.map.errors, docs };
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One block per claim: what moved and the exact next command, so the reader never has to look it up. */
export function renderStatus(r: StatusReport, limit = 40): string {
  const out: string[] = [];
  for (const e of r.errors) out.push(`broken   ${r.docs}/${e.file}\n         ${e.message}`);
  for (const d of r.drift.slice(0, limit)) {
    const what = d.changed.length ? d.changed.join(", ") : d.anchors.map((a) => a.path).join(", ");
    out.push(`${d.state.padEnd(8)} ${d.claim.id}\n         ${truncate(d.claim.claim.text, 110)}\n         ${what}\n         -> ${ACTION[d.state].replace("<id>", d.claim.id).replace("<file>", `${r.docs}/${d.claim.file}`)}`);
    for (const a of d.anchors) if (a.candidates.length) out.push(`         moved? ${a.candidates.join(", ")}`);
  }
  if (r.drift.length > limit) out.push(`...and ${r.drift.length - limit} more (--json lists all)`);
  if (r.hints.length) {
    out.push(`\n${r.hints.length} claim(s) call changed code; these do not block:`);
    for (const h of r.hints.slice(0, 8)) out.push(`  ${h.claim.id} -> ${h.via}`);
  }
  const blocking = r.drift.length + r.errors.length;
  out.push(blocking ? `\n${blocking} of ${r.checked} claims need attention.` : `All ${r.checked} claims match the code.`);
  return out.join("\n");
}

export function confirm(w: Workspace, ids: string[], reason: string) {
  const text = reason.trim();
  if (text.length < 15) throw new Error("A confirmation needs a reason: say in a sentence why the claim still holds after this change.");
  const claims = new Map(mapClaims(w.map).map((c) => [c.id, c]));
  const drift = new Map(align(w.tree, mapClaims(w.map), w.lock).drift.map((d) => [d.claim.id, d]));
  const done: string[] = [];
  for (const id of ids) {
    const c = claims.get(id);
    if (!c) throw new Error(`no claim ${id}`);
    const d = drift.get(id);
    if (!d) continue;
    if (d.state !== "changed") throw new Error(`${id} is ${d.state}: ${ACTION[d.state].replace("<file>", d.claim.file)}`);
    // CI reads a repeated reason as a lock line edited by hand, and it says nothing about this change anyway.
    if (w.lock.get(id)?.some((e) => e.reason === text)) throw new Error(`${id} already has this reason; say why the claim holds after this change.`);
    const entry = entryFor(c, d.anchors, text);
    if (!entry) throw new Error(`${id} has evidence that cannot be found`);
    w.lock.set(id, [entry]);
    done.push(id);
  }
  writeLock(w.dir, w.lock);
  return done;
}

const kindOf = (file: string, raw: Record<string, unknown>) => {
  if (Array.isArray(raw.steps)) return "flow";
  if (basename(file).startsWith("glossary")) return "glossary";
  if (basename(file).startsWith("system")) return "system";
  return "module";
};

export interface WriteResult { file: string; report: GateReport; saved: string | null }

/** The only way into the map: a document lands, and its claims lock, only after every gate passes. */
export async function write(w: Workspace, input: string): Promise<WriteResult> {
  // Status prints paths relative to the map, so those work here as well as paths from the working directory.
  const full = [resolve(input), join(w.dir, input)].find((f) => existsSync(f));
  if (!full) throw new Error(`no file ${input}`);
  return writeText(w, input, full, readFileSync(full, "utf8"));
}

/** `allow` narrows what a caller may touch; the document's own id, not its file name, decides where it lands. */
export async function writeText(w: Workspace, input: string, full: string, text: string, allow?: (file: string) => boolean): Promise<WriteResult> {
  const refuse = (rule: string, message: string): WriteResult => ({ file: input, saved: null, report: { ok: false, claims: 0, soft: [], hard: [{ key: "document", rule, severity: "hard", message }] } });
  let raw: Record<string, unknown>;
  try { raw = (parseDocText(full, text) ?? {}) as Record<string, unknown>; }
  catch (e) { return refuse("syntax", `${String(e instanceof Error ? e.message : e).split("\n\n")[0]} (quote any string that holds ": " or starts with a backtick)`); }
  const kind = kindOf(full, raw);
  const schema = kind === "flow" ? JourneyDoc : kind === "module" ? ModuleDoc : kind === "glossary" ? GlossaryDoc : SystemDoc;
  const checked = schema.safeParse(raw);
  if (!checked.success) return refuse("schema", checked.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "document"}: ${i.message}`).join("; "));
  const parsed = checked.data;
  // The id becomes a file name, so it can never climb out of the map.
  if ((kind === "flow" || kind === "module") && !/^[\w][\w-]*$/.test((parsed as { id: string }).id)) return refuse("id", `id must be letters, digits, _ and -: ${JSON.stringify((parsed as { id: string }).id)}`);
  const file = kind === "flow" ? `flows/${(parsed as JourneyDoc).id}.yaml` : kind === "module" ? `modules/${(parsed as ModuleDoc).id}.yaml` : `${kind}.yaml`;
  if (allow && !allow(file)) return refuse("scope", `this run may not write ${file}`);

  const next: LoadedMap = {
    ...w.map,
    flows: [...w.map.flows.filter((d) => d.file !== file), ...(kind === "flow" ? [{ file, doc: parsed as JourneyDoc }] : [])],
    modules: [...w.map.modules.filter((d) => d.file !== file), ...(kind === "module" ? [{ file, doc: parsed as ModuleDoc }] : [])],
    system: kind === "system" ? parsed as SystemDoc : w.map.system,
    glossary: kind === "glossary" ? (parsed as { terms: Term[] }).terms : w.map.glossary,
  };
  const claims = docClaims(file, next);
  const unchanged = (c: MapClaim) => w.lock.get(c.id)?.some((e) => e.fp === claimFingerprint(c));
  const fresh = claims.filter((c) => !unchanged(c));
  const terms = [...next.glossary, ...next.modules.flatMap((m) => m.doc.terms)];
  const report = await gate({ tree: w.tree, map: next, claims, fresh, flow: kind === "flow" ? parsed as JourneyDoc : undefined, terms });
  if (!report.ok) return { file, report, saved: null };

  saveText(w.dir, file, toYaml(parsed));
  const cache = new Map<string, Locator>();
  for (const c of fresh) {
    const entry = entryFor(c, anchorsOf(w.tree, c, cache), "");
    if (entry) w.lock.set(c.id, [entry]);
  }
  // A claim removed from the map takes its lock line with it, or the lock grows without bound.
  const live = new Set(mapClaims(next).map((c) => c.id));
  for (const id of w.lock.keys()) if (!live.has(id)) w.lock.delete(id);
  writeLock(w.dir, w.lock);
  w.map = next;
  return { file, report, saved: join(w.dir, file) };
}

/** A claim whose quote moved to exactly one other file follows it. The lock follows too, but only if the code around the quote is the same. */
export function reanchor(w: Workspace, apply: boolean) {
  const report = align(w.tree, mapClaims(w.map), w.lock);
  const moves: { id: string; from: string; to: string; contains: string }[] = [];
  const unresolved: string[] = [];
  for (const d of report.drift.filter((x) => x.state === "lost")) {
    const target = d.anchors.filter((a) => !a.located);
    if (target.some((a) => a.candidates.length !== 1)) { unresolved.push(d.claim.id); continue; }
    for (const a of target) moves.push({ id: d.claim.id, from: a.path, to: a.candidates[0]!, contains: a.contains });
  }
  if (!apply || !moves.length) return { moves, unresolved, relocked: 0 };

  const repoint = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.map(repoint).some(Boolean);
    if (!v || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    const mv = moves.find((m) => m.from === o.path && m.contains === o.contains);
    if (mv) { o.path = mv.to; return true; }
    return Object.values(o).map(repoint).some(Boolean);
  };
  for (const { file, doc } of [...w.map.flows, ...w.map.modules]) if (repoint(doc)) saveText(w.dir, file, toYaml(doc));
  if (w.map.system && repoint(w.map.system)) saveText(w.dir, "system.yaml", toYaml(w.map.system));
  if (repoint(w.map.glossary)) saveText(w.dir, "glossary.yaml", toYaml({ terms: w.map.glossary }));

  const moved = new Set(moves.map((m) => m.id));
  const cache = new Map<string, Locator>();
  const hashes = (e: LockEntry) => Object.values(e.anchors).sort().join();
  let relocked = 0;
  for (const c of mapClaims(w.map)) {
    if (!moved.has(c.id)) continue;
    const entry = entryFor(c, anchorsOf(w.tree, c, cache), w.lock.get(c.id)?.[0]?.reason ?? "");
    if (entry && w.lock.get(c.id)?.some((e) => hashes(e) === hashes(entry))) { w.lock.set(c.id, [entry]); relocked++; }
  }
  writeLock(w.dir, w.lock);
  return { moves, unresolved, relocked };
}

/** Everything a person or agent should know before editing this file, in about ten lines. */
export function context(w: Workspace, file: string): string | null {
  const rel = relative(w.repo, resolve(w.repo, file)).split("\\").join("/");
  const owner = w.map.modules.find((m) => m.doc.paths.some((p) => new Glob(p).match(rel)) || m.doc.children.some((c) => c.paths.some((p) => new Glob(p).match(rel))));
  const claims = mapClaims(w.map).filter((c) => c.claim.evidence.some((e) => e.path === rel));
  const flows = new Map<string, string[]>();
  for (const c of claims) {
    const [kind, flow, step] = c.id.split("/");
    if (kind === "flow") flows.set(flow!, [...(flows.get(flow!) ?? []), step!]);
  }
  if (!owner && !claims.length) return null;
  const out = [`stemap: ${rel}${owner ? ` is in module ${owner.doc.id}` : ""}.`];
  for (const c of (owner?.doc.cautions ?? []).slice(0, 3)) out.push(`Invariant: ${c.text}`);
  for (const [flow, steps] of [...flows].slice(0, 3)) out.push(`Flow ${flow} steps: ${steps.slice(0, 6).join(", ")}${steps.length > 6 ? ` and ${steps.length - 6} more` : ""}.`);
  if (claims.length) out.push(`${claims.length} claim(s) cite this file. After editing, run stemap status.`);
  return out.slice(0, 10).join("\n");
}

export function renderFlow(w: Workspace, id: string): string | null {
  const flow = w.map.flows.find((f) => f.doc.id === id)?.doc;
  if (!flow) return null;
  const out = [`${flow.title} (${flow.actor}): ${flow.goal}`];
  for (const s of flow.steps) {
    out.push(`${s.id} [${s.lane}/${s.kind}] ${s.text}`);
    for (const e of s.evidence) out.push(`  at ${e.path}`);
    for (const x of s.writes) out.push(`  writes ${x.target}: ${x.change}`);
    for (const n of s.next) out.push(`  -> ${n.to}${n.when ? ` when ${n.when}` : ""}${n.failure ? " (failure)" : ""}`);
  }
  return out.join("\n");
}

/** A fixed sample for an independent reader: confirmed claims first, since they are the ones nobody rewrote. */
export function reconcile(w: Workspace, size: number) {
  const cache = new Map<string, Locator>();
  const claims = mapClaims(w.map);
  const reason = (id: string) => w.lock.get(id)?.[0]?.reason ?? "";
  const ordered = [...claims.filter((c) => reason(c.id)), ...claims.filter((c) => !reason(c.id)).sort((a, b) => a.id.localeCompare(b.id))];
  const pick = ordered.slice(0, Math.min(size, ordered.length));
  return pick.map((c) => {
    const anchors = anchorsOf(w.tree, c, cache);
    return {
      id: c.id, file: c.file, text: c.claim.text, reason: reason(c.id),
      code: anchors.map((a) => {
        const lines = (w.tree.read(a.path) ?? "").split("\n");
        const l = a.located;
        return { at: anchorKey(a), lines: l ? lines.slice(l.line - 1, Math.min(l.end, l.line + 60)).join("\n") : null };
      }),
    };
  });
}
