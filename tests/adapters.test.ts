import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/codeindex";

const index = (stack: string) => {
  const root = join(__dirname, "fixtures", stack);
  return buildIndex({ root, repo: root, commit: "test", moduleOf: () => null });
};
const routes = (stack: string) => index(stack).routes.map((r) => `${r.method} ${r.path}`).sort();
const fnName = (ix: ReturnType<typeof index>, id: number | null) => (id === null ? null : ix.fns[id]!.name);

describe("Next.js", () => {
  const ix = index("next");
  it("reads App Router handlers per verb and Pages Router api files", () => {
    expect(routes("next")).toEqual(["ANY /api/health", "GET /api/users", "POST /api/users"]);
    const get = ix.routes.find((r) => r.method === "GET")!;
    expect(fnName(ix, get.fn)).toBe("GET");
    expect(fnName(ix, ix.routes.find((r) => r.method === "POST")!.fn)).toBe("POST");
  });
  it("reads pages with groups, dynamic and catch-all segments, and skips _app", () => {
    expect(ix.pages.map((p) => p.path).sort()).toEqual(["/", "/", "/about", "/docs/**", "/posts/:id", "/products/:id"]);
  });
  it("prefixes routes through mounts in other files, two levels deep", () => {
    expect(routes("hono-mounts")).toEqual(["GET /api/v1/items/:id", "GET /health", "POST /api/v1/items"]);
    const ix = index("hono-mounts");
    expect(ix.stats.routeMountsUnresolved).toBe(0);
    expect(ix.routeCalls.map((c) => c.path)).toEqual(["/api/v1/items/:id"]);
    expect(ix.fns.some((f) => f.name === "GET /api/v1/items/:id")).toBe(true);
  });
  it("links fetch and axios calls to the routes", () => {
    expect(ix.routeCalls.map((c) => `${c.method} ${c.path}`).sort()).toEqual(["GET /api/users", "POST /api/users"]);
  });
});

describe("Hono", () => {
  const ix = index("hono");
  it("follows chains and same-file route() prefixes, and counts the unresolved mount", () => {
    expect(routes("hono")).toEqual(["GET /admin/stats", "GET /health", "POST /users"]);
    expect(ix.stats.routeMountsUnresolved).toBe(1);
  });
  it("attaches table writes to the inline handler", () => {
    const op = ix.tableOps.find((o) => o.table === "users")!;
    expect(op.op).toBe("insert");
    expect(fnName(ix, op.fn)).toBe("POST /users");
  });
  it("does not turn Map.get into a route", () => {
    expect(ix.routes.some((r) => r.path === "/x")).toBe(false);
  });
});

describe("Express", () => {
  const ix = index("express");
  it("prefixes a mounted router and resolves handler identifiers", () => {
    expect(routes("express")).toEqual(["DELETE /orders/:id", "GET /orders", "GET /ping"]);
    expect(fnName(ix, ix.routes.find((r) => r.path === "/orders" && r.method === "GET")!.fn)).toBe("listOrders");
  });
});

describe("Fastify", () => {
  it("takes the last argument as the handler", () => {
    const ix = index("fastify");
    expect(routes("fastify")).toEqual(["GET /items/:id", "PUT /items/:id"]);
    const get = ix.routes.find((r) => r.method === "GET")!;
    expect(ix.calls[get.fn!]!.map((c) => ix.fns[c]!.name)).toContain("audit");
  });
});

describe("Prisma", () => {
  const ix = index("prisma");
  it("maps models to tables and keeps foreign keys", () => {
    expect(ix.tables.map((t) => [t.name, t.ts, t.refs])).toEqual([["users", "User", []], ["Post", "Post", ["users"]]]);
  });
  it("records client, this.prisma and transaction operations, but not tx outside $transaction", () => {
    const ops = ix.tableOps.map((o) => `${fnName(ix, o.fn)} ${o.op} ${o.table}`).sort();
    expect(ops).toEqual([
      "Repo insert Post", "Repo update Post", "publish delete users", "publish update Post",
      "signup insert users", "signup read users",
    ]);
  });
});

describe("Drizzle sqlite", () => {
  it("reads sqliteTable and operations through imported bindings, aliases included", () => {
    const ix = index("drizzle-sqlite");
    expect(ix.tables.map((t) => [t.name, t.refs])).toEqual([["accounts", []], ["entries", ["accounts"]]]);
    expect(ix.tableOps.map((o) => `${fnName(ix, o.fn)} ${o.op} ${o.table}`).sort()).toEqual([
      "addEntry insert entries", "all read entries", "drop delete entries", "rename update accounts",
    ]);
  });
});

describe("BullMQ", () => {
  it("pairs a Worker with its queue and links add() calls", () => {
    const ix = index("bullmq");
    expect(ix.queues.map((q) => [q.name, fnName(ix, q.consumer)]).sort()).toEqual([["email", "worker email"], ["report", null]]);
    expect(ix.sends.map((s) => `${s.queue} ${fnName(ix, s.fn)}`).sort()).toEqual(["email enqueue", "report enqueue"]);
    const enqueue = ix.fns.find((f) => f.name === "enqueue")!;
    expect(ix.calls[enqueue.id]!.map((c) => ix.fns[c]!.name)).toContain("worker email");
  });
});
