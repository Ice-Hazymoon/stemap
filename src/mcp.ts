import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VERSION } from "./version";

export const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
export const fail = (e: unknown) => ({ isError: true, ...text(e instanceof Error ? e.message : String(e)) });

export interface Index { target: () => ReturnType<typeof import("./flow").ensureTarget>; graph: () => Promise<ReturnType<typeof import("./site").loadGraph>> }

/** Every write makes the saved index look stale, so a run shares one index instead of rebuilding per query. */
export function liveIndex(repo: string): Index {
  const target = async () => (await import("./flow")).ensureTarget(repo);
  return { target, graph: async () => (await import("./site")).loadGraph((await target()).home) };
}

/** Read-only map queries, shared by the stdio server and the tool server of an agent run. */
export function registerQueries(server: McpServer, repo: string, { target, graph }: Index = liveIndex(repo)) {
  const safe = <A>(fn: (a: A) => Promise<string> | string) => async (a: A) => { try { return text(await fn(a)); } catch (e) { return fail(e); } };

  server.registerTool("stemap_context", { description: "Invariants, flows and claims that touch a file. Call before editing it.", inputSchema: { file: z.string().describe("Path relative to the repository root") } },
    safe(async ({ file }) => { const m = await import("./maint"); return m.context(m.open(repo), file) ?? "This file has no map entries."; }));

  server.registerTool("stemap_status", { description: "Claims the code no longer backs, each with the next command." },
    safe(async () => { const m = await import("./maint"); return m.renderStatus(m.status(m.open(repo), { hints: false })); }));

  server.registerTool("stemap_flow", { description: "One flow as text; without an id, the list of flows.", inputSchema: { id: z.string().optional() } },
    safe(async ({ id }) => {
      const m = await import("./maint");
      const w = m.open(repo);
      if (!id) return w.map.flows.map((f) => `${f.doc.id}  ${f.doc.title}`).join("\n") || "No flows yet.";
      return m.renderFlow(w, id) ?? `no flow ${id}`;
    }));

  server.registerTool("stemap_impact", { description: "Everything linked to an entity: callers, tables, routes, flows. Takes an id or words.", inputSchema: { query: z.string() } },
    safe(async ({ query }) => {
      const g = await graph();
      const id = g.has(query) ? query : g.search(query)[0]?.id;
      if (!id) return `nothing matches ${query}`;
      const v = g.entity(id)!;
      const out = [`${v.kind}  ${v.title}  (${id})`];
      for (const s of v.groups) {
        out.push(`\n${s.title} (${s.total})`);
        for (const x of s.items.slice(0, 12)) out.push(`  ${x.label}${x.hint ? `  — ${x.hint}` : ""}`);
      }
      return out.join("\n");
    }));

  server.registerTool("stemap_explain", { description: "A function's logic tree as JSON.", inputSchema: { fn: z.string().describe("Function id from stemap_impact") } },
    safe(async ({ fn }) => {
      const t = await target();
      const f = (await graph()).fn(fn);
      return JSON.stringify(f ? { ...(await import("./logic")).logicOf(t.root, f.file, f.line, f.end), file: f.file } : null, null, 1);
    }));
}

/** stdout belongs to the protocol, so anything else that logs goes to stderr. */
export async function serveMcp(repo: string) {
  console.log = console.error;
  console.info = console.error;
  const server = new McpServer({ name: "stemap", version: VERSION });
  registerQueries(server, repo);
  await server.connect(new StdioServerTransport());
}
