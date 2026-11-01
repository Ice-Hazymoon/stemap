import { findQuote } from "./symbols";
import { readable, type Tree } from "./tree";
import type { Evidence } from "./schema";

export const MIN_LEN = 12;

export interface Resolved { path: string; startLine: number; endLine: number }
export type EvidenceResult = { ok: true; at: Resolved } | { ok: false; reason: string };

const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

/** Matching is byte-exact: a normalized match would let a model cite text the file does not hold. */
export function resolveEvidence(tree: Tree, e: Evidence): EvidenceResult {
  if (!readable(e.path)) return { ok: false, reason: `${e.path} cannot be cited` };
  const text = tree.read(e.path);
  if (text === null) return { ok: false, reason: `no file ${e.path}` };
  if (e.contains.length < MIN_LEN) return { ok: false, reason: `contains is shorter than ${MIN_LEN} characters` };
  const first = text.indexOf(e.contains);
  if (first < 0) return { ok: false, reason: `contains not found in ${e.path}` };
  if (!e.near && text.indexOf(e.contains, first + 1) >= 0) return { ok: false, reason: `contains matches several places in ${e.path}; add near` };
  if (e.near && !text.includes(e.near)) return { ok: false, reason: "near not found" };
  const at = findQuote(text, e.contains, e.near)!.offset;
  return { ok: true, at: { path: e.path, startLine: lineOf(text, at), endLine: lineOf(text, at + e.contains.length) } };
}
