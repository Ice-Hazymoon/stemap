import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { nodeExec, resolveProgram, type Env, type Exec } from "./spawn";

/**
 * The person's own agent programs, started in their documented headless mode on their own login.
 * Every call is locked down the same way: no shell and no file tools, no project or user settings,
 * no saved session, and an empty working directory. The only thing the program can reach is the
 * stemap tool server of this run, so code it reads can never talk it into anything else.
 */
export type AgentId = "claude" | "codex" | "opencode";
export const AGENT_ORDER: readonly AgentId[] = ["claude", "codex", "opencode"];
export const SERVER = "stemap";

export type FailKind = "auth" | "quota" | "busy" | "timeout" | "unavailable" | "invalid" | "aborted" | "unsafe" | "failed";
export class AgentError extends Error {
  constructor(readonly kind: FailKind, message: string) { super(message); this.name = "AgentError"; }
  /** No later call can succeed, so the run stops instead of spending the rest of the plan on it. */
  get fatal() { return this.kind !== "busy" && this.kind !== "timeout" && this.kind !== "invalid" && this.kind !== "failed"; }
}

export interface AgentTask {
  label: string;
  system: string;
  prompt: string;
  /** With a schema the program must answer with one matching JSON object. */
  schema?: object;
  tools: { url: string; names: string[] };
  timeoutMs: number;
}
export interface AgentAnswer { text: string; inputTokens?: number; outputTokens?: number; ms: number }
/** The orchestration only sees this, so its tests run without any program. */
export interface Agent { id: AgentId; model: string; call(task: AgentTask, signal: AbortSignal): Promise<AgentAnswer> }

interface CallSpec extends AgentTask { model?: string; effort?: string; cwd: string; schemaFile: string; systemFile: string; mcpFile: string; switches: string[] }
interface CliAnswer { text: string; inputTokens?: number; outputTokens?: number }
interface Backend {
  bin: string;
  defaultModel?: string;
  /** The command that signs in, for the message when nobody is. */
  login: string;
  args(c: CallSpec, prompt: string): string[];
  stdin?(prompt: string): string;
  promptArg?: boolean;
  env?(c: CallSpec): Env;
  /** Files the call needs on disk: a long system prompt and a secret URL both stay off the command line. */
  files?(c: CallSpec): Record<string, string>;
  /** Backends with no switch for it read the system prompt in front of the task. */
  inlineSystem?: boolean;
  /** Arguments that depend on the installed version, read once per run. */
  switches?(exec: Exec, env: Env): Promise<string[]>;
  parse(stdout: string): CliAnswer;
}

const AUTH = /not logged in|please (run|use) .{0,20}(login|\/login)|log ?in required|login required|invalid api key|authentication[_ ](failed|error)|unauthori[sz]ed|\b401\b|codex login|no credentials|sign in/i;
const QUOTA = /usage limit|quota|insufficient[_ ](funds|credit)|credit balance|out of credits|billing|plan limit|limit reached|resets? at/i;
const BUSY = /overloaded|rate[_ -]?limit|\b429\b|\b529\b|temporarily unavailable/i;

export function classify(id: string, text: string): AgentError {
  const t = text.replace(/\s+/g, " ").trim().slice(0, 240);
  if (AUTH.test(text)) return new AgentError("auth", `${id} is not signed in (${t})`);
  if (QUOTA.test(text) && !BUSY.test(text)) return new AgentError("quota", `${id} reports that its usage limit is used up (${t})`);
  if (BUSY.test(text)) return new AgentError("busy", `${id} is rate limited or overloaded (${t})`);
  return new AgentError("failed", `${id} failed (${t})`);
}

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const events = (s: string) => s.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).flatMap((l) => {
  try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; }
});

/** The lockdown depends on each program's flags, which change. Output that shows another tool ran stops the run, whatever it produced. */
const unsafe = (id: string, what: string) => new AgentError("unsafe", `${id} used ${what}, which the lockdown should have removed. Stopped. Update stemap or use another agent.`);

/** `--json-schema` delivers its answer through a synthetic `StructuredOutput` call, which touches nothing. */
const allowedClaudeTool = (name: string) => name === "StructuredOutput" || name.startsWith(`mcp__${SERVER}__`);

const claude: Backend = {
  bin: "claude",
  defaultModel: "sonnet",
  login: "claude auth login",
  args: (c) => [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    ...(c.schema ? ["--json-schema", JSON.stringify(c.schema)] : []),
    "--system-prompt-file", c.systemFile,
    "--tools", "",
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--mcp-config", c.mcpFile,
    "--allowedTools", `mcp__${SERVER}__*`,
    ...(c.model ? ["--model", c.model] : []),
    ...(c.effort ? ["--effort", c.effort] : []),
  ],
  // The stream form cost a tenth of the cache tokens of plain text input when the reference project measured it.
  stdin: (prompt) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } })}\n`,
  files: (c) => ({ [c.systemFile]: c.system, [c.mcpFile]: JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: c.tools.url } } }) }),
  parse(stdout) {
    const all = events(stdout);
    for (const e of all) {
      if (e.type !== "assistant") continue;
      for (const b of (e.message as { content?: { type?: string; name?: string }[] } | undefined)?.content ?? []) if (b.type === "tool_use" && !allowedClaudeTool(String(b.name))) throw unsafe("claude", String(b.name));
    }
    const j = all.filter((e) => e.type === "result").at(-1);
    if (!j) throw classify("claude", stdout);
    if (j.is_error === true || (typeof j.subtype === "string" && j.subtype !== "success")) throw classify("claude", String(j.result ?? j.subtype ?? ""));
    const u = (j.usage ?? {}) as Record<string, unknown>;
    const input = (num(u.input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0);
    const text = j.structured_output !== undefined && j.structured_output !== null ? JSON.stringify(j.structured_output) : String(j.result ?? "");
    return { text, ...(input ? { inputTokens: input } : {}), ...(num(u.output_tokens) !== undefined ? { outputTokens: num(u.output_tokens)! } : {}) };
  },
};

/**
 * A read-only sandbox still leaves a shell that reads the whole disk, so the tools themselves go.
 * Verified on codex-cli 0.163. Code mode's `exec` stays on because MCP tools are called through it;
 * it is a bare script engine with no file, process or network access. `apply_patch` has no switch,
 * and the read-only sandbox rejected it when tried.
 */
const CODEX_OFF = ["shell_tool", "unified_exec", "multi_agent", "multi_agent_v2", "view_image", "image_generation", "browser_use", "computer_use", "in_app_browser", "apps", "tool_suggest"];

/** Codex exits on a switch it does not know, and switches come and go between versions, so the list is read first. A version with no shell switch does not run at all. */
export async function codexSwitches(exec: Exec, env: Env, timeoutMs = 8000): Promise<string[]> {
  const r = await exec("codex", ["features", "list"], { cwd: tmpdir(), env: childEnv(env), timeoutMs, maxBytes: 200_000 });
  const live = new Set(r.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 3 && c[1] !== "removed").map((c) => c[0]!));
  if (!live.has("shell_tool")) throw new AgentError("unavailable", "this codex version does not offer a switch for its shell, so stemap cannot lock it down. Update codex.");
  return CODEX_OFF.filter((f) => live.has(f)).flatMap((f) => ["--disable", f]);
}

const codex: Backend = {
  bin: "codex",
  login: "codex login",
  inlineSystem: true,
  switches: codexSwitches,
  args: (c) => [
    "exec",
    "--json",
    ...(c.schema ? ["--output-schema", c.schemaFile] : []),
    "-s", "read-only",
    "-c", 'approval_policy="never"',
    "-c", 'web_search="disabled"',
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    ...c.switches,
    "-C", c.cwd,
    "-c", `mcp_servers.${SERVER}.url=${JSON.stringify(c.tools.url)}`,
    "-c", `mcp_servers.${SERVER}.enabled_tools=${JSON.stringify(c.tools.names)}`,
    "-c", `mcp_servers.${SERVER}.default_tools_approval_mode="approve"`,
    ...(c.model ? ["-m", c.model] : []),
    ...(c.effort ? ["-c", `model_reasoning_effort="${c.effort}"`] : []),
    "-",
  ],
  files: (c) => (c.schema ? { [c.schemaFile]: JSON.stringify(c.schema) } : {}),
  parse(stdout) {
    let text: string | undefined;
    let failure = "";
    let usage: Record<string, unknown> | undefined;
    for (const ev of events(stdout)) {
      const item = ev.item as Record<string, unknown> | undefined;
      if (typeof item?.type === "string" && /^(command_execution|file_change|web_search|collab_tool_call)$/.test(item.type) && item.status !== "failed") throw unsafe("codex", item.type);
      if (ev.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") text = item.text;
      else if (ev.type === "turn.completed") usage = ev.usage as Record<string, unknown>;
      else if (ev.type === "error" || ev.type === "turn.failed") failure = String(ev.message ?? (ev.error as { message?: unknown } | undefined)?.message ?? failure);
    }
    if (failure && text === undefined) throw classify("codex", failure);
    if (text === undefined) throw new AgentError("invalid", "codex answered nothing");
    return { text, ...(num(usage?.input_tokens) !== undefined ? { inputTokens: num(usage?.input_tokens)! } : {}), ...(num(usage?.output_tokens) !== undefined ? { outputTokens: num(usage?.output_tokens)! } : {}) };
  },
};

const OPENCODE_DENY = Object.fromEntries(["bash", "read", "edit", "glob", "grep", "webfetch", "task", "websearch", "lsp", "skill"].map((k) => [k, "deny"]));

/** Written from opencode's documentation and the reference project; no real binary has run it yet. */
const opencode: Backend = {
  bin: "opencode",
  login: "opencode auth login",
  promptArg: true,
  inlineSystem: true,
  args: (c) => ["run", "--format", "json", "--dir", c.cwd, ...(c.model ? ["-m", c.model] : []), ...(c.effort ? ["--variant", c.effort] : [])],
  env: (c) => ({
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { [SERVER]: { type: "remote", url: c.tools.url, enabled: true } } }),
    OPENCODE_PERMISSION: JSON.stringify({ ...OPENCODE_DENY, [`${SERVER}_*`]: "allow" }),
  }),
  parse(stdout) {
    const parts: string[] = [];
    let failure = "";
    for (const ev of events(stdout)) {
      const part = ev.part as Record<string, unknown> | undefined;
      const error = ev.error as { data?: { message?: unknown }; message?: unknown } | undefined;
      if (ev.type === "text" && typeof part?.text === "string") parts.push(part.text);
      else if (ev.type === "error") failure = String(error?.data?.message ?? error?.message ?? failure);
    }
    const text = parts.join("").trim() || (events(stdout).length ? "" : stdout.trim());
    if (!text) throw failure ? classify("opencode", failure) : new AgentError("invalid", "opencode answered nothing");
    return { text };
  },
};

export const BACKENDS: Readonly<Record<AgentId, Backend>> = { claude, codex, opencode };

/** A key in the environment would bill the API instead of the login, which is exactly what this feature must not do. */
const API_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"];
export function childEnv(env: Env, extra: Env = {}): Env {
  const out = { ...env, ...extra };
  for (const k of API_KEYS) delete out[k];
  return out;
}
export const heldKeys = (env: Env) => API_KEYS.filter((k) => env[k]?.trim());

/** A model name lands on a command line, where a leading dash would read as a flag. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,99}$/;

/** The closing tag inside the data must not close the block. */
export const untrusted = (data: string) => `<untrusted_input>\n${data.replace(/<\/?untrusted_input>/gi, "[tag removed]")}\n</untrusted_input>`;

export interface AgentOptions { id: AgentId; model?: string; effort?: string; env?: Env; exec?: Exec; backends?: Readonly<Record<AgentId, Backend>> }

export function localAgent(o: AgentOptions): Agent {
  const backend = (o.backends ?? BACKENDS)[o.id];
  const exec = o.exec ?? nodeExec;
  const env = o.env ?? process.env;
  const model = o.model ?? backend.defaultModel;
  if (model && !MODEL.test(model)) throw new Error(`${model} is not a model name`);
  if (o.effort && !/^(low|medium|high|xhigh|max)$/.test(o.effort)) throw new Error("effort: use low, medium or high");
  let switches: Promise<string[]> | null = null;
  return {
    id: o.id,
    model: model ?? "default",
    async call(task, signal) {
      if (signal.aborted) throw new AgentError("aborted", "cancelled");
      const extra = await (switches ??= backend.switches?.(exec, env) ?? Promise.resolve([]));
      const cwd = mkdtempSync(join(tmpdir(), "stemap-agent-"));
      const started = performance.now();
      try {
        const spec: CallSpec = { ...task, model, effort: o.effort, cwd, schemaFile: join(cwd, "schema.json"), systemFile: join(cwd, "system.txt"), mcpFile: join(cwd, "mcp.json"), switches: extra };
        for (const [f, text] of Object.entries(backend.files?.(spec) ?? {})) writeFileSync(f, text, { mode: 0o600 });
        const body = task.schema && o.id === "opencode" ? `${task.prompt}\n\nReply with one JSON object that matches this schema and nothing else:\n${JSON.stringify(task.schema)}` : task.prompt;
        const prompt = backend.inlineSystem ? `${task.system}\n\n${body}` : body;
        const args = backend.args(spec, prompt);
        const r = await exec(backend.bin, backend.promptArg ? [...args, prompt] : args, { stdin: backend.promptArg ? undefined : backend.stdin ? backend.stdin(prompt) : prompt, cwd, env: childEnv(env, backend.env?.(spec)), signal, timeoutMs: task.timeoutMs });
        if (r.aborted || signal.aborted) throw new AgentError("aborted", "cancelled");
        if (r.spawnError) throw new AgentError("unavailable", `${o.id} could not start (${r.spawnError})`);
        if (r.timedOut) throw new AgentError("timeout", `${o.id} did not finish ${task.label} within ${Math.round(task.timeoutMs / 60000)} min`);
        let answer: CliAnswer;
        try { answer = backend.parse(r.stdout); }
        catch (e) {
          // A program that prints nothing on stdout says why on stderr.
          if (r.stderr.trim() && !(e instanceof AgentError && e.fatal)) throw classify(o.id, r.stderr);
          throw e;
        }
        if (r.code !== 0 && !answer.text.trim()) throw classify(o.id, r.stderr || r.stdout);
        return { ...answer, ms: performance.now() - started };
      } finally { rmSync(cwd, { recursive: true, force: true }); }
    },
  };
}

export type AgentStatus = "ready" | "signed-out" | "unknown" | "not-installed";
export interface AgentProbe { id: AgentId; status: AgentStatus; path: string | null; plan?: string }
export interface ProbeOptions { env?: Env; exec?: Exec; which?: (bin: string) => string | null; timeoutMs?: number }

const PROBE: Record<AgentId, string[]> = { claude: ["auth", "status"], codex: ["login", "status"], opencode: ["auth", "list"] };
const opencodeAuth = (env: Env) => join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "opencode", "auth.json");

/** The probes cost no tokens. An answer that cannot be read is `unknown`, because a slow machine must not lose its agent to a timeout. */
async function probeOne(id: AgentId, bin: string, env: Env, exec: Exec, timeoutMs: number, readFile: (f: string) => string): Promise<AgentProbe> {
  const base = { id, path: bin };
  if (id === "claude" && env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return { ...base, status: "ready", plan: "OAuth token" };
  if (id === "opencode") {
    try { if (Object.keys(JSON.parse(readFile(opencodeAuth(env))) as object).length) return { ...base, status: "ready" }; } catch { /* ask the program */ }
  }
  const r = await exec(bin, PROBE[id], { cwd: tmpdir(), env: { ...childEnv(env), NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" }, timeoutMs, maxBytes: 20_000 });
  if (r.spawnError || r.timedOut) return { ...base, status: "unknown" };
  const text = `${r.stdout}\n${r.stderr}`;
  if (id === "claude") {
    try {
      const j = JSON.parse(r.stdout) as { loggedIn?: unknown; subscriptionType?: unknown; authMethod?: unknown };
      if (j.loggedIn === true) {
        const plan = typeof j.subscriptionType === "string" && j.subscriptionType ? j.subscriptionType : typeof j.authMethod === "string" ? j.authMethod : undefined;
        return { ...base, status: "ready", ...(plan ? { plan } : {}) };
      }
      if (j.loggedIn === false) return { ...base, status: "signed-out" };
    } catch { /* an older version prints text */ }
    return { ...base, status: /not logged in|not signed in/i.test(text) ? "signed-out" : "unknown" };
  }
  if (id === "codex") {
    if (/not logged in|not signed in/i.test(text)) return { ...base, status: "signed-out" };
    if (r.code === 0 && /logged in/i.test(text)) {
      const plan = /chatgpt/i.test(text) ? "ChatGPT" : /api key/i.test(text) ? "API key" : undefined;
      return { ...base, status: "ready", ...(plan ? { plan } : {}) };
    }
    return { ...base, status: r.code === 0 ? "unknown" : "signed-out" };
  }
  const n = /(\d+)\s+credentials?/i.exec(text);
  return n ? { ...base, status: Number(n[1]) > 0 ? "ready" : "signed-out" } : { ...base, status: "unknown" };
}

export function probeAgents(o: ProbeOptions = {}): Promise<AgentProbe[]> {
  const env = o.env ?? process.env;
  const which = o.which ?? ((b: string) => resolveProgram(b, env));
  const exec = o.exec ?? nodeExec;
  const readFile = (f: string) => readFileSync(f, "utf8");
  return Promise.all(AGENT_ORDER.map(async (id): Promise<AgentProbe> => {
    const bin = which(BACKENDS[id].bin);
    if (!bin) return { id, status: "not-installed", path: null };
    try { return await probeOne(id, bin, env, exec, o.timeoutMs ?? 4000, readFile); } catch { return { id, status: "unknown", path: bin }; }
  }));
}

/** The first signed-in program, else the first that could not tell; `wanted` narrows the choice and gets a sentence when it cannot run. */
export function pickAgent(probes: readonly AgentProbe[], wanted?: string): AgentProbe {
  if (wanted) {
    const p = probes.find((x) => x.id === wanted);
    if (!p) throw new Error(`unknown agent ${wanted}; use ${AGENT_ORDER.join(", ")}`);
    if (p.status === "not-installed") throw new Error(`${wanted} is not installed.`);
    if (p.status === "signed-out") throw new Error(`${wanted} is installed but not signed in. Run \`${BACKENDS[p.id].login}\`, then try again.`);
    return p;
  }
  const p = probes.find((x) => x.status === "ready") ?? probes.find((x) => x.status === "unknown");
  if (p) return p;
  const out = probes.find((x) => x.status === "signed-out");
  if (out) throw new Error(`${out.id} is installed but not signed in. Run \`${BACKENDS[out.id].login}\`, then try again.`);
  throw new Error("No agent CLI found. Install Claude Code, Codex or opencode and sign in. stemap uses your login and needs no API key.");
}
