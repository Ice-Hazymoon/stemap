import { createHash } from "node:crypto";
import { parseSync } from "oxc-parser";

/**
 * Finds the symbol around a quoted line and hashes what it means, not how it is typed. A claim
 * goes out of date only when that hash moves, so formatting, comments and moved code stay quiet.
 */
export interface Located { symbol: string; hash: string; line: number; end: number }

type AnyNode = Record<string, any>;
export const CODE_EXT = [".ts", ".tsx", ".vue", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const isCode = (path: string) => CODE_EXT.some((x) => path.endsWith(x));

/** Blanks everything outside `<script>` and keeps each byte offset, so line numbers still match the file. */
export const scriptOf = (code: string) => {
  let out = code.replace(/[^\n]/g, " ");
  // An attribute can hold `>` (`generic="T extends Foo<Bar>"`), so the open tag is read attribute by attribute.
  for (const m of code.matchAll(/(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/script>/g)) {
    const at = m.index! + m[1]!.length;
    out = out.slice(0, at) + m[2]! + out.slice(at + m[2]!.length);
  }
  return out;
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** Source positions and the raw spelling of literals change with formatting, not with behaviour. */
const DROP = new Set(["start", "end", "range", "loc", "raw", "parent"]);
const canon = (v: unknown, skip?: (n: AnyNode) => boolean): string => {
  if (Array.isArray(v)) return `[${v.map((x) => canon(x, skip)).join(",")}]`;
  if (typeof v === "bigint") return `${v}n`;
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (skip?.(v as AnyNode)) return "_";
  let out = "{";
  for (const k in v) if (!DROP.has(k)) out += `${k}:${canon((v as AnyNode)[k], skip)},`;
  return `${out}}`;
};
const seen = new WeakMap<AnyNode, string>();
/** Many claims cite one function, so each node hashes once. */
const hashNode = (n: AnyNode) => seen.get(n) ?? (seen.set(n, sha(canon(n))), seen.get(n)!);
const shells = new WeakMap<AnyNode, string>();
/**
 * A function without the named functions inside it. A guard in the outer function protects a closure
 * inside it, so a claim on the closure must move when the guard does, but not when a sibling does.
 */
const hashShell = (n: AnyNode) => shells.get(n) ?? (shells.set(n, sha(canon(n, (x) => x !== n && typeof x.type === "string" && nameOf(x, false) !== null))), shells.get(n)!);
const hashText = (s: string) => sha(s.replace(/\r\n/g, "\n").split("\n").map((l) => l.trimEnd()).join("\n").trim());
const hashMarkup = (s: string) => sha(s.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim());

const FN = /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/;
const holdsFunction = (n: AnyNode | null | undefined): boolean => {
  if (!n) return false;
  if (FN.test(n.type) || n.type === "ClassExpression") return true;
  // `const save = useMutation({ fn })` and `export const x = wrap(async () => …)` hold their logic in a callback.
  if (n.type === "CallExpression") return n.arguments.some((a: AnyNode) => holdsFunction(a) || (a.type === "ObjectExpression" && a.properties.some((p: AnyNode) => holdsFunction(p.value))));
  if (n.type === "TSAsExpression" || n.type === "TSSatisfiesExpression" || n.type === "AwaitExpression") return holdsFunction(n.expression);
  return false;
};

const keyName = (k: AnyNode | undefined) => (k?.type === "Identifier" ? k.name : k?.type === "Literal" && typeof k.value === "string" ? k.value : null) as string | null;

/** `app.get("/x", handler)` and `describe("x", fn)` have no declared name, so the call gives them one. */
function callName(n: AnyNode): string | null {
  if (n.type !== "CallExpression" || typeof n.arguments[0]?.value !== "string") return null;
  if (!n.arguments.slice(1).some(holdsFunction)) return null;
  const callee = n.callee;
  const verb = callee?.type === "MemberExpression" && !callee.computed ? callee.property.name : callee?.name;
  return verb ? `${verb}(${n.arguments[0].value})` : null;
}

/** The name a node adds to a symbol path. A nested name counts only where it holds logic of its own. */
function nameOf(n: AnyNode, top: boolean): string | null {
  switch (n.type) {
    case "FunctionDeclaration": case "ClassDeclaration": case "ClassExpression": case "TSDeclareFunction":
    case "TSInterfaceDeclaration": case "TSTypeAliasDeclaration": case "TSEnumDeclaration": case "TSModuleDeclaration":
      return n.id?.name ?? null;
    case "VariableDeclarator":
      return n.id?.type === "Identifier" && (top || holdsFunction(n.init)) ? n.id.name : null;
    case "MethodDefinition": case "PropertyDefinition":
      return keyName(n.key);
    case "Property":
      return holdsFunction(n.value) ? keyName(n.key) : null;
    case "ExportDefaultDeclaration":
      return "default";
    default:
      return callName(n);
  }
}

const each = (n: AnyNode, f: (c: AnyNode) => void) => {
  for (const k in n) {
    const v = n[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === "string") f(x); }
    else if (v && typeof v.type === "string") f(v);
  }
};

function lineTable(code: string) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") starts.push(i + 1);
  return (pos: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m]! <= pos) lo = m; else hi = m - 1; }
    return lo + 1;
  };
}

export interface Locator { at(offset: number): Located }

const langOf = (path: string) => (path.endsWith(".tsx") ? "tsx" : /\.[mc]?jsx?$/.test(path) ? "jsx" : "ts") as "tsx" | "jsx" | "ts";

function parse(path: string, code: string): AnyNode | null {
  const vue = path.endsWith(".vue");
  try {
    const r = parseSync(vue ? `${path}.ts` : path, code, { sourceType: "module", lang: langOf(path), preserveParens: false });
    return r.errors.some((e: { severity: string }) => e.severity === "Error") ? null : r.program;
  } catch { return null; }
}

/** A file with no syntax to read falls back to one hash for the whole file, so a map still works in any language. */
const wholeFile = (code: string, lineOf: (p: number) => number): Locator => {
  const located = { symbol: "<file>", hash: hashText(code), line: 1, end: lineOf(code.length) };
  return { at: () => located };
};

export function locator(path: string, raw: string): Locator {
  const lineOf = lineTable(raw);
  if (!isCode(path)) return wholeFile(raw, lineOf);
  const vue = path.endsWith(".vue");
  const code = vue ? scriptOf(raw) : raw;
  const program = parse(path, code);
  if (!program) return wholeFile(raw, lineOf);
  // A `<template>` has no AST here, so the block hashes as whitespace-collapsed markup.
  const blocks = vue ? [...raw.matchAll(/<(template|style)\b[^>]*>[\s\S]*<\/\1>/g)].map((m) => ({ kind: m[1]!, start: m.index!, end: m.index! + m[0].length, text: m[0] })) : [];

  return {
    at(offset) {
      const block = blocks.find((b) => offset >= b.start && offset < b.end);
      if (block) return { symbol: `<${block.kind}>`, hash: hashMarkup(block.text), line: lineOf(block.start), end: lineOf(block.end) };
      const body = program.body as AnyNode[];
      // A quote inside a comment belongs to the code the comment sits on.
      const host = body.find((s) => offset < s.end) ?? body.at(-1);
      if (!host) return { symbol: "<file>", hash: hashText(raw), line: 1, end: lineOf(raw.length) };
      // `export const x`: the words before the name, and a comment above it, both mean x.
      const first = (n: AnyNode): AnyNode => (n.declaration ? first(n.declaration) : n.declarations?.[0] ?? n);
      const target = Math.max(offset, first(host).start);
      const names: string[] = [];
      const owners: AnyNode[] = [];
      const descend = (n: AnyNode, top: boolean) => {
        const name = nameOf(n, top);
        if (name) { names.push(name); owners.push(n); }
        // `export const x` and `const x, y` sit one or two nodes down, and they are still top-level names.
        const wrapper = top && (n.type === "ExportNamedDeclaration" || n.type === "VariableDeclaration");
        each(n, (c) => { if (target >= c.start && target < c.end) descend(c, wrapper); });
      };
      descend(host, true);
      const own = owners.at(-1);
      if (own) {
        const outer = owners.slice(0, -1).map(hashShell);
        return { symbol: names.join("."), hash: outer.length ? sha([...outer, hashNode(own)].join()) : hashNode(own), line: lineOf(own.start), end: lineOf(own.end) };
      }
      // An import or a bare statement has no name; the hash in its key keeps two of them in one file apart.
      const hash = hashNode(host);
      return { symbol: `<top:${hash.slice(0, 6)}>`, hash, line: lineOf(host.start), end: lineOf(host.end) };
    },
  };
}

/** Every top-level name in a file with its hash, used to tell which functions a change touched. */
export function topSymbols(path: string, raw: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!isCode(path)) return out;
  const program = parse(path, path.endsWith(".vue") ? scriptOf(raw) : raw);
  if (!program) return out;
  const add = (n: AnyNode) => {
    if (n.type === "VariableDeclaration") { for (const d of n.declarations) if (d.id?.name) out.set(d.id.name, hashNode(d)); return; }
    const name = nameOf(n, true);
    if (name) out.set(name, hashNode(n));
  };
  for (const s of program.body as AnyNode[]) {
    if (s.type === "ExportNamedDeclaration" && s.declaration) add(s.declaration);
    else add(s);
  }
  return out;
}

/** Fingerprint of a claim's words and evidence, so an edit that skipped `stemap write` shows up. */
export const fingerprint = (text: string, evidence: unknown) => sha(`${text}\0${JSON.stringify(evidence)}`).slice(0, 8);
export const shortHash = (s: string) => sha(s).slice(0, 8);

/** Quote offset, tolerant of reflowed whitespace: a formatter must not read as a lost quote. */
export function findQuote(code: string, needle: string, near?: string): { offset: number; exact: boolean } | null {
  if (!needle) return null;
  const all = (hay: string, n: string) => { const out: number[] = []; for (let i = hay.indexOf(n); i !== -1; i = hay.indexOf(n, i + 1)) out.push(i); return out; };
  const hits = all(code, needle);
  if (hits.length === 1 || (hits.length && !near)) return { offset: hits[0]!, exact: true };
  if (hits.length) {
    const anchors = near ? all(code, near) : [];
    if (!anchors.length) return { offset: hits[0]!, exact: true };
    const gap = (h: number) => Math.min(...anchors.map((a) => Math.abs(a - h)));
    return { offset: hits.reduce((best, h) => (gap(h) < gap(best) ? h : best)), exact: true };
  }
  const pattern = needle.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/['"`]/g, "['\"`]")).join("\\s+");
  const m = pattern ? new RegExp(pattern).exec(code) : null;
  return m ? { offset: m.index, exact: false } : null;
}
