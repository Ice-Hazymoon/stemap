import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { parseSync } from "oxc-parser";
import { BULL_SENDS, bullDecl, genericFetch, isRouter, joinPath, lowerFirst, mountCall, normalizeRoutePath, pageOf, PRISMA_CLIENT_NAME, prismaModels, prismaOps, routeCall, routeOf, routerRoot, TABLE_FACTORIES } from "./adapters";
import { scriptOf } from "./symbols";
import { CODE_EXT as EXT, sourceRoots, walkFiles } from "./walk";

/**
 * The deterministic layer: every line the link graph draws comes from here or from cited evidence.
 * It reads syntax only, so it misses dynamic dispatch and raw SQL. Those gaps are counted in `stats`,
 * because a missing link must read as "not found", never as "not connected".
 */
export type FnKind = "fn" | "handler" | "queue" | "task" | "module" | "machine";
export type TableOp = "read" | "insert" | "update" | "delete";
export interface Fn { id: number; file: string; name: string; line: number; end: number; exported: boolean; kind: FnKind }
export interface CodeIndex {
  commit: string;
  files: Record<string, { lines: number; module: string | null }>;
  fns: Fn[];
  /** Adjacency by fn id: the direct callees of each function. */
  calls: number[][];
  tables: { name: string; ts: string; file: string; line: number; refs: string[] }[];
  tableOps: { table: string; op: TableOp; fn: number; line: number }[];
  routes: { method: string; path: string; file: string; fn: number | null }[];
  routeCalls: { fn: number; line: number; method: string; path: string; route: number }[];
  pages: { path: string; file: string }[];
  queues: { name: string; file: string; line: number; consumer: number | null }[];
  sends: { queue: string; fn: number; line: number }[];
  /** Page moves stay apart from calls: a link to a page is not a dependency on that page. */
  navs: { fn: number; page: string }[];
  imports: [string, string][];
  stats: Record<string, number>;
}

type AnyNode = Record<string, any>;
interface FileScan {
  path: string;
  lines: number;
  imports: Map<string, { spec: string; name: string }>;
  exports: Map<string, { local?: string; from?: string; name?: string }>;
  stars: string[];
  fnIds: Map<string, number>;
  strings: Map<string, string>;
  refs: { fn: number; name: string; member?: string }[];
  components: string[];
}

const lineTable = (code: string) => {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") starts.push(i + 1);
  return (pos: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m]! <= pos) lo = m; else hi = m - 1; }
    return lo + 1;
  };
};

/** Child nodes worth reading: types carry no runtime link, and a property name is not a reference. */
function children(n: AnyNode): AnyNode[] {
  if (n.type === "MemberExpression") return n.computed ? [n.object, n.property] : [n.object];
  if (n.type === "Property" || n.type === "ObjectProperty") return n.computed ? [n.key, n.value] : [n.value];
  const out: AnyNode[] = [];
  for (const k in n) {
    const v = n[k];
    if (k === "typeAnnotation" || k === "returnType" || k === "typeParameters" || k === "typeArguments") continue;
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === "string") out.push(x); }
    else if (v && typeof v.type === "string") out.push(v);
  }
  return out;
}

const isTypeNode = (n: AnyNode) => /^TS(?!As|NonNull|Satisfies|ParameterProperty|Instantiation)/.test(n.type);
/** `skip` holds nodes another body owns; the walk stops at them unless one is the root. */
const walk = (n: AnyNode, f: (x: AnyNode) => void, skip?: Set<AnyNode>, root: AnyNode = n) => {
  if (isTypeNode(n) || (skip?.has(n) && n !== root)) return;
  f(n);
  for (const c of children(n)) walk(c, f, skip, root);
};
const containsFunction = (n: AnyNode) => {
  let hit = false;
  walk(n, (x) => { if (/Function|ArrowFunction/.test(x.type)) hit = true; });
  return hit;
};
/** Parameter names of a function node, or of the callback a wrapper call such as `defineHandler(fn)` carries. */
const paramNames = (n: AnyNode): string[] => {
  const f = /Function/.test(n.type) ? n : n.type === "CallExpression" ? n.arguments.find((a: AnyNode) => /Function/.test(a.type)) : null;
  return (f?.params ?? []).map((p: AnyNode) => (p.type === "AssignmentPattern" ? p.left?.name : p.name) ?? "");
};
/** A statement keyword with the table token that follows it; the token may be a placeholder for an interpolation. */
const SQL_WRITE = /\b(insert\s+into|delete\s+from)\s+(\S+)|\bupdate\s+(\S+)(?:\s+as\s+\w+)?\s+set\b/gi;
const staticString = (n: AnyNode | undefined): string | null => {
  if (!n) return null;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TemplateLiteral" && !n.expressions.length) return n.quasis[0].value.cooked;
  return null;
};
/** `/api/a/${id}/b` becomes `/api/a/:p/b`, which is what route matching compares. */
const pathOf = (n: AnyNode | undefined, strings: Map<string, string>): string | null => {
  if (!n) return null;
  if (n.type === "TSAsExpression" || n.type === "TSNonNullExpression" || n.type === "TSSatisfiesExpression") return pathOf(n.expression, strings);
  const s = staticString(n);
  if (s !== null) return s;
  if (n.type === "Identifier") return strings.get(n.name) ?? null;
  if (n.type === "TemplateLiteral") return n.quasis.map((q: AnyNode, i: number) => q.value.cooked + (i < n.expressions.length ? ":p" : "")).join("");
  return null;
};
const optionMethod = (n: AnyNode | undefined) => {
  if (n?.type !== "ObjectExpression") return "GET";
  for (const p of n.properties) if (p.key?.name === "method") return (staticString(p.value) ?? "GET").toUpperCase();
  return "GET";
};

/** Nuxt writes its auto-import tables under .nuxt, which `git archive` leaves out. */
function autoImports(repo: string) {
  const app = new Map<string, { file: string; name: string }>();
  const server = new Map<string, { file: string; name: string }>();
  const comps = new Map<string, string>();
  const read = (p: string) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), "utf8") : "");
  for (const m of read(".nuxt/imports.d.ts").matchAll(/export \{ ([^}]+) \} from '([^']+)'/g)) {
    if (!m[2]!.startsWith(".")) continue;
    const file = normalize(join(".nuxt", m[2]!));
    for (const part of m[1]!.split(",")) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (orig) app.set(alias ?? orig, { file, name: orig });
    }
  }
  for (const m of read(".nuxt/types/nitro-imports.d.ts").matchAll(/const (\w+): typeof import\('([^']+)'\)(?:\['(\w+)'\]|\.(\w+))/g)) {
    if (m[2]!.startsWith(".")) server.set(m[1]!, { file: normalize(join(".nuxt/types", m[2]!)), name: m[3] ?? m[4] ?? m[1]! });
  }
  for (const m of read(".nuxt/components.d.ts").matchAll(/export const (\w+): typeof import\("([^"]+)"\)/g)) {
    if (m[2]!.startsWith(".") && !m[1]!.startsWith("Lazy")) comps.set(m[1]!, normalize(join(".nuxt", m[2]!)));
  }
  return { app, server, comps, generated: app.size + server.size + comps.size > 0 };
}

/** Top-level composables and utils, all of `server/utils`, and every component by its path name. */
function conventionImports(scans: Map<string, FileScan>, auto: ReturnType<typeof autoImports>) {
  for (const [path, scan] of scans) {
    const rel = path.replace(/^app\//, "");
    const app = /^(composables|utils)\/[^/]+\.[mc]?[tj]s$/.test(rel) || /^(composables|utils)\/[^/]+\/index\.[mc]?[tj]s$/.test(rel);
    const server = path.startsWith("server/utils/");
    if (app || server) for (const name of scan.exports.keys()) (server ? auto.server : auto.app).set(name, { file: path, name });
    const comp = /^components\/(.+)\.vue$/.exec(rel);
    if (comp) auto.comps.set(comp[1]!.split("/").map((p) => p.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase())).join(""), path);
  }
}

export interface IndexInput {
  /** Directory that holds the commit's files. */
  root: string;
  commit: string;
  /** Working tree, for generated files `git archive` leaves out. */
  repo: string;
  include?: string[];
  moduleOf: (file: string) => string | null;
}

export function buildIndex({ root, commit, repo, include, moduleOf }: IndexInput): CodeIndex {
  const paths: string[] = [];
  for (const r of sourceRoots(root, include)) walkFiles(root, r, paths);
  const known = new Set(paths);
  const stats: Record<string, number> = { routeMountsUnresolved: 0, files: paths.length, parseErrors: 0, apiCalls: 0, apiCallsResolved: 0, apiCallsDynamic: 0, refsResolved: 0, rawSql: 0 };
  const auto = autoImports(repo);
  const pkgs = new Map<string, string>();
  const pkgDir = join(root, "packages");
  for (const d of existsSync(pkgDir) ? readdirSync(pkgDir) : []) {
    const p = join(pkgDir, d, "package.json");
    if (existsSync(p)) pkgs.set(JSON.parse(readFileSync(p, "utf8")).name, `packages/${d}`);
  }

  const fns: Fn[] = [];
  const direct: { fn: number; to: number }[] = [];
  const scans = new Map<string, FileScan>();
  const rawTables: CodeIndex["tables"] = [];
  const rawOps: { ts: string; op: TableOp; fn: number; line: number }[] = [];
  // A raw `sql` write names its table as plain text (`sql`) or through an interpolation (`ts`).
  const rawSqlOps: { ts?: string; sql?: string; op: TableOp; fn: number; line: number }[] = [];
  const fnParams = new Map<number, string[]>();
  // Calls that pass a literal or an identifier, kept so a queue-name wrapper can be matched to its callers.
  const sites: { file: string; fn: number; line: number; callee: string; args: ({ s?: string; id?: string; obj?: string } | null)[] }[] = [];
  const rawCalls: { fn: number; line: number; method: string; path: string }[] = [];
  // `handler` names a consumer passed by reference; `producer` marks a bare `new Queue`, which a Worker of the same name replaces.
  const rawQueues: { name: string | null; ref: string | null; file: string; line: number; fn: number | null; handler?: string; producer?: boolean }[] = [];
  const rawRoutes: { method: string; path: string; file: string; fn: number | null; handler?: string; root?: string | null }[] = [];
  const crossMounts: { file: string; name: string; prefix: string; root: string | null; strict: boolean }[] = [];
  const prisma = prismaModels(root);
  const prismaClient = new Map(prisma.map((m) => [lowerFirst(m.model), m.model]));
  for (const m of prisma) rawTables.push({ name: m.table, ts: m.model, file: m.file, line: m.line, refs: m.refs });
  const rawSends: { name: string | null; ref: string | null; owner: string | null; param: number; fn: number; line: number; file: string }[] = [];
  const rawNavs: { fn: number; path?: string; key?: string }[] = [];
  const routeTable = new Map<string, string>();

  for (const path of paths) {
    const code = readFileSync(join(root, path), "utf8");
    const isVue = path.endsWith(".vue");
    const script = isVue ? scriptOf(code) : code;
    const scan: FileScan = { path, lines: code.split("\n").length, imports: new Map(), exports: new Map(), stars: [], fnIds: new Map(), strings: new Map(), refs: [], components: [] };
    scans.set(path, scan);
    // Plain .js files in React repos carry JSX, so every non-TypeScript extension parses as jsx.
    const lang = path.endsWith(".tsx") ? "tsx" : /\.[mc]?jsx?$/.test(path) ? "jsx" : "ts";
    const parsed = parseSync(isVue ? `${path}.ts` : path, script, { sourceType: "module", lang });
    if (parsed.errors.some((e: { severity: string }) => e.severity === "Error")) stats.parseErrors!++;
    const lineOf = lineTable(script);
    const define = (name: string, node: AnyNode, kind: FnKind, exported: boolean) => {
      const f: Fn = { id: fns.length, file: path, name, line: lineOf(node.start), end: lineOf(node.end), exported, kind };
      fns.push(f);
      scan.fnIds.set(name, f.id);
      return f;
    };
    const moduleFn = define("<module>", parsed.program, "module", false);
    moduleFn.line = 1;
    const bodies: [AnyNode, number][] = [];

    const aliases = new Map<string, string>();
    const tableOf = (a: AnyNode | undefined): string | null => (a?.type === "MemberExpression" && a.object?.name === "tables" && !a.computed ? a.property.name : null);
    const navArg = (fn: number, a: AnyNode | undefined) => {
      if (a?.type === "ObjectExpression") { navArg(fn, a.properties.find((p: AnyNode) => p.key?.name === "path")?.value); return; }
      if (a?.type === "CallExpression" && a.callee?.name === "localePath") return;
      if (a?.type === "MemberExpression" && a.object?.name === "appRoutes") { rawNavs.push({ fn, key: a.property.name }); return; }
      const p = pathOf(a, scan.strings);
      if (p?.startsWith("/")) rawNavs.push({ fn, path: p.split(/[?#]/)[0]! });
    };
    const routers = new Set<string>();
    const clients = new Set<string>();
    // Variable -> the queue it was created for, as written (`this.q` is keyed "this.q").
    const queueVars = new Map<string, { name: string | null; ref: string | null }>();
    const tableRef = (a: AnyNode | undefined) => {
      if (a?.type === "Identifier") {
        const imp = scan.imports.get(a.name);
        // An import alias is a different spelling of the same table binding.
        return (aliases.get(a.name) ?? (imp && imp.name !== "default" && imp.name !== "*" ? imp.name : a.name)) as string;
      }
      if (a?.type === "MemberExpression" && !a.computed && (a.object?.name === "tables" || scan.imports.get(a.object?.name)?.name === "*")) return a.property.name as string;
      if (a?.type === "TSAsExpression" || a?.type === "TSNonNullExpression") return tableRef(a.expression);
      return null;
    };
    const queueKey = (n: AnyNode | undefined) => (n?.type === "Identifier" ? n.name : n?.type === "MemberExpression" && n.object?.type === "ThisExpression" ? `this.${n.property.name}` : null);
    /** Records what a binding holds: a router, a Prisma client or a BullMQ queue. */
    const noteBinding = (target: string | null, init: AnyNode | undefined) => {
      if (!target || !init) return;
      if (init.type !== "Identifier" && isRouter(init, routers)) routers.add(target);
      if (init.type === "NewExpression" && init.callee?.name === "PrismaClient") clients.add(target);
      const q = bullDecl(init, scan.imports);
      if (q?.kind === "Queue") queueVars.set(target, { name: staticString(q.nameArg), ref: q.nameArg?.name ?? null });
    };
    const claim = (node: AnyNode, name: string, exported: boolean) => {
      const init = node;
      noteBinding(name, init);
      if (init.type === "CallExpression" && TABLE_FACTORIES.has(init.callee?.name)) {
        const sql = staticString(init.arguments[0]);
        if (sql) {
          const refs = new Set<string>();
          walk(init, (x) => {
            if (x.type === "CallExpression" && x.callee?.property?.name === "references") {
              const fn = x.arguments[0];
              const body = fn?.body;
              if (body?.type === "MemberExpression") { const t = tableRef(body.object); if (t) refs.add(t); }
            }
          });
          rawTables.push({ name: sql, ts: name, file: path, line: lineOf(node.start), refs: [...refs] });
        }
        return;
      }
      const s = staticString(init);
      if (s !== null) { scan.strings.set(name, s); return; }
      const aliased = tableOf(init);
      if (aliased) { aliases.set(name, aliased); return; }
      // defineStateMachine({ table }) writes through a generic helper, so the binding is the only trace.
      const bound = init.type === "CallExpression" ? init.arguments[0]?.properties?.find((p: AnyNode) => p.key?.name === "table")?.value : null;
      if (bound && tableOf(bound)) {
        const f = define(name, init, "machine", exported);
        rawOps.push({ ts: tableOf(bound)!, op: "update", fn: f.id, line: f.line });
        return;
      }
      const plain = init.type === "TSAsExpression" || init.type === "TSSatisfiesExpression" ? init.expression : init;
      if (name === "appRoutes" && plain.type === "ObjectExpression") {
        for (const p of plain.properties) { const v = staticString(p.value); if (p.key?.name && v) routeTable.set(p.key.name, v); }
      }
      const callee = init.type === "CallExpression" ? init.callee?.name : null;
      // A queue whose handler is passed by reference holds no inline function but is still a consumer.
      if (callee !== "defineJobQueue" && !containsFunction(init)) { bodies.push([init, moduleFn.id]); return; }
      const kind: FnKind = callee === "defineJobQueue" ? "queue" : callee === "defineTask" ? "task" : /^define\w*Handler$/.test(callee ?? "") ? "handler" : "fn";
      const f = define(name, init, kind, exported);
      bodies.push([init, f.id]);
      if (kind === "queue") {
        const opt = init.arguments[0];
        const nameProp = opt?.properties?.find((p: AnyNode) => p.key?.name === "name")?.value;
        rawQueues.push({ name: staticString(nameProp), ref: nameProp?.name ?? null, file: path, line: lineOf(init.start), fn: f.id });
      }
    };
    const statement = (s: AnyNode, exported: boolean) => {
      if (s.type === "FunctionDeclaration" && s.id) { const f = define(s.id.name, s, "fn", exported); bodies.push([s, f.id]); return; }
      if (s.type === "ClassDeclaration" && s.id) { const f = define(s.id.name, s, "fn", exported); bodies.push([s, f.id]); return; }
      if (s.type === "VariableDeclaration") {
        for (const d of s.declarations) {
          if (d.id?.type === "Identifier" && d.init) claim(d.init, d.id.name, exported);
          else if (d.init) bodies.push([d.init, moduleFn.id]);
        }
        return;
      }
      bodies.push([s, moduleFn.id]);
    };

    for (const s of parsed.program.body as AnyNode[]) {
      if (s.type === "ImportDeclaration") {
        if (s.importKind === "type") continue;
        for (const sp of s.specifiers ?? []) {
          if (sp.importKind === "type") continue;
          const name = sp.type === "ImportDefaultSpecifier" ? "default" : sp.type === "ImportNamespaceSpecifier" ? "*" : (sp.imported?.name ?? sp.imported?.value);
          scan.imports.set(sp.local.name, { spec: s.source.value, name });
        }
      } else if (s.type === "ExportAllDeclaration") {
        if (s.exportKind !== "type") scan.stars.push(s.source.value);
      } else if (s.type === "ExportNamedDeclaration") {
        if (s.declaration) {
          statement(s.declaration, true);
          const d = s.declaration;
          for (const v of d.declarations ?? []) if (v.id?.name) scan.exports.set(v.id.name, { local: v.id.name });
          if (d.id?.name) scan.exports.set(d.id.name, { local: d.id.name });
        }
        for (const sp of s.specifiers ?? []) {
          const out = sp.exported?.name ?? sp.exported?.value;
          const inner = sp.local?.name ?? sp.local?.value;
          scan.exports.set(out, s.source ? { from: s.source.value, name: inner } : { local: inner });
        }
      } else if (s.type === "ExportDefaultDeclaration") {
        const d = s.declaration;
        if (d.type === "Identifier") scan.exports.set("default", { local: d.name });
        else {
          const c = d.type === "CallExpression" ? d.callee?.name : null;
          const kind: FnKind = c === "defineTask" ? "task" : /^define\w*Handler$/.test(c ?? "") ? "handler" : "fn";
          const f = define("default", d, kind, true);
          scan.exports.set("default", { local: "default" });
          bodies.push([d, f.id]);
        }
      } else statement(s, false);
    }

    for (const [body] of bodies) {
      walk(body, (x) => {
        if (x.type === "VariableDeclarator" && x.id?.type === "Identifier") { const t = tableOf(x.init); if (t) aliases.set(x.id.name, t); noteBinding(x.id.name, x.init); }
        if (x.type === "AssignmentExpression") noteBinding(queueKey(x.left), x.right);
        if (x.type === "PropertyDefinition" && x.value && x.key?.name) noteBinding(`this.${x.key.name}`, x.value);
      });
    }
    // Handlers written inline get their own function, so their calls and table writes hang on the route, not the module.
    const claimed = new Set<AnyNode>();
    const mounts = new Map<string, { prefix: string; parent: string | null }>();
    const found: { method: string; path: string; recv: string | null; handler: AnyNode }[] = [];
    // `app.route("/api", imported)`: the router lives in another file, so this resolves once every file is read.
    const remoteMounts: { name: string; prefix: string; parent: string | null; strict: boolean }[] = [];
    const isFn = (n: AnyNode) => /Function/.test(n.type) || (n.type === "CallExpression" && containsFunction(n));
    const inline = (node: AnyNode, name: string) => {
      const f = define(name, node, "handler", false);
      bodies.push([node, f.id]);
      claimed.add(node);
      return f.id;
    };
    for (const [body] of [...bodies]) {
      walk(body, (x) => {
        const mount = mountCall(x, routers);
        if (mount) {
          const sub = mount.sub.type === "Identifier" && routers.has(mount.sub.name) ? mount.sub.name : null;
          if (sub) mounts.set(sub, { prefix: mount.prefix, parent: mount.parent });
          else if (mount.sub.type === "Identifier") remoteMounts.push({ name: mount.sub.name, prefix: mount.prefix, parent: mount.parent, strict: mount.strict });
          else if (mount.strict) stats.routeMountsUnresolved!++;
        }
        const r = routeCall(x, routers, isFn);
        if (r) found.push({ method: r.method, path: r.path, recv: routerRoot(x.callee.object), handler: r.handler });
        const q = bullDecl(x, scan.imports);
        if (q) {
          const name = staticString(q.nameArg);
          const base = { name, ref: q.nameArg?.name ?? null, file: path, line: lineOf(x.start) };
          if (q.kind === "Queue") rawQueues.push({ ...base, fn: null, producer: true });
          else if (q.handler && isFn(q.handler)) rawQueues.push({ ...base, fn: inline(q.handler, `worker ${name ?? base.ref ?? ""}`.trim()) });
          else rawQueues.push({ ...base, fn: null, handler: q.handler?.name });
        }
      });
    }
    // Sub-routers prefix their routes; the chain of mounts is followed to its root.
    const prefixOf = (name: string | null, depth = 0): string => {
      const m = name ? mounts.get(name) : undefined;
      return m && depth < 8 ? joinPath(prefixOf(m.parent, depth + 1), m.prefix) : "";
    };
    const rootOf = (name: string | null, depth = 0): string | null => {
      const m = name ? mounts.get(name) : undefined;
      return m && depth < 8 ? rootOf(m.parent, depth + 1) : name;
    };
    for (const m of remoteMounts) crossMounts.push({ file: path, name: m.name, prefix: joinPath(prefixOf(m.parent), m.prefix), root: rootOf(m.parent), strict: m.strict });
    for (const r of found) {
      const full = normalizeRoutePath(joinPath(prefixOf(r.recv), r.path));
      const isInline = isFn(r.handler);
      const fn = isInline ? inline(r.handler, `${r.method} ${full}`) : null;
      rawRoutes.push({ method: r.method, path: full, file: path, fn, handler: !isInline && r.handler.type === "Identifier" ? r.handler.name : undefined, root: rootOf(r.recv) });
    }
    /** `<client>.<model>.<method>(...)` where the client is accepted by `isClient`. */
    const recordPrisma = (x: AnyNode, fn: number, isClient: (c: AnyNode) => boolean) => {
      const c = x.type === "CallExpression" ? x.callee : null;
      const m = c?.type === "MemberExpression" && !c.computed && c.object?.type === "MemberExpression" && !c.object.computed ? c.object : null;
      const model = m ? prismaClient.get(m.property.name) : undefined;
      if (!model || !(m!.object?.type === "Identifier" ? isClient(m!.object) : m!.object?.property?.name === PRISMA_CLIENT_NAME)) return;
      for (const op of prismaOps(c.property.name)) rawOps.push({ ts: model, op, fn, line: lineOf(c.property.start) });
    };
    for (const [body, fn] of bodies) {
      const params = paramNames(body);
      if (params.length) fnParams.set(fn, params);
      walk(body, (x) => {
        if (x.type === "Identifier") scan.refs.push({ fn, name: x.name });
        if (x.type === "MemberExpression" && !x.computed && x.object?.type === "Identifier") scan.refs.push({ fn, name: x.object.name, member: x.property.name });
        if (x.type === "TaggedTemplateExpression" && x.tag?.name === "sql") {
          stats.rawSql!++;
          const text = x.quasi.quasis.map((q: AnyNode, i: number) => q.value.cooked + (i < x.quasi.expressions.length ? `\u0001${i}\u0001` : "")).join("");
          for (const m of text.matchAll(SQL_WRITE)) {
            const op: TableOp = m[1] ? (m[1].toLowerCase().startsWith("insert") ? "insert" : "delete") : "update";
            const tok = (m[2] ?? m[3])!;
            const hole = /^\u0001(\d+)\u0001/.exec(tok);
            const line = lineOf(x.start);
            if (hole) { const t = tableRef(x.quasi.expressions[Number(hole[1])]); rawSqlOps.push({ ts: t ?? undefined, op, fn, line }); }
            else rawSqlOps.push({ sql: tok.replace(/["`;,)]/g, "").replace(/^public\./, ""), op, fn, line });
          }
        }
        if (x.type === "MemberExpression" && !x.computed && x.object?.type === "MemberExpression" && x.object.property?.name === "query" && !x.object.computed) {
          rawOps.push({ ts: x.property.name, op: "read", fn, line: lineOf(x.start) });
        }
        if (x.type !== "CallExpression") return;
        const callee = x.callee;
        const prop = callee?.type === "MemberExpression" && !callee.computed ? callee.property.name : null;
        const OPS: Record<string, TableOp> = { from: "read", innerJoin: "read", leftJoin: "read", rightJoin: "read", fullJoin: "read", insert: "insert", update: "update", delete: "delete" };
        if (prop && OPS[prop]) {
          const t = tableRef(x.arguments[0]);
          // A chained query starts lines above the table it names, so the line comes from the method.
          if (t) rawOps.push({ ts: t, op: OPS[prop]!, fn, line: lineOf(callee.property.start) });
        }
        recordPrisma(x, fn, (c) => clients.has(c.name) || c.name === PRISMA_CLIENT_NAME);
        if (prop === "$transaction") {
          const cb = x.arguments[0];
          const tx = /Function/.test(cb?.type ?? "") ? paramNames(cb)[0] : null;
          if (tx) walk(cb, (y) => recordPrisma(y, fn, (c) => c.name === tx));
        }
        const queue = BULL_SENDS.has(prop ?? "") ? queueVars.get(queueKey(callee.object) ?? "") : undefined;
        if (queue) rawSends.push({ name: queue.name, ref: queue.ref, owner: null, param: -1, fn, line: lineOf(x.start), file: path });
        const name = prop ?? callee?.name;
        const generic = genericFetch(callee);
        if (generic || name === "$api" || name === "$fetch" || name === "useFetch" || name === "useLazyFetch" || name === "adminFetch") {
          stats.apiCalls!++;
          const p = pathOf(x.arguments[0], scan.strings);
          const method = generic?.verb ?? (name === "adminFetch" ? (staticString(x.arguments[1]) ?? "GET").toUpperCase() : optionMethod(x.arguments[1]));
          if (p === null) stats.apiCallsDynamic!++;
          else if (p.startsWith("/")) rawCalls.push({ fn, line: lineOf(x.start), method, path: p.split("?")[0]! });
        }
        if (name === "navigateTo" || name === "localePath" || (prop === "push" && callee.object?.name === "router")) navArg(fn, x.arguments[0]);
        if (callee?.name === "sendJob") {
          const a = x.arguments[0];
          const own = a?.type === "MemberExpression" && !a.computed && a.property.name === "name" && a.object?.type === "Identifier" ? a.object.name : null;
          const param = a?.type === "Identifier" ? params.indexOf(a.name) : -1;
          rawSends.push({ name: staticString(a), ref: a?.type === "Identifier" ? a.name : null, owner: own, param, fn, line: lineOf(x.start), file: path });
        } else if (callee?.type === "Identifier" && x.arguments.length) {
          const args = x.arguments.slice(0, 4).map((a: AnyNode) => {
            const s = staticString(a);
            return s !== null ? { s } : a.type === "Identifier" ? { id: a.name as string } : null;
          });
          if (args.some(Boolean)) sites.push({ file: path, fn, line: lineOf(x.start), callee: callee.name, args });
        }
      }, claimed);
    }
    if (isVue) {
      for (const m of code.matchAll(/<([A-Z][A-Za-z0-9]+|[a-z]+(?:-[a-z0-9]+)+)[\s>/]/g)) {
        const name = m[1]!.includes("-") ? m[1]!.split("-").map((p) => p[0]!.toUpperCase() + p.slice(1)).join("") : m[1]!;
        scan.components.push(name);
      }
      const open = code.indexOf("<template");
      if (open >= 0) {
        const tpl = code.slice(open);
        for (const m of tpl.matchAll(/\bto="(\/[^"#?]*)|localePath\('(\/[^'#?]*)/g)) rawNavs.push({ fn: moduleFn.id, path: m[1] ?? m[2]! });
        for (const m of tpl.matchAll(/\bappRoutes\.(\w+)/g)) rawNavs.push({ fn: moduleFn.id, key: m[1]! });
      }
      // The template reaches every script function, and static analysis cannot see which.
      for (const [name, id] of scan.fnIds) if (name !== "<module>") direct.push({ fn: moduleFn.id, to: id });
    }
  }

  const specFile = (from: string, spec: string): string | null => {
    const pkg = /^(packages\/[^/]+)\//.exec(from)?.[1] ?? "";
    let base: string | null = null;
    if (spec.startsWith(".")) base = normalize(join(dirname(from), spec));
    else if (spec.startsWith("#server/")) base = join(pkg, "server", spec.slice(8));
    else if (spec.startsWith("#shared/")) base = join(pkg, "shared", spec.slice(8));
    else if (spec.startsWith("~~/") || spec.startsWith("@@/")) base = spec.slice(3);
    else if (spec.startsWith("~/") || spec.startsWith("@/")) base = join(pkg, "app", spec.slice(2));
    else for (const [name, dir] of pkgs) {
      if (spec === name) base = `${dir}/src/index`;
      else if (spec.startsWith(`${name}/`)) base = `${dir}/src/${spec.slice(name.length + 1)}`;
    }
    if (!base) return null;
    const tries = [base, ...EXT.map((e) => base + e), ...EXT.map((e) => `${base}/index${e}`)];
    const rootless = base.replace(/^packages\/[^/]+\//, "");
    if (pkg) tries.push(...EXT.map((e) => rootless + e), ...EXT.map((e) => `${rootless}/index${e}`));
    return tries.find((t) => known.has(t)) ?? null;
  };

  const seen = new Set<string>();
  const resolveExport = (file: string, name: string): number | null => {
    const key = `${file}\0${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    try {
      const s = scans.get(file);
      if (!s) return null;
      const e = s.exports.get(name);
      if (e?.from) { const f = specFile(file, e.from); return f ? resolveExport(f, e.name ?? name) : null; }
      if (e?.local) {
        const id = s.fnIds.get(e.local);
        if (id !== undefined) return id;
        const imp = s.imports.get(e.local);
        if (imp) { const f = specFile(file, imp.spec); return f ? resolveExport(f, imp.name) : null; }
        return null;
      }
      for (const st of s.stars) {
        const f = specFile(file, st);
        const r = f ? resolveExport(f, name) : null;
        if (r !== null) return r;
      }
      return null;
    } finally { seen.delete(key); }
  };

  // A name used from another file resolves the same way a call does: local, import, then auto-import.
  const fnNamed = (file: string, name: string): number | null => {
    const sc = scans.get(file)!;
    const local = sc.fnIds.get(name);
    if (local !== undefined) return local;
    const imp = sc.imports.get(name);
    if (imp) { const f = specFile(file, imp.spec); return f && imp.name !== "*" ? resolveExport(f, imp.name) : null; }
    const a = (file.startsWith("server/") || file.includes("/server/") ? auto.server : auto.app).get(name);
    return a && known.has(a.file) ? resolveExport(a.file, a.name) : null;
  };

  // CI has no `.nuxt`, so the same tables are rebuilt from Nuxt's folder conventions.
  if (!auto.generated && ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs"].some((f) => existsSync(join(root, f)))) conventionImports(scans, auto);

  /** The local name a file exports under `name`, following re-exports, so a mount finds the router behind an import. */
  const exportedLocal = (file: string, name: string, depth = 0): { file: string; local: string } | null => {
    const e = scans.get(file)?.exports.get(name);
    if (!e || depth > 6) return null;
    if (e.local) {
      const via = scans.get(file)!.imports.get(e.local);
      const next = via ? specFile(file, via.spec) : null;
      return next ? exportedLocal(next, via!.name, depth + 1) : { file, local: e.local };
    }
    const next = e.from ? specFile(file, e.from) : null;
    return next ? exportedLocal(next, e.name ?? name, depth + 1) : null;
  };
  const mountedAt = new Map<string, { file: string; root: string | null; prefix: string }>();
  for (const m of crossMounts) {
    const imp = scans.get(m.file)!.imports.get(m.name);
    const target = imp ? specFile(m.file, imp.spec) : null;
    const local = target ? exportedLocal(target, imp!.name) : null;
    if (local) mountedAt.set(`${local.file}\0${local.local}`, m);
    else if (m.strict) stats.routeMountsUnresolved!++;
  }
  const remotePrefix = (file: string, root: string | null, depth = 0): string => {
    const m = root && depth < 8 ? mountedAt.get(`${file}\0${root}`) : undefined;
    return m ? joinPath(remotePrefix(m.file, m.root, depth + 1), m.prefix) : "";
  };
  for (const r of rawRoutes) {
    const prefix = remotePrefix(r.file, r.root ?? null);
    if (!prefix) continue;
    r.path = normalizeRoutePath(joinPath(prefix, r.path));
    if (r.fn !== null) fns[r.fn]!.name = `${r.method} ${r.path}`;
  }

  const importEdges = new Set<string>();
  const adj = new Map<number, Set<number>>();
  const addCall = (a: number, b: number) => { if (a === b) return; (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b); };
  for (const d of direct) addCall(d.fn, d.to);
  const defaultOf = (file: string) => { const s = scans.get(file); return s ? s.fnIds.get("default") ?? s.fnIds.get("<module>") ?? null : null; };

  for (const s of scans.values()) {
    for (const imp of s.imports.values()) {
      const f = specFile(s.path, imp.spec);
      if (f) importEdges.add(`${s.path}\0${f}`);
    }
    const autos = s.path.includes("/server/") || s.path.startsWith("server/") ? auto.server : auto.app;
    for (const r of s.refs) {
      const local = s.fnIds.get(r.name);
      if (local !== undefined) { addCall(r.fn, local); continue; }
      const imp = s.imports.get(r.name);
      if (imp) {
        const file = specFile(s.path, imp.spec);
        if (!file) continue;
        const target = imp.name === "*" ? (r.member ? resolveExport(file, r.member) : null) : resolveExport(file, imp.name);
        if (target !== null) { addCall(r.fn, target); stats.refsResolved!++; }
        continue;
      }
      const a = autos.get(r.name);
      if (a && known.has(a.file)) {
        const target = resolveExport(a.file, a.name);
        if (target !== null) { addCall(r.fn, target); stats.refsResolved!++; }
      }
    }
    const moduleId = s.fnIds.get("<module>")!;
    for (const c of s.components) {
      const file = auto.comps.get(c);
      if (!file || !known.has(file)) continue;
      importEdges.add(`${s.path}\0${file}`);
      const t = defaultOf(file);
      if (t !== null) addCall(moduleId, t);
    }
    for (const [local, imp] of s.imports) {
      if (imp.spec === "#components" && auto.comps.has(imp.name)) {
        const file = auto.comps.get(imp.name)!;
        if (known.has(file)) { const t = defaultOf(file); if (t !== null) addCall(moduleId, t); }
        void local;
      } else if (imp.spec.endsWith(".vue")) {
        const file = specFile(s.path, imp.spec);
        const t = file ? defaultOf(file) : null;
        if (t !== null) addCall(moduleId, t);
      }
    }
  }

  const routes: CodeIndex["routes"] = paths.flatMap((f) =>
    routeOf(f, scans.get(f)!.exports.keys()).map((r) => ({ method: r.method, path: r.path, file: f, fn: r.handler ? resolveExport(f, r.handler) : defaultOf(f) })));
  for (const r of rawRoutes) routes.push({ method: r.method, path: r.path, file: r.file, fn: r.fn ?? (r.handler ? fnNamed(r.file, r.handler) : null) });
  const pages = paths.flatMap((f) => { const p = pageOf(f); return p ? [{ path: p, file: f }] : []; });

  const segs = routes.map((r) => r.path.split("/"));
  const matchRoute = (method: string, path: string) => {
    const want = path.split("/");
    let best = -1, bestScore = -1;
    routes.forEach((r, i) => {
      if (r.method !== method && r.method !== "ANY") return;
      const have = segs[i]!;
      const star = have.at(-1) === "**";
      if (star ? want.length < have.length - 1 : want.length !== have.length) return;
      let score = r.method === method ? 1 : 0;
      for (let k = 0; k < (star ? have.length - 1 : have.length); k++) {
        const a = have[k]!, b = want[k]!;
        if (a === b) score += 4;
        else if (a.startsWith(":") || b === ":p") score += 1;
        else return;
      }
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best;
  };
  const routeCalls: CodeIndex["routeCalls"] = [];
  for (const c of rawCalls) {
    const i = matchRoute(c.method, c.path);
    if (i < 0) continue;
    stats.apiCallsResolved!++;
    routeCalls.push({ ...c, path: routes[i]!.path, route: i });
    const t = routes[i]!.fn;
    if (t !== null) addCall(c.fn, t);
  }

  const pageSegs = pages.filter((p) => !p.path.startsWith("admin:")).map((p) => ({ file: p.file, parts: p.path.split("/") }));
  const matchPage = (path: string) => {
    const want = path.replace(/\/$/, "").split("/");
    let best: string | null = null, bestScore = -1;
    for (const p of pageSegs) {
      const star = p.parts.at(-1) === "**";
      if (star ? want.length < p.parts.length - 1 : want.length !== p.parts.length) continue;
      let score = 0, ok = true;
      for (let k = 0; k < (star ? p.parts.length - 1 : p.parts.length) && ok; k++) {
        const a = p.parts[k]!, b = want[k]!;
        if (a === b) score += 4; else if (a.startsWith(":") || b === ":p") score += 1; else ok = false;
      }
      if (ok && score > bestScore) { bestScore = score; best = p.file; }
    }
    return best;
  };
  const navSeen = new Set<string>();
  const navs = rawNavs.flatMap((n) => {
    const path = n.path ?? (n.key ? routeTable.get(n.key) : undefined);
    const page = path ? matchPage(path) : null;
    if (!page || navSeen.has(`${n.fn}|${page}`)) return [];
    navSeen.add(`${n.fn}|${page}`);
    return [{ fn: n.fn, page }];
  });

  const tsToSql = new Map(rawTables.map((t) => [t.ts, t.name]));
  const tables = rawTables.map((t) => ({ ...t, refs: t.refs.flatMap((r) => { const s = tsToSql.get(r); return s ? [s] : []; }) }));
  const opSeen = new Set<string>();
  const sqlNames = new Set(rawTables.map((t) => t.name));
  const tableOps = rawOps.flatMap((o) => {
    const table = tsToSql.get(o.ts);
    const key = `${table}|${o.op}|${o.fn}|${o.line}`;
    if (!table || opSeen.has(key)) return [];
    opSeen.add(key);
    return [{ table, op: o.op, fn: o.fn, line: o.line }];
  });
  // A raw write whose table cannot be named stays out of the index and is counted instead.
  stats.rawSqlWrites = rawSqlOps.length;
  stats.rawSqlWritesUnresolved = 0;
  for (const o of rawSqlOps) {
    const table = o.sql !== undefined ? (sqlNames.has(o.sql) ? o.sql : undefined) : o.ts !== undefined ? tsToSql.get(o.ts) : undefined;
    if (!table) { stats.rawSqlWritesUnresolved!++; continue; }
    const key = `${table}|${o.op}|${o.fn}|${o.line}`;
    if (opSeen.has(key)) continue;
    opSeen.add(key);
    tableOps.push({ table, op: o.op, fn: o.fn, line: o.line });
  }

  const constant = (file: string, name: string | null): string | null => {
    if (!name) return null;
    const s = scans.get(file);
    if (!s) return null;
    const own = s.strings.get(name);
    if (own !== undefined) return own;
    const imp = s.imports.get(name);
    const target = imp ? specFile(file, imp.spec) : null;
    if (!imp || !target) return null;
    const follow = (f: string, n: string, depth: number): string | null => {
      const x = scans.get(f);
      if (!x || depth > 6) return null;
      const e = x.exports.get(n);
      if (e?.local && x.strings.has(e.local)) return x.strings.get(e.local)!;
      // `import { X } from ...; export { X }` re-exports a constant without defining it.
      const via = e?.local ? x.imports.get(e.local) : undefined;
      if (via) { const g = specFile(f, via.spec); return g ? follow(g, via.name, depth + 1) : null; }
      if (e?.from) { const g = specFile(f, e.from); return g ? follow(g, e.name ?? n, depth + 1) : null; }
      for (const st of x.stars) { const g = specFile(f, st); const r = g ? follow(g, n, depth + 1) : null; if (r) return r; }
      return null;
    };
    return follow(target, imp.name, 0);
  };
  const named = rawQueues.flatMap((q) => {
    const name = q.name ?? constant(q.file, q.ref);
    return name ? [{ name, file: q.file, line: q.line, consumer: q.fn ?? (q.handler ? fnNamed(q.file, q.handler) : null), producer: q.producer }] : [];
  });
  const consumed = new Set(named.filter((q) => !q.producer).map((q) => q.name));
  const queues: CodeIndex["queues"] = named.filter((q) => !q.producer || !consumed.has(q.name)).map(({ producer: _, ...q }) => q);
  const queueOf = (file: string, name: string | null, ref: string | null, owner: string | null): string | null => {
    const direct = name ?? constant(file, ref);
    if (direct) return direct;
    // `someQueue.name` is the name the queue was defined with.
    const id = owner ? fnNamed(file, owner) : null;
    return id !== null ? queues.find((q) => q.consumer === id)?.name ?? null : null;
  };
  const sends: CodeIndex["sends"] = [];
  const sendSeen = new Set<string>();
  const addSend = (queue: string, fn: number, line: number) => {
    const key = `${queue}|${fn}|${line}`;
    if (sendSeen.has(key)) return;
    sendSeen.add(key);
    sends.push({ queue, fn, line });
    const q = queues.find((x) => x.name === queue);
    if (q?.consumer != null) addCall(fn, q.consumer);
  };
  // wrapper fn -> index of the parameter that carries the queue name
  const wrappers = new Map<number, number>();
  stats.sendsDynamic = 0;
  for (const sd of rawSends) {
    const queue = queueOf(sd.file, sd.name, sd.ref, sd.owner);
    if (queue) addSend(queue, sd.fn, sd.line);
    else if (sd.param >= 0) wrappers.set(sd.fn, sd.param);
    else stats.sendsDynamic!++;
  }
  const wrapperIndex = (st: (typeof sites)[number]) => {
    const target = fnNamed(st.file, st.callee);
    return target === null ? undefined : wrappers.get(target);
  };
  // A wrapper that forwards its own parameter to another wrapper is a wrapper too; iterate to a fixed point.
  for (let grew = true; grew;) {
    grew = false;
    for (const st of sites) {
      const idx = wrapperIndex(st);
      const a = idx === undefined ? null : st.args[idx];
      const j = a?.id ? fnParams.get(st.fn)?.indexOf(a.id) ?? -1 : -1;
      if (j >= 0 && !wrappers.has(st.fn)) { wrappers.set(st.fn, j); grew = true; }
    }
  }
  stats.sendWrappers = wrappers.size;
  stats.sendsViaWrapper = 0;
  stats.sendsViaWrapperUnresolved = 0;
  for (const st of sites) {
    const idx = wrapperIndex(st);
    if (idx === undefined) continue;
    const a = st.args[idx];
    const queue = a?.s ?? (a?.id ? constant(st.file, a.id) : null);
    if (queue) { stats.sendsViaWrapper!++; addSend(queue, st.fn, st.line); }
    else if (!(a?.id && fnParams.get(st.fn)?.includes(a.id))) stats.sendsViaWrapperUnresolved!++;
  }

  const calls = fns.map((f) => [...(adj.get(f.id) ?? [])]);
  stats.fns = fns.length;
  stats.callEdges = calls.reduce((n, c) => n + c.length, 0);
  stats.sendsToUnindexedQueue = sends.filter((x) => !queues.some((q) => q.name === x.queue)).length;
  stats.tableOps = tableOps.length;
  stats.navs = navs.length;
  const index: CodeIndex = {
    commit,
    files: Object.fromEntries([...scans.values()].map((s) => [s.path, { lines: s.lines, module: moduleOf(s.path) }])),
    fns, calls, tables, tableOps, routes, routeCalls, pages, queues, sends, navs,
    imports: [...importEdges].map((e) => e.split("\0") as [string, string]),
    stats,
  };
  return index;
}
