import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { hasMap } from "./map";
import { repoRoot } from "./repo";

interface Payload { session_id?: string; cwd?: string; stop_hook_active?: boolean; tool_input?: { file_path?: string } }

async function stdinJson(): Promise<Payload> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Payload;
}

/** One file per session, so the second hook process (a different one per call) sees the first one's files. */
const sessionFile = (id: string) => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "stemap/sessions", `${id.replace(/[^\w.-]+/g, "_").slice(0, 120)}.json`);

function touchedOf(id: string): string[] {
  const f = sessionFile(id);
  try { return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { files: string[] }).files : []; } catch { return []; }
}

const emit = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

async function pre(p: Payload) {
  const file = p.tool_input?.file_path;
  if (!p.session_id || !p.cwd || !file) return;
  const repo = repoRoot(p.cwd);
  if (!hasMap(repo)) return;
  const rel = relative(repo, isAbsolute(file) ? file : resolve(p.cwd, file)).split("\\").join("/");
  if (!rel || rel.startsWith("..")) return;
  const seen = touchedOf(p.session_id);
  if (seen.includes(rel)) return;
  const f = sessionFile(p.session_id);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, JSON.stringify({ files: [...seen, rel] }));
  // Only context() runs here: no index, no hints, so the hook stays well inside its 10 s.
  const { open, context } = await import("./maint");
  const text = context(open(repo), rel);
  if (text) emit({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });
}

async function stop(p: Payload) {
  // A block already in progress: asking again would loop the agent.
  if (p.stop_hook_active || !p.session_id || !p.cwd) return;
  const files = touchedOf(p.session_id);
  if (!files.length) return;
  const repo = repoRoot(p.cwd);
  if (!hasMap(repo)) return;
  const { open, status, renderStatus } = await import("./maint");
  const r = status(open(repo), { files, hints: false });
  if (r.drift.length || r.errors.length) emit({ decision: "block", reason: renderStatus(r) });
}

/** A hook must never break the agent: every failure ends in a silent exit 0. */
export async function runHook(name: string) {
  try {
    const p = await stdinJson();
    if (name === "claude-pre") await pre(p);
    else if (name === "claude-stop") await stop(p);
  } catch { /* silent by contract */ }
  process.exit(0);
}
