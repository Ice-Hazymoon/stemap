import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, renderGithub, renderSummary } from "../src/check";
import { confirm, write } from "../src/maint";
import { commit, draft, put, repo, sh, SRC, workspace } from "./helpers";

async function mainAndBranch() {
  const dir = repo();
  await write(workspace(dir), draft(dir));
  commit(dir, "map");
  sh(dir, "checkout", "-q", "-b", "work");
  return dir;
}
const drifted = SRC.replace("gateway.refund(id)", "gateway.void(id) || gateway.refund(id)");
const run = (dir: string, base?: string) => check(dir, { base, index: false });

/** Rewrites the lock as a script might: new hashes, old words, no reason. */
async function forge(dir: string) {
  const { align, entryFor } = await import("../src/align");
  const { formatLock, readLock } = await import("../src/lock");
  const { dirSource, loadMap, mapClaims } = await import("../src/map");
  const { workTree } = await import("../src/tree");
  const lock = readLock(join(dir, ".stemap"));
  const report = align(workTree(dir), mapClaims(loadMap(dirSource(join(dir, ".stemap")))), lock);
  for (const d of report.drift) lock.set(d.claim.id, [entryFor(d.claim, d.anchors, "")!]);
  return { hashOf: formatLock(lock) };
}

describe("check", () => {
  it("passes when the map matches", async () => {
    const dir = await mainAndBranch();
    const r = await run(dir, "main");
    expect(r.ok).toBe(true);
  });
  it("reads the commit, not uncommitted edits", async () => {
    const dir = await mainAndBranch();
    put(dir, "src/pay.ts", drifted);
    expect((await run(dir, "main")).ok).toBe(true);
    commit(dir);
    expect((await run(dir, "main")).ok).toBe(false);
  });
  it("blocks drift this change caused", async () => {
    const dir = await mainAndBranch();
    put(dir, "src/pay.ts", drifted);
    commit(dir);
    const r = await run(dir, "main");
    expect(r.ok).toBe(false);
    expect(r.findings.filter((f) => f.severity === "block").map((f) => f.id)).toEqual(["flow/pay/back"]);
  });
  it("does not block on drift the base already had", async () => {
    const dir = await mainAndBranch();
    sh(dir, "checkout", "-q", "main");
    put(dir, "src/pay.ts", drifted);
    commit(dir, "main drifted");
    sh(dir, "checkout", "-q", "-b", "other");
    put(dir, "README.md", "unrelated\n");
    commit(dir);
    const r = await run(dir, "main");
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => f.severity === "note" && f.id === "flow/pay/back")).toBe(true);
  });
  it("counts everything with no base", async () => {
    const dir = await mainAndBranch();
    sh(dir, "checkout", "-q", "main");
    put(dir, "src/pay.ts", drifted);
    commit(dir);
    expect((await run(dir)).ok).toBe(false);
  });
  it("passes once a change is confirmed, and shows the reason", async () => {
    const dir = await mainAndBranch();
    put(dir, "src/pay.ts", drifted);
    confirm(workspace(dir), ["flow/pay/back"], "Void runs first, and the money still goes back to the buyer.");
    commit(dir);
    const r = await run(dir, "main");
    expect(r.ok).toBe(true);
    expect(r.confirmations.map((c) => c.id)).toEqual(["flow/pay/back"]);
    expect(renderSummary(r)).toContain("Void runs first");
  });
  it("catches a hand-edited claim that forged its lock line", async () => {
    const dir = await mainAndBranch();
    const file = join(dir, ".stemap/flows/pay.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("The service rejects an amount of zero or less.", "The service calls `madeUpGuard`."));
    // The lock is rewritten by hand to match, which is what a careless merge or agent might do.
    const { mapClaims, loadMap, dirSource } = await import("../src/map");
    const { claimFingerprint } = await import("../src/align");
    const fresh = mapClaims(loadMap(dirSource(join(dir, ".stemap")))).find((c) => c.id === "flow/pay/guard")!;
    const lockFile = join(dir, ".stemap/stemap.lock");
    writeFileSync(lockFile, readFileSync(lockFile, "utf8").replace(/(flow\/pay\/guard\t)\w+/, `$1${claimFingerprint(fresh)}`));
    commit(dir);
    const r = await run(dir, "main");
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.kind === "gate:code-span")).toBe(true);
  });
  it("treats a base from before the map as nothing to compare", async () => {
    const dir = repo();
    put(dir, ".gitignore", ".stemap\n");
    commit(dir, "code only");
    sh(dir, "checkout", "-q", "-b", "add-map");
    put(dir, ".gitignore", "");
    await write(workspace(dir), draft(dir));
    commit(dir, "map");
    expect((await run(dir, "main")).ok).toBe(true);
  });
  it("writes annotations a runner understands", async () => {
    const dir = await mainAndBranch();
    put(dir, "src/pay.ts", drifted);
    commit(dir);
    expect(renderGithub(await run(dir, "main"))).toMatch(/^::error file=\.stemap\/flows\/pay\.yaml,title=stemap changed::/);
  });
});

describe("check on hostile or broken input", () => {
  it("blocks removing the map", async () => {
    const dir = await mainAndBranch();
    sh(dir, "rm", "-rq", ".stemap");
    commit(dir, "no map");
    const r = await run(dir, "main");
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.kind === "no-map")).toBe(true);
  });
  it("refuses a base it cannot find, instead of checking less", async () => {
    const dir = await mainAndBranch();
    await expect(run(dir, "trunk")).rejects.toThrow(/cannot find base trunk/);
  });
  it("counts everything on the base branch itself", async () => {
    const dir = await mainAndBranch();
    sh(dir, "checkout", "-q", "main");
    put(dir, "src/pay.ts", drifted);
    commit(dir);
    expect((await run(dir, "main")).ok).toBe(false);
  });
  it("blocks a lock line moved by hand", async () => {
    const dir = await mainAndBranch();
    put(dir, "src/pay.ts", drifted);
    const { hashOf } = await forge(dir);
    writeFileSync(join(dir, ".stemap/stemap.lock"), hashOf);
    commit(dir);
    const r = await run(dir, "main");
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.kind === "lock")).toBe(true);
  });
  it("still fails when a claim already behind at the base moves again", async () => {
    const dir = await mainAndBranch();
    sh(dir, "checkout", "-q", "main");
    put(dir, "src/pay.ts", drifted);
    commit(dir, "main drifted");
    sh(dir, "checkout", "-q", "-b", "again");
    put(dir, "src/pay.ts", drifted.replace("gateway.void(id)", "gateway.cancel(id)"));
    commit(dir);
    expect((await run(dir, "main")).findings.find((f) => f.id === "flow/pay/back")?.severity).toBe("block");
  });
  it("hangs on nothing when a claim quotes an empty string", async () => {
    const dir = await mainAndBranch();
    const file = join(dir, ".stemap/flows/pay.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("contains: if (amount <= 0)", 'contains: ""'));
    commit(dir);
    const r = await run(dir, "main");
    expect(r.findings.some((f) => f.kind === "broken")).toBe(true);
    expect(r.ok).toBe(false);
  });
  it("lists claims that left the map", async () => {
    const dir = await mainAndBranch();
    sh(dir, "rm", "-q", ".stemap/flows/pay.yaml");
    commit(dir, "drop flow");
    const r = await run(dir, "main");
    expect(r.removed).toContain("flow/pay/guard");
    expect(renderSummary(r)).toContain("Removed from the map");
  });
});

describe("a merge of two branches", () => {
  it("keeps both confirmations through the union driver", async () => {
    const dir = await mainAndBranch();
    put(dir, ".gitattributes", ".stemap/stemap.lock merge=union\n");
    commit(dir, "attributes");
    const base = sh(dir, "rev-parse", "HEAD");
    put(dir, "src/pay.ts", SRC.replace("gateway.refund(id)", "gateway.void(id) || gateway.refund(id)"));
    confirm(workspace(dir), ["flow/pay/back"], "Void runs first, and the money still goes back.");
    commit(dir, "a");
    sh(dir, "checkout", "-q", "-b", "b", base);
    put(dir, "src/pay.ts", SRC.replace("gateway.charge(amount)", "gateway.charge(amount, 1)"));
    confirm(workspace(dir), ["flow/pay/start", "flow/pay/guard"], "The new argument only tags the charge for reports.");
    commit(dir, "b");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "-m", "m", "work"], { cwd: dir, stdio: "ignore" });
    const { status } = await import("../src/maint");
    // All three claims rest on code that changed on one branch or the other, and each has a line that matches.
    const r = status(workspace(dir), { hints: false });
    expect(r.drift.filter((d) => d.state !== "changed")).toEqual([]);
  });
});
