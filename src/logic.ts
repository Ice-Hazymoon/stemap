import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import { scriptOf } from "./symbols";

/**
 * Branch structure read straight from the AST. A model never writes this tree: the words around it
 * may drift, but `A && (B || C)` here is what the code says at this commit.
 */
export type Cond =
  | { op: "leaf"; text: string; line: number }
  | { op: "and" | "or"; items: Cond[]; line: number }
  | { op: "not"; item: Cond; line: number };
export type LogicNode =
  | { t: "if"; cond: Cond; then: LogicNode[]; else: LogicNode[]; line: number }
  | { t: "switch"; text: string; cases: { label: string; body: LogicNode[]; line: number }[]; line: number }
  | { t: "try"; body: LogicNode[]; handler: LogicNode[]; line: number }
  | { t: "loop"; text: string; body: LogicNode[]; line: number }
  | { t: "scope"; text: string; body: LogicNode[]; line: number }
  | { t: "return" | "throw" | "call"; text: string; line: number };
export interface LogicTree { nodes: LogicNode[]; branches: number; truncated: boolean }

type AnyNode = Record<string, any>;
const MAX_NODES = 240;
const MAX_DEPTH = 9;
const FN = /^(FunctionExpression|FunctionDeclaration|ArrowFunctionExpression)$/;

const each = (n: AnyNode, f: (x: AnyNode) => void) => {
  for (const k in n) {
    const v = n[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === "string") f(x); }
    else if (v && typeof v.type === "string") f(v);
  }
};

/** Reads a file once and answers for any line range in it, so a whole file's trees cost one parse. */
export function logicReader(root: string, file: string): (start: number, end: number) => LogicTree {
  const raw = readFileSync(join(root, file), "utf8");
  const code = file.endsWith(".vue") ? scriptOf(raw) : raw;
  const { program } = parseSync(file.endsWith(".vue") ? `${file}.ts` : file, code, { sourceType: "module", lang: file.endsWith(".tsx") ? "tsx" : "ts" });
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") starts.push(i + 1);
  const lineOf = (pos: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m]! <= pos) lo = m; else hi = m - 1; }
    return lo + 1;
  };
  const text = (n: AnyNode, cap = 110) => {
    const t = code.slice(n.start, n.end).replace(/\s+/g, " ").trim();
    return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
  };

  const functions: AnyNode[] = [];
  const collect = (n: AnyNode) => {
    if (FN.test(n.type) && n.body?.type === "BlockStatement") functions.push(n);
    each(n, collect);
  };
  collect(program);

  return (start, end) => {
  // A wrapper such as defineEventHandler holds its logic in the largest function inside the range.
  let target: AnyNode | null = null;
  for (const n of functions) {
    if (lineOf(n.start) >= start && lineOf(n.end) <= end && (!target || n.end - n.start > target.end - target.start)) target = n;
  }
  if (!target) return { nodes: [], branches: 0, truncated: false };

  let count = 0, branches = 0, truncated = false;
  const cond = (n: AnyNode): Cond => {
    const line = lineOf(n.start);
    if (n.type === "ParenthesizedExpression") return cond(n.expression);
    if (n.type === "LogicalExpression" && (n.operator === "&&" || n.operator === "||")) {
      const op = n.operator === "&&" ? "and" : "or";
      const flat = (x: AnyNode): AnyNode[] => {
        const y = x.type === "ParenthesizedExpression" ? x.expression : x;
        return y.type === "LogicalExpression" && y.operator === n.operator ? [...flat(y.left), ...flat(y.right)] : [x];
      };
      return { op, items: flat(n).map(cond), line };
    }
    if (n.type === "UnaryExpression" && n.operator === "!") {
      const inner = n.argument.type === "ParenthesizedExpression" ? n.argument.expression : n.argument;
      if (inner.type === "LogicalExpression" && inner.operator !== "??") return { op: "not", item: cond(inner), line };
    }
    return { op: "leaf", text: text(n, 90), line };
  };

  /** `as const` says nothing about what the code does, and it costs a return value its one line. */
  const bare = (n: AnyNode): AnyNode => (n.type === "TSAsExpression" || n.type === "TSSatisfiesExpression" ? bare(n.expression) : n);
  const exitText = (found: AnyNode | null | undefined) => {
    if (!found) return "";
    const arg = bare(found);
    if (arg.type === "CallExpression" && arg.callee?.name === "createError") {
      const props = arg.arguments[0]?.properties ?? [];
      const get = (k: string) => props.find((p: AnyNode) => p.key?.name === k)?.value;
      const status = get("statusCode");
      const data = get("data")?.properties?.find((p: AnyNode) => p.key?.name === "code")?.value;
      const parts = [status && text(status), data && text(data, 60)].filter(Boolean);
      if (parts.length) return parts.join(" · ");
    }
    return text(arg, 80);
  };
  /** An inline callback is where the transaction body lives in this codebase, so it stays in the tree. */
  const inlineFn = (n: AnyNode): AnyNode | null => {
    let hit: AnyNode | null = null;
    const look = (x: AnyNode) => {
      if (hit) return;
      if (FN.test(x.type) && x.body?.type === "BlockStatement") { hit = x; return; }
      each(x, look);
    };
    look(n);
    return hit;
  };
  const calleeName = (n: AnyNode) => {
    let c: AnyNode | null = n;
    const unwrap = (x: AnyNode): AnyNode => (x.type === "AwaitExpression" ? unwrap(x.argument) : x);
    c = unwrap(n);
    return c.type === "CallExpression" ? text(c.callee, 90) : null;
  };

  const seq = (list: AnyNode[], depth: number): LogicNode[] => {
    const out: LogicNode[] = [];
    for (const s of list) {
      if (count >= MAX_NODES || depth > MAX_DEPTH) { truncated = true; break; }
      out.push(...stmt(s, depth));
    }
    return out;
  };
  const block = (n: AnyNode | null | undefined, depth: number): LogicNode[] => {
    if (!n) return [];
    return seq(n.type === "BlockStatement" ? n.body : [n], depth + 1);
  };
  const stmt = (s: AnyNode, depth: number): LogicNode[] => {
    count++;
    const line = lineOf(s.start);
    switch (s.type) {
      case "IfStatement":
        branches++;
        return [{ t: "if", cond: cond(s.test), then: block(s.consequent, depth), else: block(s.alternate, depth), line }];
      case "SwitchStatement":
        branches++;
        return [{ t: "switch", text: text(s.discriminant, 70), line, cases: s.cases.map((c: AnyNode) => ({ label: c.test ? text(c.test, 60) : "default", line: lineOf(c.start), body: seq(c.consequent, depth + 1) })) }];
      case "TryStatement":
        branches++;
        return [{ t: "try", body: block(s.block, depth), handler: block(s.handler?.body, depth), line }];
      case "ReturnStatement": return [{ t: "return", text: exitText(s.argument), line }];
      case "ThrowStatement": return [{ t: "throw", text: exitText(s.argument), line }];
      case "BlockStatement": return seq(s.body, depth);
      case "ForStatement": case "ForInStatement": case "ForOfStatement": case "WhileStatement": case "DoWhileStatement": {
        const body = block(s.body, depth);
        const head = s.type === "ForOfStatement" ? `${text(s.left, 30)} of ${text(s.right, 40)}` : s.test ? text(s.test, 60) : "loop";
        return body.length ? [{ t: "loop", text: head, body, line }] : [];
      }
      case "ExpressionStatement": case "VariableDeclaration": {
        const init = s.type === "VariableDeclaration" ? s.declarations[0]?.init : s.expression;
        if (!init) return [];
        const fn = inlineFn(init);
        const name = calleeName(init);
        if (fn) {
          const body = seq(fn.body.body, depth + 1);
          return body.length ? [{ t: "scope", text: name ?? text(init, 40), body, line }] : [];
        }
        return name && init.type === "AwaitExpression" ? [{ t: "call", text: name, line }] : [];
      }
      default: return [];
    }
  };
  const nodes = seq((target as AnyNode).body.body, 0);
  return { nodes, branches, truncated };
  };
}

export const logicOf = (root: string, file: string, start: number, end: number) => logicReader(root, file)(start, end);
