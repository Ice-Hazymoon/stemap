import { basename } from "node:path";
import { Glob } from "./glob";
import { resolveEvidence, type Resolved } from "./evidence";
import { claimId, type Claim, type JourneyDoc, type Step, type Term } from "./schema";
import type { AlignReport, DriftState } from "./align";
import type { LoadedMap } from "./map";
import type { Seed } from "./seed";
import type { Tree } from "./tree";
import { Graph, type Crossings, type Support } from "./graph";
import type { CodeIndex } from "./codeindex";
import { VERSION } from "./version";

export const ATLAS_FORMAT = 2;

export interface ViewClaim { text: string; zh?: string; refs: Resolved[]; status: "verified" | "unverified"; faults: string[]; drift?: DriftState }
export interface ViewFlow { title: string; steps: ViewClaim[] }
export interface ViewNode {
  id: string;
  parent: string | null;
  kind: "system" | "domain" | "module" | "capability";
  title: string;
  zh?: string;
  oneLine?: ViewClaim;
  summary: ViewClaim[];
  flows: ViewFlow[];
  cautions: ViewClaim[];
  qa: { question: string; answer: ViewClaim[] }[];
  children: string[];
  fileCount: number;
  lines: number;
  files: { path: string; lines: number; commits90d: number }[];
  state: "ready" | "stub";
}
export type ViewStep = Omit<Step, "evidence" | "text" | "zh"> & { zh?: string; claim: ViewClaim };
export interface ViewJourney extends Omit<JourneyDoc, "steps"> { steps: ViewStep[] }
export interface ViewEdge { from: string; to: string; kind: string; note: string; refs: { path: string; contains: string }[] }
export interface Atlas {
  commit: string;
  rootId: string;
  nodes: Record<string, ViewNode>;
  edges: ViewEdge[];
  journeys: ViewJourney[];
  glossary: { term: string; type: string; definition: string; refs: Resolved[] }[];
  crossings: Crossings | null;
  support: Support | null;
  index: Record<string, number> | null;
  /** Steps and claims whose code moved since they were accepted. */
  drift: { checked: number; total: number; items: { id: string; state: DriftState; paths: string[] }[] };
  /** False when the repository has no map yet; the page then shows how to start one. */
  mapped: boolean;
  format: number;
  tool: string;
  stats: { claims: number; verified: number; unverified: number; hardByRule: Record<string, number> };
}

const blank = { summary: [], flows: [], cautions: [], qa: [], children: [] as string[], fileCount: 0, lines: 0, files: [], state: "stub" as const };

function topFiles(seed: Seed, paths: string[]) {
  const globs = paths.map((p) => new Glob(p));
  return Object.entries(seed.files)
    .filter(([f]) => globs.some((g) => g.match(f)))
    .map(([path, s]) => ({ path, ...s }))
    .sort((a, b) => b.commits90d - a.commits90d || b.lines - a.lines)
    .slice(0, 12);
}

export interface BundleInput {
  repo: string;
  commit: string;
  tree: Tree;
  map: LoadedMap;
  seed: Seed;
  index: CodeIndex | null;
  aligned: AlignReport;
}

export function buildAtlas({ repo, commit, tree, map, seed, index, aligned }: BundleInput): Atlas {
  const stats: Atlas["stats"] = { claims: 0, verified: 0, unverified: 0, hardByRule: {} };
  const driftBy = new Map(aligned.drift.map((d) => [d.claim.id, d.state]));

  /** A claim keeps its text when its evidence fails, because hiding it would hide what is unknown. */
  const view = (id: string, c: Claim): ViewClaim => {
    const refs: Resolved[] = [];
    const faults: string[] = [];
    for (const e of c.evidence) {
      const r = resolveEvidence(tree, e);
      if (r.ok) refs.push(r.at);
      else {
        faults.push(`evidence: ${r.reason}`);
        stats.hardByRule.evidence = (stats.hardByRule.evidence ?? 0) + 1;
      }
    }
    const status = faults.length || !refs.length ? "unverified" : "verified";
    stats.claims++;
    stats[status]++;
    return { text: c.text, zh: c.zh, refs, status, faults, drift: driftBy.get(id) };
  };

  const system = map.system ?? { title: map.config.name ?? basename(repo), summary: [], groups: [], preferredTerms: {} };
  const rootId = "system";
  const nodes: Record<string, ViewNode> = {};
  const sys = (c: Claim) => view(claimId("system", c.text), c);
  nodes[rootId] = { ...blank, id: rootId, parent: null, kind: "system", title: system.title, state: "ready", summary: system.summary.map(sys), children: seed.groups.map((_, i) => `domain-${i}`) };

  const docs = new Map(map.modules.map((m) => [m.doc.id, m.doc]));
  seed.groups.forEach((g, i) => {
    const d = map.system?.groups.find((x) => x.title === g.title);
    const id = `domain-${i}`;
    nodes[id] = { ...blank, id, parent: rootId, kind: "domain", title: g.title, zh: g.titleZh ?? d?.titleZh, children: g.modules, state: d?.oneLine ? "ready" : "stub", oneLine: d?.oneLine && sys(d.oneLine) };
    for (const m of g.modules) {
      const s = seed.nodes.find((n) => n.id === m);
      const t = docs.get(m);
      nodes[m] = { ...blank, id: m, parent: id, kind: "module", title: t?.title ?? m, zh: s?.note ?? s?.titleZh,
        fileCount: s?.fileCount ?? 0, lines: s?.lines ?? 0, files: topFiles(seed, s?.paths ?? []),
        children: seed.nodes.filter((n) => n.parent === m).map((n) => n.id) };
    }
  });
  for (const s of seed.nodes) {
    if (!s.parent || !nodes[s.parent]) continue;
    nodes[s.id] = { ...blank, id: s.id, parent: s.parent, kind: "capability", title: s.title ?? s.id.split(".").pop()!, zh: s.note ?? s.titleZh,
      fileCount: s.fileCount, lines: s.lines, files: topFiles(seed, s.paths) };
  }

  const edges: ViewEdge[] = [];
  const glossary = new Map<string, Term>(map.glossary.map((t) => [t.term.toLowerCase(), t]));
  for (const { doc } of map.modules) {
    const n = nodes[doc.id];
    if (!n) continue;
    const v = (c: Claim) => view(claimId(`module/${doc.id}`, c.text), c);
    const fill = (node: ViewNode, b: Pick<typeof doc, "summary" | "flows" | "cautions">) => {
      node.summary = b.summary.map(v);
      node.flows = b.flows.map((f) => ({ title: f.title, steps: f.steps.map(v) }));
      node.cautions = b.cautions.map(v);
      if (b.summary.length || node.oneLine) node.state = "ready";
    };
    n.oneLine = doc.oneLine && v(doc.oneLine);
    fill(n, doc);
    n.qa = doc.qa.map((q) => ({ question: q.question, answer: q.answer.map(v) }));
    for (const ch of doc.children) {
      const c: ViewNode = nodes[ch.id] ?? { ...blank, id: ch.id, parent: doc.id, kind: "capability", title: ch.title };
      if (!nodes[ch.id]) { nodes[ch.id] = c; n.children.push(ch.id); }
      c.title = ch.title;
      c.oneLine = ch.oneLine && v(ch.oneLine);
      fill(c, ch);
    }
    for (const r of doc.relations) edges.push({ from: doc.id, to: r.to, kind: r.kind, note: r.note, refs: r.evidence });
    for (const t of doc.terms) if (!glossary.has(t.term.toLowerCase())) glossary.set(t.term.toLowerCase(), t);
  }

  const journeys: ViewJourney[] = map.flows.map(({ doc }) => ({
    ...doc,
    steps: doc.steps.map(({ evidence, text, zh, ...s }) => ({ ...s, zh, claim: view(`flow/${doc.id}/${s.id}`, { text, zh, evidence }) })),
  }));

  const graph = index ? new Graph(index, journeys, nodes) : null;
  return {
    format: ATLAS_FORMAT,
    tool: VERSION,
    mapped: map.flows.length + map.modules.length > 0,
    commit, rootId, nodes, journeys,
    drift: { checked: aligned.checked, total: aligned.drift.length, items: aligned.drift.map((d) => ({ id: d.claim.id, state: d.state, paths: [...new Set(d.anchors.map((a) => a.path))] })) },
    crossings: graph?.crossings() ?? null,
    support: graph?.support() ?? null,
    index: index ? { ...index.stats, tables: index.tables.length, routes: index.routes.length, queues: index.queues.length, pages: index.pages.length } : null,
    edges: edges.filter((e) => nodes[e.from] && nodes[e.to]),
    glossary: [...glossary.values()].sort((a, b) => a.term.localeCompare(b.term)).map((t) => ({
      term: t.term, type: t.type, definition: t.definition,
      refs: t.evidence.flatMap((e) => { const r = resolveEvidence(tree, e); return r.ok ? [r.at] : []; }),
    })),
    stats,
  };
}
