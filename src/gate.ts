import { resolveEvidence } from "./evidence";
import { checkSte, steInstalled, type Fault } from "./ste";
import type { LoadedMap, MapClaim } from "./map";
import type { JourneyDoc, Term } from "./schema";
import type { Tree } from "./tree";

export interface GateReport { ok: boolean; claims: number; hard: Fault[]; soft: Fault[] }

function checkEvidence(tree: Tree, claims: MapClaim[]): Fault[] {
  const out: Fault[] = [];
  for (const c of claims) for (const e of c.claim.evidence) {
    const r = resolveEvidence(tree, e);
    if (!r.ok) out.push({ key: c.key, rule: "evidence", severity: "hard", message: r.reason });
  }
  return out;
}

/** A stripped claim must stay one sentence; several sentences hide which one the evidence backs. */
const sentenceCount = (t: string) => (t.replace(/`[^`]*`/g, "X").match(/[.!?](\s|$)/g) ?? []).length;

/** A code span is exempt from the word list only if it is really code in the cited files. */
function checkClaimShape(tree: Tree, claims: MapClaim[]): Fault[] {
  const out: Fault[] = [];
  for (const c of claims) {
    if (sentenceCount(c.claim.text) > 1) out.push({ key: c.key, rule: "one-sentence", severity: "hard", message: "A claim must be one sentence" });
    const cited = c.claim.evidence.map((e) => tree.read(e.path) ?? "").join("\n");
    for (const m of c.claim.text.matchAll(/`([^`]+)`/g)) {
      const span = m[1]!.split(/[<(]/)[0]!.trim();
      if (span && !cited.includes(span)) out.push({ key: c.key, rule: "code-span", severity: "hard", message: `\`${span}\` is not in the cited files` });
    }
  }
  return out;
}

/** Every step must be reachable, or the diagram shows a path the walk can never take. */
function checkFlow(doc: JourneyDoc, map: LoadedMap): Fault[] {
  const out: Fault[] = [];
  const add = (key: string, message: string) => out.push({ key, rule: "journey", severity: "hard", message });
  const ids = new Set(doc.steps.map((s) => s.id));
  if (ids.size !== doc.steps.length) add("steps", "duplicate step id");
  const modules = new Set(map.modules.map((m) => m.doc.id));
  const flows = new Set(map.flows.map((f) => f.doc.id));
  const zh = map.config.languages.includes("zh");
  if (doc.steps[0] && doc.steps[0].kind !== "start") add(`steps.${doc.steps[0].id}`, "the first step must have kind start");
  for (const s of doc.steps) {
    const key = `steps.${s.id}`;
    if (modules.size && !modules.has(s.module)) add(key, `unknown module ${s.module}`);
    if (zh && !/[一-鿿]/.test(s.zh ?? "")) add(key, "zh must be Chinese");
    for (const n of s.next) if (!ids.has(n.to)) add(key, `next points at unknown step ${n.to}`);
    if (s.kind === "decision" && (s.next.length < 2 || s.next.some((n) => !n.when))) add(key, "a decision needs two or more next entries, each with when");
    if ((s.kind === "end" || s.kind === "failure") && s.next.length) add(key, `a ${s.kind} step has no next`);
    if (s.kind !== "end" && s.kind !== "failure" && !s.next.length) add(key, "this step has no next");
    if (s.kind === "subflow" && !s.subflow) add(key, "a subflow step names its journey in subflow");
    if (s.subflow && s.kind !== "subflow") add(key, "only a subflow step sets subflow");
    if (s.subflow === doc.id) add(key, "a journey cannot call itself");
    if (s.subflow && !flows.has(s.subflow)) out.push({ key, rule: "journey-link", severity: "soft", message: `journey ${s.subflow} does not exist yet` });
  }
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    doc.steps.find((s) => s.id === id)?.next.forEach((n) => walk(n.to));
  };
  if (doc.steps[0]) walk(doc.steps[0].id);
  for (const s of doc.steps) if (!seen.has(s.id)) add(`steps.${s.id}`, "not reachable from the first step");
  return out;
}

export interface GateInput {
  tree: Tree;
  map: LoadedMap;
  /** Every claim in the document: evidence must hold for all of them. */
  claims: MapClaim[];
  /** Claims that are new or reworded: only these meet the language rules again. */
  fresh: MapClaim[];
  flow?: JourneyDoc;
  terms: Term[];
}

export async function gate({ tree, map, claims, fresh: all, flow, terms }: GateInput): Promise<GateReport> {
  const fresh = all.filter((c) => c.textType !== "note");
  const faults = [...checkEvidence(tree, claims), ...checkClaimShape(tree, fresh), ...(flow ? checkFlow(flow, map) : [])];
  if (map.config.ste && fresh.length) {
    if (steInstalled()) faults.push(...await checkSte(fresh, terms));
    else faults.push({ key: "language", rule: "ste", severity: "soft", message: "ste is on, but no checker is installed; language rules did not run" });
  }
  const hard = faults.filter((f) => f.severity === "hard");
  return { ok: hard.length === 0, claims: claims.length, hard, soft: faults.filter((f) => f.severity === "soft") };
}
