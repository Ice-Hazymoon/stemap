import { fingerprint, findQuote, locator, type Located, type Locator } from "./symbols";
import type { LockEntry } from "./lock";
import type { MapClaim } from "./map";
import type { Tree } from "./tree";

/**
 * The one comparison everything rests on: each claim, against the code as it is now. It is a pure
 * function of the tree, the map and the lock, with no diff or saved state, so a local run and a CI
 * run on the same commit cannot disagree, and there is no incremental path to drift from a full one.
 */
export type DriftState =
  /** The code a claim rests on changed: reread the claim. */
  | "changed"
  /** The quoted line or its file is gone: fix the evidence. */
  | "lost"
  /** The claim never went through `stemap write`. */
  | "unlocked"
  /** The claim's words or evidence changed after it was locked. */
  | "edited";

export interface Anchor { path: string; contains: string; located: Located | null; exact: boolean; candidates: string[] }
export interface Drift {
  claim: MapClaim;
  state: DriftState;
  anchors: Anchor[];
  /** The `path#symbol` keys behind the state, for the message. */
  changed: string[];
}
export interface AlignReport { checked: number; drift: Drift[] }

export const anchorKey = (a: { path: string; located: Located | null }) => `${a.path}#${a.located?.symbol ?? "?"}`;

export function anchorsOf(tree: Tree, claim: MapClaim, cache: Map<string, Locator>, searchLost = false): Anchor[] {
  return claim.claim.evidence.map((e) => {
    const code = tree.read(e.path);
    const base = { path: e.path, contains: e.contains };
    const found = code === null ? null : findQuote(code, e.contains, e.near);
    if (!found) return { ...base, located: null, exact: false, candidates: searchLost ? tree.grep(e.contains).slice(0, 5) : [] };
    const loc = cache.get(e.path) ?? cache.set(e.path, locator(e.path, code!)).get(e.path)!;
    return { ...base, located: loc.at(found.offset), exact: found.exact, candidates: [] };
  });
}

export const claimFingerprint = (c: MapClaim) => fingerprint(c.claim.text, c.claim.evidence);

/** The lock line for a claim as it stands, or null when part of its evidence cannot be found. */
export function entryFor(c: MapClaim, anchors: Anchor[], reason: string): LockEntry | null {
  if (anchors.some((a) => !a.located)) return null;
  return { id: c.id, fp: claimFingerprint(c), anchors: Object.fromEntries(anchors.map((a) => [anchorKey(a), a.located!.hash])), reason };
}

function compare(c: MapClaim, anchors: Anchor[], entries: LockEntry[] | undefined): Omit<Drift, "claim" | "anchors"> | null {
  const lost = anchors.filter((a) => !a.located);
  if (lost.length) return { state: "lost", changed: lost.map((a) => a.path) };
  if (!entries?.length) return { state: "unlocked", changed: [] };
  const fp = claimFingerprint(c);
  const same = entries.filter((e) => e.fp === fp);
  if (!same.length) return { state: "edited", changed: [] };
  const differs = (e: LockEntry) => anchors.filter((a) => e.anchors[anchorKey(a)] !== a.located!.hash).map(anchorKey);
  if (same.some((e) => !differs(e).length)) return null;
  return { state: "changed", changed: differs(same[0]!) };
}

export function align(tree: Tree, claims: MapClaim[], lock: Map<string, LockEntry[]>): AlignReport {
  tree.prefetch(claims.flatMap((c) => c.claim.evidence.map((e) => e.path)));
  const cache = new Map<string, Locator>();
  const drift: Drift[] = [];
  for (const c of claims) {
    const anchors = anchorsOf(tree, c, cache);
    const d = compare(c, anchors, lock.get(c.id));
    if (!d) continue;
    drift.push({ claim: c, anchors: d.state === "lost" ? anchorsOf(tree, c, cache, true) : anchors, ...d });
  }
  return { checked: claims.length, drift };
}
