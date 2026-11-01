import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Stack conventions as small data-driven entries: a new framework adds one entry to a list here,
 * never a branch in the indexer. Everything below reads syntax or file names only.
 */
type AnyNode = Record<string, any>;

export interface FileRoute { method: string; path: string; /** Export that holds the handler; absent means the default export. */ handler?: string }

const JS_EXT = String.raw`[mc]?[jt]sx?`;
const HTTP_VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Next.js folder segments: groups, parallel slots and dynamic parts become route syntax. */
const nextPath = (dirs: string[]) => {
  const parts = dirs
    .filter((p) => p !== "index" && !/^\(.*\)$/.test(p) && !p.startsWith("@"))
    .map((p) => p.replace(/^\[+\.\.\..*\]+$/, "**").replace(/^\[+(.+?)\]+$/, ":$1"));
  return `/${parts.join("/")}`;
};

const nuxtRoute = (file: string): FileRoute[] => {
  const m = /^server\/(api|routes)\/(.+)\.ts$/.exec(file);
  // A leading underscore marks a helper that sits beside the handlers.
  if (!m || /(^|\/)_(?!dev\/)[^/]*($|\/)/.test(m[2]!)) return [];
  let rest = m[2]!;
  const verb = /\.(get|post|put|patch|delete)$/.exec(rest);
  if (verb) rest = rest.slice(0, -verb[0].length);
  const parts = rest.split("/").filter((p) => p !== "index").map((p) => p.replace(/^\[\.\.\..*\]$/, "**").replace(/^\[(.+)\]$/, ":$1"));
  return [{ method: verb?.[1]!.toUpperCase() ?? "ANY", path: `${m[1] === "api" ? "/api" : ""}/${parts.join("/")}`.replace(/\/$/, "") || "/" }];
};

/** App Router: one route per exported verb, so a file's handlers stay separate functions. */
const nextAppRoute = (file: string, exports: ReadonlySet<string>): FileRoute[] => {
  const m = new RegExp(String.raw`^(?:src/)?app/((?:.+/)?)route\.${JS_EXT}$`).exec(file);
  if (!m) return [];
  const path = nextPath(m[1]!.split("/").filter(Boolean));
  return HTTP_VERBS.filter((v) => exports.has(v)).map((v) => ({ method: v, path, handler: v }));
};

const nextPagesApi = (file: string): FileRoute[] => {
  const m = new RegExp(String.raw`^(?:src/)?pages/(api(?:/.+)?)\.${JS_EXT}$`).exec(file);
  return m ? [{ method: "ANY", path: nextPath(m[1]!.split("/")) }] : [];
};

const ROUTE_CONVENTIONS: ((file: string, exports: ReadonlySet<string>) => FileRoute[])[] = [nuxtRoute, nextAppRoute, nextPagesApi];

export function routeOf(file: string, exports: Iterable<string> = []): FileRoute[] {
  const set = new Set(exports);
  for (const c of ROUTE_CONVENTIONS) { const r = c(file, set); if (r.length) return r; }
  return [];
}

const nuxtPage = (file: string): string | null => {
  const m = /^(?:packages\/admin\/)?app\/pages\/(.+)\.vue$/.exec(file);
  if (!m) return null;
  const parts = m[1]!.split("/").filter((p) => p !== "index" && !/^\(.*\)$/.test(p)).map((p) => p.replace(/^\[\.\.\..*\]$/, "**").replace(/^\[+(.+?)\]+$/, ":$1"));
  return `${file.startsWith("packages/admin") ? "admin:" : ""}/${parts.join("/")}`;
};

const nextAppPage = (file: string): string | null => {
  const m = /^(?:src\/)?app\/((?:.+\/)?)page\.(?:[jt]sx?)$/.exec(file);
  return m ? nextPath(m[1]!.split("/").filter(Boolean)) : null;
};

const nextPagesPage = (file: string): string | null => {
  const m = /^(?:src\/)?pages\/(.+)\.(?:[jt]sx?)$/.exec(file);
  if (!m || m[1]!.startsWith("api/")) return null;
  const parts = m[1]!.split("/");
  return /^_(app|document|error|middleware)$/.test(parts.at(-1)!) ? null : nextPath(parts);
};

const PAGE_CONVENTIONS: ((file: string) => string | null)[] = [nuxtPage, nextAppPage, nextPagesPage];

export function pageOf(file: string): string | null {
  for (const c of PAGE_CONVENTIONS) { const p = c(file); if (p !== null) return p; }
  return null;
}

/** Table-defining calls: the first argument is the SQL name. */
export const TABLE_FACTORIES = new Set(["pgTable", "mysqlTable", "sqliteTable"]);

/** Router-like receivers: these names, or any variable initialised from one of these factories. */
const ROUTER_NAMES = new Set(["app", "router", "api", "server"]);
const ROUTER_FACTORIES = new Set(["Hono", "express", "Router", "fastify", "Elysia"]);
const ROUTE_VERBS: Record<string, string> = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE", all: "ANY" };

/** True when `n` is a router expression: a known name or variable, a factory call, or a chain on one. */
export function isRouter(n: AnyNode | undefined, vars: ReadonlySet<string>): boolean {
  if (!n) return false;
  switch (n.type) {
    case "Identifier": return ROUTER_NAMES.has(n.name) || vars.has(n.name);
    case "MemberExpression": return !n.computed && ROUTER_NAMES.has(n.property.name);
    case "NewExpression": return ROUTER_FACTORIES.has(n.callee?.name);
    case "TSAsExpression": case "TSNonNullExpression": case "TSSatisfiesExpression": return isRouter(n.expression, vars);
    case "CallExpression": {
      const c = n.callee;
      if (c?.type === "Identifier") return ROUTER_FACTORIES.has(c.name);
      return c?.type === "MemberExpression" && !c.computed && (c.property.name === "Router" || isRouter(c.object, vars));
    }
    default: return false;
  }
}

/** The variable a router chain starts from, so a sub-router's prefix can be looked up. */
export function routerRoot(n: AnyNode | undefined): string | null {
  if (n?.type === "Identifier") return n.name;
  return n?.type === "CallExpression" && n.callee?.type === "MemberExpression" ? routerRoot(n.callee.object) : null;
}

const staticPath = (n: AnyNode | undefined) => {
  const s = n?.type === "Literal" && typeof n.value === "string" ? n.value : n?.type === "TemplateLiteral" && !n.expressions.length ? n.quasis[0].value.cooked : null;
  return typeof s === "string" && s.startsWith("/") ? s : null;
};

export const joinPath = (prefix: string, path: string) => `${prefix}${path}`.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1") || "/";

/** `/files/*` is the catch-all the matcher spells `**`. */
export const normalizeRoutePath = (p: string) => p.replace(/\/\*$/, "/**");

/** A call such as `app.get("/x", handler)`; the path and a handler argument are what separate it from `map.get("/x")`. */
export function routeCall(x: AnyNode, vars: ReadonlySet<string>, isFn: (n: AnyNode) => boolean): { method: string; path: string; handler: AnyNode } | null {
  const c = x.callee;
  if (x.type !== "CallExpression" || c?.type !== "MemberExpression" || c.computed) return null;
  const method = ROUTE_VERBS[c.property.name];
  const path = staticPath(x.arguments[0]);
  const handler = x.arguments.length > 1 ? x.arguments.at(-1) : null;
  if (!method || path === null || !handler || !isRouter(c.object, vars)) return null;
  const ok = isFn(handler) || handler.type === "Identifier" || (handler.type === "MemberExpression" && handler.object?.type === "Identifier");
  return ok ? { method, path, handler } : null;
}

/** `parent.route("/p", sub)` or `parent.use("/p", sub)`; the sub-router is looked up by name by the caller. */
export function mountCall(x: AnyNode, vars: ReadonlySet<string>): { prefix: string; sub: AnyNode; parent: string | null; strict: boolean } | null {
  const c = x.callee;
  if (x.type !== "CallExpression" || c?.type !== "MemberExpression" || c.computed) return null;
  const name = c.property.name;
  const prefix = staticPath(x.arguments[0]);
  if ((name !== "route" && name !== "use") || prefix === null || !x.arguments[1] || !isRouter(c.object, vars)) return null;
  return { prefix, sub: x.arguments[1], parent: routerRoot(c.object), strict: name === "route" };
}

/** BullMQ declarations: `new Queue(name)` produces, `new Worker(name, handler)` consumes. */
const BULL_PACKAGES = new Set(["bullmq"]);
export function bullDecl(x: AnyNode, imports: ReadonlyMap<string, { spec: string; name: string }>): { kind: "Queue" | "Worker"; nameArg: AnyNode | undefined; handler: AnyNode | undefined } | null {
  if (x.type !== "NewExpression" || x.callee?.type !== "Identifier") return null;
  const imp = imports.get(x.callee.name);
  if (!imp || !BULL_PACKAGES.has(imp.spec) || (imp.name !== "Queue" && imp.name !== "Worker")) return null;
  return { kind: imp.name, nameArg: x.arguments[0], handler: x.arguments[1] };
}
export const BULL_SENDS = new Set(["add", "addBulk"]);

/** Browser-side callers: a global `fetch`, `axios(...)` and `axios.<verb>(...)`. */
export function genericFetch(callee: AnyNode | undefined): { verb?: string } | null {
  if (callee?.type === "Identifier") return callee.name === "fetch" || callee.name === "axios" ? {} : null;
  if (callee?.type === "MemberExpression" && !callee.computed && callee.object?.name === "axios") {
    const verb = ROUTE_VERBS[callee.property.name];
    return verb && verb !== "ANY" ? { verb } : null;
  }
  return null;
}

/** Prisma: client property -> table, and the table operations each client method performs. */
export interface PrismaModel { model: string; table: string; file: string; line: number; refs: string[] }
const PRISMA_OPS: [RegExp, ("read" | "insert" | "update" | "delete")[]][] = [
  [/^create/, ["insert"]], [/^upsert$/, ["insert", "update"]], [/^update/, ["update"]], [/^delete/, ["delete"]],
  [/^(find|count$|aggregate$|groupBy$)/, ["read"]],
];
export const prismaOps = (method: string) => PRISMA_OPS.find(([re]) => re.test(method))?.[1] ?? [];
export const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** Names that hold a Prisma client without any other evidence. */
export const PRISMA_CLIENT_NAME = "prisma";

export function prismaModels(root: string): PrismaModel[] {
  const files: string[] = [];
  const dir = join(root, "prisma");
  if (existsSync(join(dir, "schema.prisma"))) files.push("prisma/schema.prisma");
  if (existsSync(join(dir, "schema"))) for (const f of readdirSync(join(dir, "schema")).sort()) if (f.endsWith(".prisma")) files.push(`prisma/schema/${f}`);
  const out: PrismaModel[] = [];
  const bodies: string[] = [];
  for (const file of files) {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*model\s+(\w+)\s*\{/.exec(lines[i]!);
      if (!m) continue;
      let end = i + 1;
      while (end < lines.length && !/^\s*\}/.test(lines[end]!)) end++;
      const body = lines.slice(i + 1, end).join("\n");
      out.push({ model: m[1]!, table: /@@map\(\s*"([^"]+)"/.exec(body)?.[1] ?? m[1]!, file, line: i + 1, refs: [] });
      bodies.push(body);
    }
  }
  const names = new Set(out.map((o) => o.model));
  out.forEach((o, i) => {
    // A relation field that lists its own `fields:` is the foreign-key side.
    for (const m of bodies[i]!.matchAll(/^[ \t]*\w+[ \t]+(\w+)\??[ \t]+.*@relation\([^)]*fields:/gm)) if (names.has(m[1]!) && m[1] !== o.model) o.refs.push(m[1]!);
  });
  return out;
}
