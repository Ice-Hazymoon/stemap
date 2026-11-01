import { appendFileSync } from "node:fs";
import { align, type Drift } from "./align";
import { compute, type Built } from "./flow";
import { Glob } from "./glob";
import { gate } from "./gate";
import { readLock, parseLock, type LockEntry } from "./lock";
import { dirSource, LOCK, loadMap, mapClaims, mapDir, REPO_DIR, treeSource, type LoadedMap } from "./map";
import { findBase, renderStatus } from "./maint";
import { gitTree, type Tree } from "./tree";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * The gate at the end of the road. It recomputes everything from the commit and trusts nothing a
 * branch brought with it. With a base, only what this change caused can fail: a map that was
 * already behind must not block unrelated work.
 */
export type Severity = "block" | "note";
export interface Finding { severity: Severity; kind: string; id: string; message: string; file?: string }
export interface CheckReport {
  base: string | null;
  head: string;
  checked: number;
  findings: Finding[];
  confirmations: { id: string; reason: string }[];
  /** Claims the base had and this commit does not, so a reviewer sees what left the map. */
  removed: string[];
  ok: boolean;
}

const gitSha = (repo: string, ref: string) => execFileSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const nowDrift = (d: Drift): Finding => ({
  severity: "block", kind: d.state, id: d.claim.id, file: `${REPO_DIR}/${d.claim.file}`,
  message: `${d.claim.claim.text} (${d.changed.join(", ") || d.anchors.map((a) => a.path).join(", ")})`,
});

function structure(head: Built, base: Built | null): Finding[] {
  const out: Finding[] = [];
  const s = head.atlas.support, b = base?.atlas.support;
  if (s) {
    // A step that lost its quote has no anchors, so its edges fail too; the lost claim already says so.
    const lost = new Set(head.atlas.drift.items.filter((d) => d.state === "lost").map((d) => d.id.split("/").slice(1).join("/")));
    for (const [k, ok] of Object.entries(s.edges)) {
      if (ok) continue;
      const [flow, step] = k.split("/");
      const [from, to] = (step ?? "").split(">");
      if (lost.has(`${flow}/${from}`) || lost.has(`${flow}/${to}`)) continue;
      // No base means no way to tell a new loss from an old gap, so it stays a note.
      const newly = b ? b.edges[k] === true : false;
      out.push({ severity: newly ? "block" : "note", kind: "edge", id: k, message: `The call graph no longer connects this flow edge: ${k}` });
    }
    for (const [k, v] of Object.entries(s.writes)) {
      if (v !== "none") continue;
      const was = b?.writes[k];
      const newly = was === "direct" || was === "reach";
      out.push({ severity: newly ? "block" : "note", kind: "write", id: k, message: `No call path from this step reaches the table it says it writes: ${k}` });
    }
  }
  if (!base) return out;

  const has = (m: LoadedMap) => m.modules.length > 0;
  const owned = (m: LoadedMap) => {
    const globs = m.modules.flatMap((d) => [...d.doc.paths, ...d.doc.children.flatMap((c) => c.paths)]).map((p) => new Glob(p));
    return (f: string) => globs.some((g) => g.match(f));
  };
  if (has(head.map)) {
    const isOwned = owned(head.map);
    const add = (kind: string, id: string, file: string) => { if (!isOwned(file)) out.push({ severity: "block", kind, id, file, message: `New ${kind} has no module: add its path to a module, or a new module` }); };
    const before = { routes: new Set(base.index.routes.map((r) => `${r.method} ${r.path}`)), tables: new Set(base.index.tables.map((t) => t.name)), queues: new Set(base.index.queues.map((q) => q.name)) };
    for (const r of head.index.routes) if (!before.routes.has(`${r.method} ${r.path}`)) add("route", `${r.method} ${r.path}`, r.file);
    for (const t of head.index.tables) if (!before.tables.has(t.name)) add("table", t.name, t.file);
    for (const q of head.index.queues) if (!before.queues.has(q.name)) add("queue", q.name, q.file);
  }

  // A new writer of a table some flow documents means that flow may be incomplete.
  const fnKey = (ix: Built["index"], o: Built["index"]["tableOps"][number]) => { const f = ix.fns[o.fn]!; return `${o.table}|${o.op}|${f.file}#${f.name}`; };
  const was = new Set(base.index.tableOps.filter((o) => o.op !== "read").map((o) => fnKey(base.index, o)));
  const documented = new Set(head.map.flows.flatMap((f) => f.doc.steps.flatMap((s) => s.writes.map((w) => w.target.split(".")[0]!))));
  const anchored = new Set(head.atlas.journeys.flatMap((j) => j.steps.flatMap((s) => s.claim.refs.map((r) => r.path))));
  const seen = new Set<string>();
  for (const o of head.index.tableOps) {
    if (o.op === "read") continue;
    const key = fnKey(head.index, o);
    if (was.has(key) || seen.has(key)) continue;
    seen.add(key);
    const f = head.index.fns[o.fn]!;
    const known = documented.has(o.table);
    if (known && anchored.has(f.file)) continue;
    out.push({ severity: known ? "block" : "note", kind: "new-write", id: key, file: f.file, message: `${f.name} now does ${o.op} on ${o.table}, and no flow step cites it` });
  }
  return out;
}

function confirmations(head: Map<string, LockEntry[]>, base: Map<string, LockEntry[]>) {
  const out: CheckReport["confirmations"] = [];
  for (const [id, entries] of head) {
    const was = new Set((base.get(id) ?? []).map((e) => e.reason));
    for (const e of entries) if (e.reason && !was.has(e.reason)) out.push({ id, reason: e.reason });
  }
  return out;
}

/** The same words on new hashes means the code moved and nobody said why. Only a lock edited by hand gets there. */
function unexplained(head: Map<string, LockEntry[]>, base: Map<string, LockEntry[]>): Finding[] {
  const out: Finding[] = [];
  const anchors = (e: LockEntry) => JSON.stringify(Object.entries(e.anchors).sort());
  for (const [id, entries] of head) {
    const before = base.get(id) ?? [];
    for (const e of entries) {
      const same = before.filter((b) => b.fp === e.fp);
      if (!same.length || same.some((b) => anchors(b) === anchors(e))) continue;
      if (e.reason && !same.some((b) => b.reason === e.reason)) continue;
      out.push({ severity: "block", kind: "lock", id, file: `${REPO_DIR}/${LOCK}`, message: "This lock line moved to new hashes with no new reason. Run `stemap confirm`; do not edit the lock." });
    }
  }
  return out;
}

async function regate(tree: Tree, head: LoadedMap, base: LoadedMap | null, headRead: (f: string) => string | null, baseRead: ((f: string) => string | null) | null): Promise<Finding[]> {
  const out: Finding[] = [];
  const claims = mapClaims(head);
  const terms = [...head.glossary, ...head.modules.flatMap((m) => m.doc.terms)];
  const docs = [...head.flows.map((f) => ({ file: f.file, flow: f.doc })), ...head.modules.map((m) => ({ file: m.file, flow: undefined }))];
  for (const d of docs) {
    // An unchanged document already passed; a changed one might have reached here with a hand-edited lock.
    if (base && baseRead && headRead(d.file) === baseRead(d.file)) continue;
    const own = claims.filter((c) => c.file === d.file);
    const r = await gate({ tree, map: head, claims: [], fresh: own, flow: d.flow, terms });
    for (const f of r.hard) out.push({ severity: "block", kind: `gate:${f.rule}`, id: `${d.file} ${f.key}`, file: `${REPO_DIR}/${d.file}`, message: f.message });
  }
  return out;
}

export async function check(repo: string, opts: { base?: string; index?: boolean }): Promise<CheckReport> {
  const dir = mapDir(repo);
  const inRepo = dir === join(repo, REPO_DIR);
  const head = gitTree(repo, "HEAD");
  const headSrc = inRepo ? treeSource(head) : dirSource(dir);
  const map = loadMap(headSrc);
  const lock = inRepo ? parseLock(head.read(`${REPO_DIR}/${LOCK}`) ?? "") : readLock(dir);
  const report = align(head, mapClaims(map), lock);
  const findings: Finding[] = map.errors.map((e) => ({ severity: "block", kind: "broken", id: e.file, file: `${REPO_DIR}/${e.file}`, message: e.message }));

  const headSha = gitSha(repo, "HEAD");
  const found = opts.base ? findBase(repo, opts.base) : null;
  // Dropping to a weaker check without saying so would read as a pass.
  if (opts.base && !found) throw new Error(`cannot find base ${opts.base}. Fetch it (in CI: fetch-depth: 0), pass --base <branch>, or use --all.`);
  // On the base branch itself there is nothing to compare with, and comparing with itself would excuse everything.
  const baseRef = found && found !== headSha ? found : null;
  const baseTree = baseRef ? gitTree(repo, baseRef) : null;
  // A base from before the map existed has nothing to compare with, which counts as no map at all.
  const baseHasMap = Boolean(baseTree && inRepo && baseTree.read(`${REPO_DIR}/config.yaml`) !== null);
  const baseSrc = baseHasMap ? treeSource(baseTree!) : null;
  const baseMap = baseSrc ? loadMap(baseSrc) : null;
  const baseLock = baseHasMap ? parseLock(baseTree!.read(`${REPO_DIR}/${LOCK}`) ?? "") : new Map<string, LockEntry[]>();
  // The hashes are part of the key: a claim already behind at the base must still fail if this change moves its code again.
  const driftKey = (d: Drift) => `${d.claim.id}|${d.state}|${d.anchors.map((a) => a.located?.hash ?? a.path).join()}`;
  const baseDrift = baseMap ? new Set(align(baseTree!, mapClaims(baseMap), baseLock).drift.map(driftKey)) : null;

  if (inRepo && head.read(`${REPO_DIR}/config.yaml`) === null) {
    findings.push({ severity: baseHasMap ? "block" : "note", kind: "no-map", id: REPO_DIR, message: baseHasMap ? "This change removes the map." : "No map at this commit. Commit .stemap to check it." });
  }
  if (baseMap) findings.push(...unexplained(lock, baseLock));
  for (const d of report.drift) {
    const old = baseDrift?.has(driftKey(d));
    findings.push({ ...nowDrift(d), severity: old ? "note" : "block" });
  }
  findings.push(...await regate(head, map, baseMap, headSrc.read, baseSrc?.read ?? null));

  if (opts.index !== false) {
    const headBuilt = await compute(repo);
    const baseBuilt = baseTree ? await compute(repo, baseRef!) : null;
    findings.push(...structure(headBuilt, baseBuilt));
  }
  const blocked = findings.some((f) => f.severity === "block");
  const live = new Set(mapClaims(map).map((c) => c.id));
  const removed = baseMap ? mapClaims(baseMap).map((c) => c.id).filter((id) => !live.has(id)) : [];
  return { base: baseRef, head: head.label, checked: report.checked, findings, confirmations: confirmations(lock, baseLock), removed, ok: !blocked };
}

const FIX: Record<string, string> = {
  changed: "Reread the claim, then fix it with `stemap write`, or keep it with `stemap confirm`.",
  lost: "The quoted line is gone. Fix the evidence, then run `stemap write`.",
  unlocked: "Run `stemap write` on the file.",
  edited: "Run `stemap write` on the file.",
};

export function renderText(r: CheckReport): string {
  const blocks = r.findings.filter((f) => f.severity === "block"), notes = r.findings.filter((f) => f.severity === "note");
  const out: string[] = [];
  for (const f of blocks) out.push(`block  ${f.kind.padEnd(10)} ${f.id}\n       ${f.message}${FIX[f.kind] ? `\n       ${FIX[f.kind]}` : ""}`);
  for (const f of notes) if (f.kind === "no-map") out.push(`note   ${f.message}`);
  if (notes.length) out.push(`${notes.length} note(s) that do not block; --json lists them.`);
  out.push(r.ok ? `PASS: ${r.checked} claims${r.base ? ` compared with ${r.base.slice(0, 9)}` : ""}.` : `FAIL: ${blocks.length} finding(s) caused by this change.`);
  return out.join("\n");
}

/** Annotations land on the changed map file; the summary is what a reviewer reads on the PR. */
export function renderGithub(r: CheckReport): string {
  const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return r.findings.filter((f) => f.severity === "block").map((f) => `::error file=${f.file ?? ""},title=stemap ${f.kind}::${esc(`${f.id}: ${f.message}`)}`).join("\n");
}

export function renderSummary(r: CheckReport): string {
  const blocks = r.findings.filter((f) => f.severity === "block");
  const out = [`## stemap: ${r.ok ? "map matches the code" : `${blocks.length} finding(s)`}`, "", `${r.checked} claims checked${r.base ? ` against \`${r.base.slice(0, 9)}\`` : ""}.`];
  if (blocks.length) out.push("", "| Finding | Claim | Detail |", "| --- | --- | --- |", ...blocks.map((f) => `| ${f.kind} | \`${f.id}\` | ${f.message.replaceAll("|", "\\|")} |`));
  if (r.confirmations.length) out.push("", "### Confirmed without rewording", "", "Code under these claims changed and the author kept the words. Check the reasons.", "", "| Claim | Reason |", "| --- | --- |", ...r.confirmations.map((c) => `| \`${c.id}\` | ${c.reason.replaceAll("|", "\\|")} |`));
  if (r.removed.length) out.push("", `### Removed from the map (${r.removed.length})`, "", ...r.removed.slice(0, 30).map((id) => `- \`${id}\``));
  return out.join("\n");
}

export function writeSummary(md: string) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}

export { renderStatus };
