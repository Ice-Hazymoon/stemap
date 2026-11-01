import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cancel, confirm, intro, isCancel, log, multiselect, outro, select } from "@clack/prompts";
import { Config, dirSource, hasMap, loadMap, LOCK, mapDir, REPO_DIR, toYaml } from "./map";
import { homeOf } from "./repo";
import { folderLayout } from "./seed";
import { CURSOR_RULE, MARKER_BODY, MARKER_END, MARKER_START, SKILLS, WORKFLOW } from "./templates";
import { VERSION } from "./version";
import { writeLock } from "./lock";

type Agent = "claude" | "codex" | "cursor";
type Lang = "en" | "zh";
const AGENTS: Agent[] = ["claude", "codex", "cursor"];
export interface InitOptions { yes?: boolean; local?: boolean; fill?: boolean; agents?: string[]; languages?: string[] }

interface Generated { version: string; agents: Agent[]; workflow: boolean; files: Record<string, string> }

const GENERATED = "generated.json";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY);

/** A pinned npx call is the default; STEMAP_BIN lets tests run the local build instead. */
const pinned = () => `npx --yes stemap@${VERSION === "dev" ? "latest" : VERSION}`;
const runner = () => process.env.STEMAP_BIN?.trim() || pinned();
const render = (text: string) => text.replaceAll("{{stemap}}", runner()).replaceAll("{{version}}", VERSION === "dev" ? "latest" : VERSION);

const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : null);
function put(f: string, text: string) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); }

function readJson(f: string): Record<string, unknown> {
  const text = read(f);
  if (!text?.trim()) return {};
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error(`${f} is not plain JSON, so stemap cannot merge into it. Remove its comments and run init again.`); }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${f} is not a JSON object`);
  return v as Record<string, unknown>;
}

const git = (repo: string, args: string[]) => {
  try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
};

function defaultBranch(repo: string): string {
  const head = git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "");
  if (head) return head;
  for (const b of ["main", "master"]) if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])) return b;
  return "main";
}

function repoName(repo: string): string {
  try {
    const name = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { name?: unknown }).name;
    if (typeof name === "string" && name) return name;
  } catch { /* no package.json */ }
  return basename(repo);
}

/** Written once: an existing map document is the user's work and is never replaced. */
function seedMap(repo: string, dir: string, languages: Lang[], local: boolean): string[] {
  const wrote: string[] = [];
  const once = (rel: string, text: string) => {
    const f = join(dir, rel);
    if (existsSync(f)) return;
    put(f, text);
    wrote.push(rel);
  };
  const layout = folderLayout(repo, []);
  const config = Config.parse({ name: repoName(repo), languages, base: defaultBranch(repo) });
  once("config.yaml", toYaml(config));
  once("system.yaml", toYaml({ title: repoName(repo), groups: layout.groups }));
  for (const n of layout.nodes) once(`modules/${n.id}.yaml`, toYaml({ id: n.id, title: n.id, paths: n.paths }));
  if (!existsSync(join(dir, LOCK))) { writeLock(dir, new Map()); wrote.push(LOCK); }
  if (!local) wrote.push(...gitattributes(repo));
  return wrote;
}

function gitattributes(repo: string): string[] {
  const f = join(repo, ".gitattributes");
  const line = `${REPO_DIR}/${LOCK} merge=union`;
  const text = read(f) ?? "";
  if (text.split("\n").some((l) => l.trim() === line)) return [];
  put(f, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
  return [".gitattributes"];
}

interface Plan { agents: Agent[]; workflow: boolean }

/** Template files: overwritten only while they still equal what we wrote, so a hand edit is never lost. */
function place(repo: string, rel: string, text: string, gen: Generated, report: { wrote: string[]; kept: string[] }) {
  const f = join(repo, rel);
  const cur = read(f);
  if (cur === text) { gen.files[rel] = sha(text); return; }
  if (cur !== null && sha(cur) !== gen.files[rel]) { report.kept.push(rel); return; }
  put(f, text);
  gen.files[rel] = sha(text);
  report.wrote.push(rel);
}

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] };

/** Replace our own entry (found by its `hook <name>` suffix) or append one; every other key stays. */
function mergeHook(settings: Record<string, unknown>, event: string, name: string, entry: HookEntry) {
  const hooks = (typeof settings.hooks === "object" && settings.hooks !== null ? settings.hooks : {}) as Record<string, HookEntry[]>;
  const list = Array.isArray(hooks[event]) ? hooks[event]! : [];
  const mine = (e: HookEntry) => e.hooks?.some((h) => h.command?.endsWith(` hook ${name}`));
  const at = list.findIndex(mine);
  if (at >= 0) list[at] = entry; else list.push(entry);
  hooks[event] = list;
  settings.hooks = hooks;
}

function wireClaude(repo: string) {
  const f = join(repo, ".claude/settings.json");
  const settings = readJson(f);
  const cmd = (name: string) => `${runner()} hook ${name}`;
  mergeHook(settings, "PreToolUse", "claude-pre", { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: cmd("claude-pre"), timeout: 10 }] });
  mergeHook(settings, "Stop", "claude-stop", { hooks: [{ type: "command", command: cmd("claude-stop"), timeout: 30 }] });
  put(f, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Add our server entry, but leave one the user pointed somewhere else. */
function mergeMcp(f: string) {
  const json = readJson(f);
  const servers = (typeof json.mcpServers === "object" && json.mcpServers !== null ? json.mcpServers : {}) as Record<string, { command?: string; args?: string[] } | undefined>;
  const cur = servers.stemap;
  const ours = !cur || JSON.stringify(cur).includes("stemap");
  if (ours) {
    const [command = "npx", ...args] = runner().split(/\s+/);
    servers.stemap = { command, args: [...args, "mcp"] };
  }
  json.mcpServers = servers;
  put(f, `${JSON.stringify(json, null, 2)}\n`);
}

function marker(repo: string, plan: Plan): string {
  const name = plan.agents.some((a) => a !== "claude") || existsSync(join(repo, "AGENTS.md")) ? "AGENTS.md" : "CLAUDE.md";
  const f = join(repo, name);
  const block = `${MARKER_START}\n${render(MARKER_BODY)}\n${MARKER_END}`;
  const text = read(f) ?? "";
  const re = new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`);
  put(f, re.test(text) ? text.replace(re, () => block) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}\n`);
  return name;
}

/** Everything agent-facing. Init and upgrade share it, so a rerun is the same code path as a first run. */
function wire(repo: string, dir: string, plan: Plan, gen: Generated) {
  const report = { wrote: [] as string[], kept: [] as string[] };
  const skillRoots = new Set<string>();
  if (plan.agents.includes("claude")) skillRoots.add(".claude/skills");
  if (plan.agents.includes("codex") || plan.agents.includes("cursor")) skillRoots.add(".agents/skills");
  for (const root of skillRoots) for (const [id, text] of Object.entries(SKILLS)) place(repo, `${root}/${id}/SKILL.md`, render(text), gen, report);
  if (plan.agents.includes("claude")) { wireClaude(repo); mergeMcp(join(repo, ".mcp.json")); report.wrote.push(".claude/settings.json", ".mcp.json"); }
  if (plan.agents.includes("cursor")) { place(repo, ".cursor/rules/stemap.mdc", render(CURSOR_RULE), gen, report); mergeMcp(join(repo, ".cursor/mcp.json")); report.wrote.push(".cursor/mcp.json"); }
  report.wrote.push(marker(repo, plan));
  if (plan.workflow) place(repo, ".github/workflows/stemap.yml", render(WORKFLOW), gen, report);
  gen.version = VERSION;
  gen.agents = plan.agents;
  gen.workflow = plan.workflow;
  put(join(dir, GENERATED), `${JSON.stringify(gen, null, 2)}\n`);
  return report;
}

const loadGenerated = (dir: string): Generated => {
  try {
    const g = JSON.parse(read(join(dir, GENERATED)) ?? "") as Partial<Generated>;
    return { version: g.version ?? "", agents: g.agents ?? [], workflow: Boolean(g.workflow), files: g.files ?? {} };
  } catch { return { version: "", agents: [], workflow: false, files: {} }; }
};

const pickAgents = (given: string[] | undefined): Agent[] | null => {
  const list = (given ?? []).map((a) => a.trim()).filter(Boolean);
  const bad = list.filter((a) => !AGENTS.includes(a as Agent));
  if (bad.length) throw new Error(`unknown agent ${bad.join(", ")}; use ${AGENTS.join(", ")}`);
  return list.length ? list as Agent[] : null;
};

async function ask<T>(p: Promise<T>): Promise<Exclude<T, symbol>> {
  const v = await p;
  if (isCancel(v)) { cancel("Nothing changed."); process.exit(0); }
  return v as Exclude<T, symbol>;
}

export async function init(repo: string, opts: InitOptions) {
  const interactive = tty && !opts.yes;
  const guess = AGENTS.filter((a) => (a === "claude" ? existsSync(join(repo, ".claude")) : a === "cursor" ? existsSync(join(repo, ".cursor")) : existsSync(join(repo, "AGENTS.md"))));
  let agents = pickAgents(opts.agents);
  let languages = (opts.languages ?? []).map((l) => l.trim()).filter(Boolean) as Lang[];
  if (languages.some((l) => l !== "en" && l !== "zh")) throw new Error("languages: use en, zh or en,zh");
  let local = Boolean(opts.local);
  let workflow = existsSync(join(repo, ".github"));
  const existing = hasMap(repo);

  if (interactive) {
    intro((await import("./term")).badge("stemap init"));
    agents ??= await ask(multiselect<Agent>({ message: "Which agents should the map serve?", options: AGENTS.map((a) => ({ value: a, label: a })), initialValues: guess.length ? guess : ["claude"], required: true }));
    if (!languages.length && !existing) languages = (await ask(select<Lang[]>({ message: "Content languages", options: [{ value: ["en"], label: "en" }, { value: ["en", "zh"], label: "en + zh" }] })));
    if (!existing && !opts.local) local = (await ask(select<boolean>({ message: "Where does the map live?", options: [{ value: false, label: "In the repository (recommended)", hint: ".stemap/" }, { value: true, label: "In the local data folder", hint: "not committed" }] })));
    workflow = await ask(confirm({ message: "Add a GitHub Actions check for pull requests?", initialValue: workflow }));
  }
  agents ??= ["claude"];
  if (!languages.length) languages = ["en"];

  // Fail on a file we cannot merge before anything is written, so a refused init leaves no half-made setup.
  for (const f of [agents.includes("claude") && ".claude/settings.json", agents.includes("claude") && ".mcp.json", agents.includes("cursor") && ".cursor/mcp.json"]) if (f) readJson(join(repo, f));
  const dir = existing ? mapDir(repo) : local ? join(homeOf(repo), "map") : join(repo, REPO_DIR);
  const isLocal = !dir.startsWith(`${repo}/`);
  const wrote = seedMap(repo, dir, existing ? loadMap(dirSource(dir)).config.languages : languages, isLocal);
  const prior = loadGenerated(dir);
  const report = wire(repo, dir, { agents, workflow }, prior);
  const all = [...wrote.map((w) => (w === ".gitattributes" ? w : `${dir.startsWith(repo) ? relativeTo(repo, dir) : dir}/${w}`)), ...report.wrote, `${dir.startsWith(repo) ? relativeTo(repo, dir) : dir}/${GENERATED}`];
  summary(all, report.kept, agents, interactive);
  await offerFill(repo, opts, interactive);
}

/** A person with a signed-in agent should not have to leave init to get a useful map. */
async function offerFill(repo: string, opts: InitOptions, interactive: boolean) {
  if (!opts.fill && !interactive) return;
  const { firstReady, runFill } = await import("./agentui");
  const ready = await firstReady();
  if (!ready) { if (opts.fill) throw new Error("No signed-in agent CLI found, so the map stays empty. Run `stemap agents` to see why."); return; }
  if (!opts.fill && !await ask(confirm({ message: `Fill the map now with ${ready.id}? It runs on your login, and you see the plan first.` }))) return;
  const code = await runFill(repo, { agent: ready.id, yes: opts.yes });
  if (code) process.exit(code);
}

const relativeTo = (repo: string, dir: string) => dir.slice(repo.length + 1);

function summary(wrote: string[], kept: string[], agents: Agent[], interactive: boolean) {
  const lines = [`Wrote or refreshed ${wrote.length} file(s):`, ...wrote.map((w) => `  ${w}`)];
  if (kept.length) lines.push("Kept (edited by hand, not overwritten):", ...kept.map((k) => `  ${k}`));
  const inside = agents.includes("claude") ? "open Claude Code here and run /stemap-bootstrap" : "ask your agent to follow the stemap-bootstrap skill";
  const tail = `Next: run \`npx stemap fill\`, or ${inside}.\nThen run \`npx stemap\` to see the map.`;
  if (interactive) { log.info(lines.join("\n")); outro(tail); } else console.log(`${lines.join("\n")}\n${tail}`);
}

/** Regenerate skills, rules and workflow at the running version; files edited since the last run stay as they are. */
export async function upgrade(repo: string) {
  if (!hasMap(repo)) throw new Error(`no map in ${repo}; run \`stemap init\` first`);
  const dir = mapDir(repo);
  const gen = loadGenerated(dir);
  if (!gen.agents.length) throw new Error(`${join(dir, GENERATED)} is missing; run \`stemap init\` first`);
  const report = wire(repo, dir, { agents: gen.agents, workflow: gen.workflow }, gen);
  console.log(`stemap ${VERSION}: refreshed ${report.wrote.length} file(s).`);
  for (const k of report.kept) console.log(`kept ${k}: edited since it was generated; delete it and rerun to take the new text.`);
}
