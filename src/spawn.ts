import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/** Starting a program: the one place stemap runs a child it does not control. Injectable, so tests use a fake. */
export type Env = Record<string, string | undefined>;

export interface ExecOptions { stdin?: string; cwd: string; env: Env; signal?: AbortSignal; timeoutMs: number; maxBytes?: number }
export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; truncated: boolean; spawnError?: string }
export type Exec = (command: string, args: readonly string[], o: ExecOptions) => Promise<ExecResult>;

const MAX = 16_000_000;

/** A copy of the environment on Windows spells it `Path`, not `PATH`. */
export function envGet(env: Env, key: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32" || env[key] !== undefined) return env[key];
  const k = Object.keys(env).find((x) => x.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : env[k];
}

const isFile = (f: string) => { try { return statSync(f).isFile(); } catch { return false; } };

export function resolveProgram(command: string, env: Env, o: { platform?: NodeJS.Platform; isFile?: (f: string) => boolean } = {}): string | null {
  const platform = o.platform ?? process.platform;
  const exists = o.isFile ?? isFile;
  const p = platform === "win32" ? win32 : posix;
  const exts = platform === "win32" ? (envGet(env, "PATHEXT", platform) || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [];
  const names = (base: string) => [base, ...exts.map((e) => base + e)];
  if (p.isAbsolute(command) || /[\\/]/.test(command)) return names(command).find(exists) ?? null;
  for (const dir of (envGet(env, "PATH", platform) ?? "").split(platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const f of names(p.join(dir.replace(/^"(.*)"$/, "$1"), command))) {
      if (!exists(f)) continue;
      if (platform === "win32") return f;
      try { accessSync(f, constants.X_OK); return f; } catch { /* a plain file with the same name */ }
    }
  }
  return null;
}

export interface SpawnPlan { file: string; args: string[]; verbatim?: boolean }

/** The last line of an npm .cmd shim names what it really runs. */
export function shimTarget(shimFile: string, text: string): { target: string; kind: "script" | "exe" } | null {
  const m = [...text.matchAll(/"%(?:~dp0|dp0%)\\?([^"%]*)"\s+%\*/g)].at(-1);
  if (!m?.[1]) return null;
  const target = win32.join(win32.dirname(shimFile), m[1].replace(/^[\\]+/, ""));
  if (/\.(?:c|m)?js$/i.test(target)) return { target, kind: "script" };
  return /\.exe$/i.test(target) ? { target, kind: "exe" } : null;
}

export function cmdQuote(arg: string): string {
  if (/[\r\n\0%]/.test(arg)) throw new Error(`an argument cannot be passed safely through cmd.exe: ${JSON.stringify(arg.slice(0, 24))}`);
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Node refuses to start a .cmd without a shell, so a shim is opened and its target started directly. Only an unknown .cmd goes through cmd.exe. */
export function spawnPlan(command: string, args: readonly string[], env: Env, o: { platform?: NodeJS.Platform; isFile?: (f: string) => boolean; readFile?: (f: string) => string; node?: string } = {}): SpawnPlan {
  const platform = o.platform ?? process.platform;
  if (platform !== "win32") return { file: command, args: [...args] };
  const found = resolveProgram(command, env, { platform, isFile: o.isFile }) ?? command;
  if (!/\.(?:cmd|bat)$/i.test(found)) return { file: found, args: [...args] };
  try {
    const shim = shimTarget(found, (o.readFile ?? ((f) => readFileSync(f, "utf8")))(found));
    if (shim?.kind === "exe") return { file: shim.target, args: [...args] };
    if (shim?.kind === "script") return { file: o.node ?? process.execPath, args: [shim.target, ...args] };
  } catch { /* unreadable: cmd.exe below */ }
  return { file: envGet(env, "ComSpec", platform) || "cmd.exe", args: ["/d", "/s", "/c", `"${[found, ...args].map(cmdQuote).join(" ")}"`], verbatim: true };
}

/** The child leads its own process group, so its helpers end with it. The pid is our own child's and is checked. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  const pid = child.pid;
  try {
    if (process.platform === "win32") {
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 4) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).once("error", () => child.kill());
      else child.kill();
    } else if (typeof pid === "number" && Number.isInteger(pid) && pid > 1) process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

export const nodeExec: Exec = (command, args, o) => new Promise((resolve) => {
  const max = o.maxBytes ?? MAX;
  const out: ExecResult = { code: null, stdout: "", stderr: "", timedOut: false, aborted: false, truncated: false };
  let child: ChildProcess;
  try {
    const plan = spawnPlan(command, args, o.env);
    child = spawn(plan.file, plan.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true, windowsVerbatimArguments: plan.verbatim === true });
  } catch (e) { resolve({ ...out, spawnError: (e as Error).message }); return; }
  let done = false;
  const stop = () => {
    killTree(child);
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) killTree(child, "SIGKILL"); }, 2000).unref();
  };
  const timer = setTimeout(() => { out.timedOut = true; stop(); }, o.timeoutMs);
  const onAbort = () => { out.aborted = true; stop(); };
  if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener("abort", onAbort, { once: true });
  const finish = (code: number | null) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
    resolve({ ...out, code });
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => { if (out.stdout.length < max) out.stdout += d; else out.truncated = true; });
  child.stderr?.on("data", (d: string) => { out.stderr = (out.stderr + d).slice(-8000); });
  child.on("error", (e) => { out.spawnError = (e as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : e.message; finish(null); });
  child.on("close", finish);
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(o.stdin);
});
