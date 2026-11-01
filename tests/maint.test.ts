import { readFileSync, renameSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { confirm, context, reanchor, status, write } from "../src/maint";
import { parse } from "yaml";
import { readable } from "../src/tree";
import { draft, flowDoc, put, repo, SRC, workspace } from "./helpers";

const states = (dir: string) => Object.fromEntries(status(workspace(dir), { hints: false }).drift.map((d) => [d.claim.id, d.state]));

async function mapped() {
  const dir = repo();
  const r = await write(workspace(dir), draft(dir));
  expect(r.report.hard).toEqual([]);
  return dir;
}

describe("write", () => {
  it("locks every claim and leaves nothing to do", async () => {
    const dir = await mapped();
    expect(states(dir)).toEqual({});
    expect(readFileSync(join(dir, ".stemap/stemap.lock"), "utf8")).toContain("flow/pay/guard");
  });
  it("takes a path relative to the map, the form status prints", async () => {
    const dir = await mapped();
    const w = workspace(dir);
    const cwd = process.cwd();
    process.chdir(dir);
    try { expect((await write(w, "flows/pay.yaml")).report.ok).toBe(true); } finally { process.chdir(cwd); }
  });
  it("reports a YAML mistake and a schema mistake as faults, not crashes", async () => {
    const dir = await mapped();
    put(dir, "bad.yaml", "id: x\nsteps:\n  - text: a and `b: true`.\n");
    const syntax = await write(workspace(dir), join(dir, "bad.yaml"));
    expect(syntax.report.hard[0]?.rule).toBe("syntax");
    expect(syntax.report.hard[0]?.message).toMatch(/quote any string/);
    const r = await write(workspace(dir), draft(dir, { id: "x", title: "x", steps: [] }));
    expect(r.report.hard[0]?.rule).toBe("schema");
  });
  it("refuses a quote the file does not hold, and writes nothing", async () => {
    const dir = repo();
    const doc = flowDoc();
    doc.steps[1]!.evidence[0]!.contains = "if (amount <= 100)";
    const r = await write(workspace(dir), draft(dir, doc));
    expect(r.report.ok).toBe(false);
    expect(r.saved).toBeNull();
    expect(workspace(dir).map.flows).toHaveLength(0);
  });
  it("refuses a step nothing can reach", async () => {
    const dir = repo();
    const doc = flowDoc();
    doc.steps[0]!.next = [{ to: "back" }];
    const r = await write(workspace(dir), draft(dir, doc));
    expect(r.report.hard.some((f) => f.message.includes("not reachable"))).toBe(true);
  });
  it("refuses a code span that is not in the cited file", async () => {
    const dir = repo();
    const doc = flowDoc();
    doc.steps[1]!.text = "The service calls `validateAmount` first.";
    const r = await write(workspace(dir), draft(dir, doc));
    expect(r.report.hard.some((f) => f.rule === "code-span")).toBe(true);
  });
  it("keeps drift on a claim that was not reworded", async () => {
    const dir = await mapped();
    put(dir, "src/pay.ts", SRC.replace("amount <= 0", "amount < 0").replace("if (amount < 0)", "if (amount <= 0 || isNaN(amount))"));
    const doc = flowDoc();
    doc.steps[1]!.evidence[0]!.contains = "if (amount <= 0 || isNaN(amount))";
    doc.steps[2]!.title = "Give back";
    const r = await write(workspace(dir), draft(dir, doc));
    expect(r.report.ok).toBe(true);
    expect(states(dir)).toEqual({ "flow/pay/start": "changed" });
  });
  it("drops lock lines of claims that left the map", async () => {
    const dir = await mapped();
    const doc = flowDoc();
    doc.steps[1]!.next = [{ to: "end2" }];
    doc.steps[2]!.id = "end2";
    await write(workspace(dir), draft(dir, doc));
    const lock = readFileSync(join(dir, ".stemap/stemap.lock"), "utf8");
    expect(lock).toContain("flow/pay/end2");
    expect(lock).not.toContain("flow/pay/back");
  });
});

describe("status", () => {
  it("stays quiet on formatting and comments", async () => {
    const dir = await mapped();
    put(dir, "src/pay.ts", `// charges\n${SRC.replaceAll('"', "'").replace("return gateway.charge(amount);", "return gateway\n    .charge(amount);")}`);
    expect(states(dir)).toEqual({});
  });
  it("flags only the claims on the function that changed", async () => {
    const dir = await mapped();
    put(dir, "src/pay.ts", SRC.replace("gateway.refund(id)", "gateway.refund(id, true) && gateway.refund(id)"));
    expect(states(dir)).toEqual({ "flow/pay/back": "changed" });
  });
  it("flags a claim whose words changed outside stemap write", async () => {
    const dir = await mapped();
    const file = join(dir, ".stemap/flows/pay.yaml");
    put(dir, ".stemap/flows/pay.yaml", readFileSync(file, "utf8").replace("rejects an amount", "refuses an amount"));
    expect(states(dir)).toEqual({ "flow/pay/guard": "edited" });
  });
  it("treats a function moved within its file as no change", async () => {
    const dir = await mapped();
    const [a, b] = SRC.trim().split("\n\n");
    put(dir, "src/pay.ts", `${b}\n\n${a}\n`);
    expect(states(dir)).toEqual({});
  });
  it("calls a removed line lost", async () => {
    const dir = await mapped();
    put(dir, "src/pay.ts", SRC.replace(`  if (amount <= 0) throw new Error("amount must be positive");\n`, ""));
    expect(states(dir)).toMatchObject({ "flow/pay/guard": "lost" });
  });
  it("filters to touched files, and a map file counts as touched", async () => {
    const dir = await mapped();
    put(dir, "src/pay.ts", SRC.replace("gateway.refund(id)", "gateway.void(id) || gateway.refund(id)"));
    const w = workspace(dir);
    expect(status(w, { files: ["src/other.ts"], hints: false }).drift).toEqual([]);
    expect(status(w, { files: ["src/pay.ts"], hints: false }).drift).toHaveLength(1);
    expect(status(w, { files: [".stemap/flows/pay.yaml"], hints: false }).drift).toHaveLength(1);
  });
  it("reports a broken document without hiding the rest", async () => {
    const dir = await mapped();
    put(dir, ".stemap/flows/bad.yaml", "id: [unclosed");
    const r = status(workspace(dir), { hints: false });
    expect(r.errors).toHaveLength(1);
    expect(r.checked).toBeGreaterThan(0);
  });
});

describe("confirm", () => {
  const changed = (dir: string) => put(dir, "src/pay.ts", SRC.replace("return gateway.charge(amount);", "return gateway.charge(Math.round(amount));"));

  it("clears one claim and leaves the claim beside it", async () => {
    const dir = await mapped();
    changed(dir);
    expect(Object.keys(states(dir)).sort()).toEqual(["flow/pay/guard", "flow/pay/start"]);
    confirm(workspace(dir), ["flow/pay/guard"], "The guard runs before the rounding that this change added.");
    expect(states(dir)).toEqual({ "flow/pay/start": "changed" });
  });
  it("needs a real reason", async () => {
    const dir = await mapped();
    changed(dir);
    expect(() => confirm(workspace(dir), ["flow/pay/guard"], "ok")).toThrow(/reason/);
  });
  it("records the reason in the lock", async () => {
    const dir = await mapped();
    changed(dir);
    confirm(workspace(dir), ["flow/pay/guard"], "The guard runs before the rounding that this change added.");
    expect(readFileSync(join(dir, ".stemap/stemap.lock"), "utf8")).toContain("rounding that this change");
  });
  it("cannot confirm a lost quote", async () => {
    const dir = await mapped();
    put(dir, "src/pay.ts", SRC.replace("gateway.refund(id)", "gateway.undo(id)"));
    expect(() => confirm(workspace(dir), ["flow/pay/back"], "This should not be allowed to pass.")).toThrow(/lost/);
  });
  it("refuses the same reason twice", async () => {
    const dir = await mapped();
    changed(dir);
    const why = "The guard runs before the rounding that this change added.";
    confirm(workspace(dir), ["flow/pay/guard"], why);
    put(dir, "src/pay.ts", SRC.replace("return gateway.charge(amount);", "return gateway.charge(Math.ceil(amount));"));
    expect(() => confirm(workspace(dir), ["flow/pay/guard"], why)).toThrow(/already has this reason/);
  });
  it("needs a known claim", async () => {
    const dir = await mapped();
    expect(() => confirm(workspace(dir), ["flow/pay/none"], "This claim does not exist anywhere.")).toThrow(/no claim/);
  });
});

describe("reading the tree", () => {
  it("does not follow a symlink out of the repository", async () => {
    const dir = await mapped();
    symlinkSync("/etc/hostname", join(dir, "leak.ts"));
    expect(workspace(dir).tree.read("leak.ts")).toBeNull();
  });
  it("refuses to quote secrets, however they are cased or nested", () => {
    for (const p of [".ENV", "a/.env.local", ".aws/credentials", "keys/id_rsa", "certs/site.pem", "secrets/token.txt", "../x", "/etc/passwd"]) expect(readable(p)).toBe(false);
    expect(readable("src/secret-santa.ts")).toBe(true);
  });
});

describe("reanchor", () => {
  it("follows a file that moved", async () => {
    const dir = await mapped();
    mkdirSync(join(dir, "lib"));
    renameSync(join(dir, "src/pay.ts"), join(dir, "lib/pay.ts"));
    expect(Object.values(states(dir))).toEqual(["lost", "lost", "lost"]);
    const r = reanchor(workspace(dir), true);
    expect(r.moves).toHaveLength(3);
    expect(r.relocked).toBe(3);
    const doc = parse(readFileSync(join(dir, ".stemap/flows/pay.yaml"), "utf8")) as { steps: { evidence: { path: string }[] }[] };
    expect(doc.steps[0]!.evidence[0]!.path).toBe("lib/pay.ts");
    expect(states(dir)).toEqual({});
  });
  it("does not relock a file that moved and changed", async () => {
    const dir = await mapped();
    mkdirSync(join(dir, "lib"));
    put(dir, "lib/pay.ts", SRC.replace("gateway.charge(amount)", "gateway.charge(amount, 2)"));
    rmSync(join(dir, "src/pay.ts"));
    const r = reanchor(workspace(dir), true);
    expect(r.relocked).toBe(1);
    expect(Object.keys(states(dir)).sort()).toEqual(["flow/pay/guard", "flow/pay/start"]);
  });
});

describe("context", () => {
  it("names the module, the flow and the steps", async () => {
    const dir = await mapped();
    const out = context(workspace(dir), "src/pay.ts")!;
    expect(out).toContain("module core");
    expect(out).toContain("Flow pay steps: start, guard, back");
    expect(out.split("\n").length).toBeLessThanOrEqual(10);
  });
  it("stays silent on a file outside the map", async () => {
    const dir = await mapped();
    expect(context(workspace(dir), "docs/a.md")).toBeNull();
  });
});
