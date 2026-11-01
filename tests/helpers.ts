import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { writeLock } from "../src/lock";
import { open, type Workspace } from "../src/maint";
import { toYaml } from "../src/map";

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

export const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export function put(repo: string, file: string, text: string) {
  const full = join(repo, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

export const SRC = `export function chargeCard(amount: number) {
  if (amount <= 0) throw new Error("amount must be positive");
  return gateway.charge(amount);
}

export function refund(id: string) {
  return gateway.refund(id);
}
`;

/** A flow has three claims: two in one function and one in another, the shape that exposes lock mixups. */
export const flowDoc = (over: Record<string, unknown> = {}) => ({
  id: "pay", title: "Pay", actor: "Buyer", goal: "Pay for an order",
  steps: [
    { id: "start", title: "Start", lane: "user", module: "core", kind: "start", text: "The buyer starts a payment.", evidence: [{ path: "src/pay.ts", contains: "export function chargeCard" }], next: [{ to: "guard" }] },
    { id: "guard", title: "Guard", lane: "service", module: "core", kind: "action", text: "The service rejects an amount of zero or less.", evidence: [{ path: "src/pay.ts", contains: "if (amount <= 0)" }], next: [{ to: "back" }] },
    { id: "back", title: "Refund", lane: "service", module: "core", kind: "end", text: "The service can give the money back.", evidence: [{ path: "src/pay.ts", contains: "gateway.refund(id)" }] },
  ],
  ...over,
});

export function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "stemap-test-"));
  made.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  put(dir, "src/pay.ts", SRC);
  put(dir, ".stemap/config.yaml", toYaml({ version: 1, languages: ["en"], base: "main" }));
  put(dir, ".stemap/modules/core.yaml", toYaml({ id: "core", title: "Core", paths: ["src/**"] }));
  writeLock(join(dir, ".stemap"), new Map());
  return dir;
}

export const commit = (dir: string, message = "change") => { sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", message); };

/** A draft sits outside the repo: inside, its quotes would count as a second place the code lives. */
export function draft(_dir: string, doc: unknown = flowDoc()) {
  const dir = mkdtempSync(join(tmpdir(), "stemap-draft-"));
  made.push(dir);
  const file = join(dir, "draft.yaml");
  writeFileSync(file, toYaml(doc));
  return file;
}

export const workspace = (dir: string): Workspace => open(dir);
