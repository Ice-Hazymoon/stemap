import { z } from "zod";
import { shortHash } from "./symbols";

export const Evidence = z.object({
  path: z.string().min(1),
  contains: z.string().min(1),
  near: z.string().min(1).optional(),
}).strict();

export const Claim = z.object({
  text: z.string(),
  zh: z.string().optional(),
  evidence: z.array(Evidence).min(1),
}).strict();

export const Flow = z.object({ title: z.string(), steps: z.array(Claim).min(1) }).strict();

export const Term = z.object({
  term: z.string(),
  type: z.enum(["noun", "verb"]),
  definition: z.string(),
  evidence: z.array(Evidence).min(1),
}).strict();

const Body = {
  summary: z.array(Claim).default([]),
  flows: z.array(Flow).default([]),
  cautions: z.array(Claim).default([]),
};

export const Child = z.object({
  id: z.string(),
  title: z.string(),
  titleZh: z.string().optional(),
  note: z.string().optional(),
  oneLine: Claim.optional(),
  paths: z.array(z.string()).default([]),
  ...Body,
}).strict();

export const Relation = z.object({
  to: z.string(),
  kind: z.string(),
  note: z.string(),
  evidence: z.array(Evidence).default([]),
}).strict();

export const QA = z.object({ question: z.string(), answer: z.array(Claim).min(1) }).strict();

/** `paths` lists only the globs the folder layout cannot infer. */
export const ModuleDoc = z.object({
  id: z.string(),
  title: z.string(),
  titleZh: z.string().optional(),
  note: z.string().optional(),
  oneLine: Claim.optional(),
  paths: z.array(z.string()).default([]),
  ...Body,
  children: z.array(Child).default([]),
  relations: z.array(Relation).default([]),
  terms: z.array(Term).default([]),
  qa: z.array(QA).default([]),
}).strict();

export const Group = z.object({
  title: z.string(),
  titleZh: z.string().optional(),
  oneLine: Claim.optional(),
  modules: z.array(z.string()).default([]),
}).strict();

export const SystemDoc = z.object({
  title: z.string(),
  summary: z.array(Claim).default([]),
  groups: z.array(Group).default([]),
  preferredTerms: z.record(z.string(), z.string()).default({}),
}).strict();

export const GlossaryDoc = z.object({ terms: z.array(Term).default([]) }).strict();

const Lane = z.enum(["user", "page", "api", "service", "database", "queue", "external"]);

export const Step = z.object({
  id: z.string(),
  title: z.string(),
  titleZh: z.string().optional(),
  lane: Lane,
  module: z.string(),
  kind: z.enum(["start", "action", "decision", "end", "failure", "subflow"]),
  subflow: z.string().optional(),
  text: z.string(),
  zh: z.string().optional(),
  evidence: z.array(Evidence).min(1),
  writes: z.array(z.object({ target: z.string(), change: z.string(), changeZh: z.string().optional() }).strict()).default([]),
  next: z.array(z.object({ to: z.string(), when: z.string().optional(), whenZh: z.string().optional(), failure: z.boolean().default(false) }).strict()).default([]),
}).strict();

export const JourneyDoc = z.object({
  id: z.string(),
  title: z.string(),
  titleZh: z.string().optional(),
  actor: z.string(),
  actorZh: z.string().optional(),
  goal: z.string(),
  goalZh: z.string().optional(),
  after: z.array(z.string()).default([]),
  steps: z.array(Step).min(3),
}).strict();

export type Step = z.infer<typeof Step>;
export type JourneyDoc = z.infer<typeof JourneyDoc>;
export type Evidence = z.infer<typeof Evidence>;
export type Claim = z.infer<typeof Claim>;
export type Term = z.infer<typeof Term>;
export type ModuleDoc = z.infer<typeof ModuleDoc>;
export type SystemDoc = z.infer<typeof SystemDoc>;

/** `note` is free text beside evidence, such as a relation: it stays checked and out of the language rules. */
export type TextType = "description" | "procedure" | "note";

/** One gate-checked sentence. `id` survives edits around it, so the lock keeps following the same claim. */
export interface ClaimRef {
  id: string;
  /** Where the claim sits in its document, for messages. */
  key: string;
  textType: TextType;
  claim: Claim;
}

export const claimId = (prefix: string, text: string) => `${prefix}/${shortHash(text)}`;

function body(prefix: string, label: string, b: Pick<ModuleDoc, "summary" | "flows" | "cautions">, out: ClaimRef[]) {
  const add = (key: string, textType: TextType, claim: Claim) => out.push({ id: claimId(prefix, claim.text), key: `${label}${key}`, textType, claim });
  b.summary.forEach((c, i) => add(`summary[${i}]`, "description", c));
  b.flows.forEach((f, i) => f.steps.forEach((c, j) => add(`flows[${i}].steps[${j}]`, "procedure", c)));
  b.cautions.forEach((c, i) => add(`cautions[${i}]`, "procedure", c));
}

export function moduleClaims(doc: ModuleDoc): ClaimRef[] {
  const prefix = `module/${doc.id}`;
  const out: ClaimRef[] = [];
  const add = (key: string, textType: TextType, claim: Claim) => out.push({ id: claimId(prefix, claim.text), key, textType, claim });
  if (doc.oneLine) add("oneLine", "description", doc.oneLine);
  body(prefix, "", doc, out);
  doc.children.forEach((ch, i) => {
    if (ch.oneLine) add(`children[${i}].oneLine`, "description", ch.oneLine);
    body(prefix, `children[${i}].`, ch, out);
  });
  doc.qa.forEach((q, i) => q.answer.forEach((c, j) => add(`qa[${i}].answer[${j}]`, "description", c)));
  doc.relations.forEach((r, i) => { if (r.evidence.length) add(`relations[${i}]`, "note", { text: r.note, evidence: r.evidence }); });
  return out;
}

export function flowClaims(doc: JourneyDoc): ClaimRef[] {
  return doc.steps.map((st) => ({
    id: `flow/${doc.id}/${st.id}`,
    key: `steps.${st.id}`,
    textType: "description" as const,
    claim: { text: st.text, evidence: st.evidence },
  }));
}

export function systemClaims(doc: SystemDoc): ClaimRef[] {
  const out: ClaimRef[] = [];
  doc.summary.forEach((c, i) => out.push({ id: claimId("system", c.text), key: `summary[${i}]`, textType: "description", claim: c }));
  doc.groups.forEach((g, i) => { if (g.oneLine) out.push({ id: claimId("system", g.oneLine.text), key: `groups[${i}].oneLine`, textType: "description", claim: g.oneLine }); });
  return out;
}

export const termClaims = (terms: Term[]): ClaimRef[] => terms.map((t, i) => ({
  id: claimId("term", t.term),
  key: `terms[${i}]`,
  textType: "description" as const,
  claim: { text: t.definition, evidence: t.evidence },
}));
