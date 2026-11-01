import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Glob } from "./glob";
import { baseOf, confirm, writeText, type Workspace } from "./maint";
import { REPO_DIR } from "./map";
import { fail, liveIndex, registerQueries, text, type Index } from "./mcp";
import { readable } from "./tree";
import { VERSION } from "./version";

/**
 * Everything an agent can do in a run, served on a loopback address with a secret path. Code goes
 * through the same `Tree` as the page, so secrets stay out of reach, and the map changes only
 * through the gate. Each call gets its own path, so a call scoped to one document cannot touch another.
 */
export interface Scope {
  tag: string;
  write?: Set<string>;
  confirm?: Set<string>;
  /** Named in every write reply, because an agent that saved a document tends to think it has finished. */
  open?: () => string[];
}
export interface Grant { url: string; names: string[] }
export interface ToolServer {
  grant(scope: Scope): Grant;
  revoke(url: string): void;
  close(): Promise<void>;
}

const READ_TOOLS = ["list_files", "read_file", "search_code", "file_diff", "read_document", "list_entry_points", "stemap_context", "stemap_status", "stemap_flow", "stemap_impact", "stemap_explain"];
const MAX_LINES = 800;
const MAX_CHARS = 60_000;
const MAX_HITS = 80;

const MAP_DOC = /^(flows|modules)\/[\w-]+\.yaml$|^(system|glossary|config)\.yaml$/;

const git = (repo: string, args: string[]) => {
  try { return execFileSync("git", ["-C", repo, "-c", "core.quotepath=off", ...args], { encoding: "utf8", maxBuffer: 1 << 27, stdio: ["ignore", "pipe", "ignore"] }); }
  // git grep exits 1 for no match, with an empty stdout.
  catch (e) { return String((e as { stdout?: unknown }).stdout ?? ""); }
};

export function readRange(w: Workspace, path: string, start = 1, count = 300): string {
  const code = readable(path) ? w.tree.read(path) : null;
  if (code === null) return `no readable file ${path}`;
  const all = code.split("\n");
  const from = Math.max(1, start);
  const to = Math.min(all.length, from + Math.min(count, MAX_LINES) - 1);
  let size = 0;
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    const row = `${i}\t${all[i - 1]}`;
    size += row.length + 1;
    if (size > MAX_CHARS) { out.push(`[stopped at line ${i - 1}: this reply is full]`); break; }
    out.push(row);
  }
  return `${path}: lines ${from}-${Math.min(to, from + out.length - 1)} of ${all.length}. Each row is the line number, a tab, then the line.\n${out.join("\n")}`;
}

export function searchCode(w: Workspace, query: string, regex: boolean, path?: string): string {
  const pathspec = path ? [path] : ["."];
  const out = git(w.repo, ["grep", "-n", "-I", "--untracked", regex ? "-E" : "-F", "-e", query, "--", ...pathspec, ":(exclude).stemap"]);
  const hits = out.split("\n").filter(Boolean).filter((l) => readable(l.slice(0, l.indexOf(":"))));
  if (!hits.length) return "no match";
  const shown = hits.slice(0, MAX_HITS).map((l) => (l.length > 260 ? `${l.slice(0, 259)}…` : l));
  return `${shown.join("\n")}${hits.length > MAX_HITS ? `\n[${hits.length - MAX_HITS} more; narrow the search]` : ""}`;
}

/** Literal pathspecs and one real file only: `.` or a pathspec trick would otherwise print the diff of a secret. */
export function fileDiff(w: Workspace, path: string): string {
  const full = join(w.repo, path);
  if (!readable(path) || (existsSync(full) && statSync(full).isDirectory())) return `no readable file ${path}`;
  return git(w.repo, ["--literal-pathspecs", "diff", baseOf(w.repo, w.map.config.base), "--", path]).slice(0, MAX_CHARS) || "no change";
}

export type OnTool = (tag: string, tool: string, detail: string, result?: string) => void;

/** One line about what a call touched, for the person watching. Never the document body. */
function brief(a: Record<string, unknown>) {
  const at = typeof a.start === "number" ? ` ${a.start}${typeof a.lines === "number" ? `-${a.start + a.lines - 1}` : ""}` : "";
  if (typeof a.path === "string") return `${a.path}${at}`;
  if (typeof a.text === "string") return `"${a.text}"`;
  if (typeof a.file === "string") return a.file;
  if (typeof a.glob === "string") return a.glob;
  if (Array.isArray(a.ids)) return `${a.ids.length} claims`;
  return "";
}

function register(server: McpServer, w: Workspace, scope: Scope, index: Index, serial: <T>(fn: () => Promise<T> | T) => Promise<T>, onTool?: OnTool) {
  const remaining = () => {
    const ids = scope.open?.() ?? [];
    return ids.length ? `\nStill open: ${ids.join(", ")}. Rewrite each one or confirm it with confirm_claims.` : "";
  };
  const tool = <S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<string> | string) =>
    server.registerTool(name, { description, inputSchema }, (async (a: z.infer<z.ZodObject<S>>) => {
      onTool?.(scope.tag, name, brief(a));
      try {
        const out = await fn(a);
        // Only a save has a verdict worth showing; every other tool either read something or failed.
        if (name === "write_document") onTool?.(scope.tag, name, "", /^(PASS|FAIL)/.test(out) ? out.split("\n")[0]!.replace(/ [^ ]+\.ya?ml:/, ":") : undefined);
        return text(out);
      } catch (e) { return fail(e); }
    }) as never);

  tool("list_files", "Files in the repository, optionally narrowed by a glob such as src/**/*.ts.", { glob: z.string().optional() }, ({ glob }) => {
    const match = glob ? new Glob(glob) : null;
    const all = w.tree.list().filter((p) => readable(p) && !p.startsWith(`${REPO_DIR}/`) && (!match || match.match(p)));
    return all.length ? `${all.slice(0, 500).join("\n")}${all.length > 500 ? `\n[${all.length - 500} more; narrow the glob]` : ""}` : "no file matches";
  });
  tool("read_file", `Lines of a file, at most ${MAX_LINES} a call. Copy evidence quotes from the text after the tab, never the line number.`, { path: z.string(), start: z.number().int().min(1).optional(), lines: z.number().int().min(1).optional() },
    ({ path, start, lines }) => readRange(w, path, start, lines));
  tool("search_code", "Search the code. Prints path:line:text.", { text: z.string().min(1), regex: z.boolean().optional().describe("Read text as an extended regular expression"), path: z.string().optional().describe("A folder or file to search in") },
    ({ text: q, regex, path }) => searchCode(w, q, Boolean(regex), path));
  tool("file_diff", "What changed in one file since the base branch, including uncommitted work.", { path: z.string() }, ({ path }) => fileDiff(w, path));
  tool("read_document", "A map document, such as flows/checkout.yaml or modules/orders.yaml.", { file: z.string() }, ({ file }) => {
    if (!MAP_DOC.test(file)) return `not a map document: ${file}`;
    const full = join(w.dir, file);
    return existsSync(full) ? readFileSync(full, "utf8") : `no document ${file}`;
  });
  tool("list_entry_points", "Pages, routes, queues and tasks, the ones that change the most data first.", {}, async () => {
    const list = (await import("./candidates")).candidates((await index.target()).home);
    return list.slice(0, 120).map((c) => `${c.kind} ${c.label} (${c.file}) writes ${c.tables.join(", ") || "nothing"}`).join("\n") || "the index found no entry point";
  });
  registerQueries(server, w.repo, index);

  if (scope.write) {
    const files = scope.write;
    tool("write_document", "Check one flow or module document and save it. Prints PASS, or the faults to fix. Nothing is saved until it passes.", { yaml: z.string().describe("The whole document as YAML") },
      ({ yaml }) => serial(async () => {
        const r = await writeText(w, "document", "document.yaml", yaml, (f) => files.has(f));
        const faults = [...r.report.hard, ...r.report.soft].slice(0, 40).map((x) => `  ${x.key} [${x.rule}] ${x.message}`).join("\n");
        return `${r.report.ok ? "PASS" : "FAIL"} ${r.file}: ${r.report.claims} claims, ${r.report.hard.length} faults${faults ? `\n${faults}` : ""}${remaining()}`;
      }));
  }
  if (scope.confirm) {
    const ids = scope.confirm;
    tool("confirm_claims", "Keep claims that are still true after the code changed. The reason names what changed and why the claim survives it.", { ids: z.array(z.string()).min(1), reason: z.string() },
      ({ ids: asked, reason }) => serial(() => {
        const out = asked.filter((id) => !ids.has(id));
        if (out.length) throw new Error(`this run may not confirm ${out.join(", ")}`);
        return `Confirmed ${confirm(w, asked, reason).length} of ${asked.length}.${remaining()}`;
      }));
  }
}

export const toolNames = (scope: Scope) => [...READ_TOOLS, ...(scope.write ? ["write_document"] : []), ...(scope.confirm ? ["confirm_claims"] : [])];

export async function startToolServer(w: Workspace, onTool?: OnTool): Promise<ToolServer> {
  const grants = new Map<string, Scope>();
  // Every write rewrites the lock and replaces the workspace's map, so parallel calls take turns.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
  const live = liveIndex(w.repo);
  let target: ReturnType<Index["target"]> | null = null;
  let graph: ReturnType<Index["graph"]> | null = null;
  const index: Index = { target: () => (target ??= live.target()), graph: () => (graph ??= (async () => (await import("./site")).loadGraph((await index.target()).home))()) };
  const http = createServer(async (req, res) => {
    const scope = grants.get(req.url ?? "");
    if (!scope) { res.writeHead(404).end(); return; }
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
    const server = new McpServer({ name: "stemap", version: VERSION });
    register(server, w, scope, index, serial, onTool);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport as never);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  await new Promise<void>((done, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", done); });
  const port = (http.address() as AddressInfo).port;
  return {
    grant(scope) {
      const path = `/${randomBytes(24).toString("hex")}`;
      grants.set(path, scope);
      return { url: `http://127.0.0.1:${port}${path}`, names: toolNames(scope) };
    },
    revoke(url) { grants.delete(new URL(url).pathname); },
    close: () => new Promise((done) => { http.close(() => done()); http.closeAllConnections(); }),
  };
}
