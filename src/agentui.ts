import { pathToFileURL } from "node:url";
import { basename } from "node:path";
import { confirm, intro, isCancel, log, outro, spinner } from "@clack/prompts";
import open from "open";
import { heldKeys, localAgent, pickAgent, probeAgents, type Agent, type AgentProbe } from "./agentcli";
import { fill, fix, renderFill, renderFix, review, type RunOptions, type Ui, type Verdict } from "./agentrun";
import type { PanelStore } from "./panel";
import { badge, butter, dim, elapsed, pink, sage } from "./term";

export interface AgentArgs { agent?: string; model?: string; effort?: string; jobs?: string; timeout?: string; yes?: boolean }

const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
const done = sage("◇");

/** Screen users get a rail of steps, and `fill` a live panel. Pipes and CI get plain lines to parse. */
function terminalUi(yes: boolean): Ui & { finish(): void } {
  if (!tty) return {
    line: (t) => console.log(t),
    busy: () => undefined,
    async approve(m) { console.log(m); if (!yes) console.error("Pass --yes to spend quota without a terminal."); return yes; },
    finish: () => undefined,
  };
  const spin = spinner({ frames: ["◐", "◓", "◑", "◒"].map(butter) });
  let shown = "";
  const busy = (t: string) => {
    if (t === shown) return;
    if (t && shown) spin.message(t);
    else if (t) spin.start(t);
    else spin.clear();
    shown = t;
  };
  const line = (t: string) => { const was = shown; busy(""); log.message(t, { symbol: done }); busy(was); };
  return {
    busy,
    line,
    async approve(m) {
      if (yes) return true;
      const was = shown;
      busy("");
      const ok = await confirm({ message: m });
      busy(was);
      return !isCancel(ok) && ok;
    },
    job(e) {
      if (e.type === "done") line(`${sage("✓")} ${e.tag}  ${dim(elapsed(e.ms))}`);
      if (e.type === "failed") line(`${pink("✕")} ${e.tag}  ${dim(e.message)}`);
    },
    finish: () => { busy(""); },
  };
}

/** The panel takes over the screen from the plan until the last job; the rail resumes for the summary. */
async function panelUi(base: Ui & { finish(): void }, head: PanelStore["head"], stop: () => void): Promise<{ ui: Ui & { finish(): void }; paused: () => boolean }> {
  if (!tty) return { ui: base, paused: () => false };
  const { PanelStore, showPanel } = await import("./panel");
  const store = new PanelStore(head, stop);
  let close: (() => void) | null = null;
  const ui: Ui & { finish(): void } = {
    ...base,
    busy: (t) => { if (!close) base.busy(t); },
    line: (t) => { if (close) { store.note = t.split("\n")[0]!; store.touch(); } else base.line(t); },
    job(e) {
      if (e.type === "plan" && !close) { base.busy(""); close = showPanel(store); }
      store.apply(e);
    },
    finish() { close?.(); close = null; base.finish(); },
  };
  return { ui, paused: () => store.paused };
}

export const firstReady = async (): Promise<AgentProbe | null> => (await probeAgents()).find((p) => p.status === "ready") ?? null;

async function prepare(repo: string, title: string, args: AgentArgs, live = false): Promise<{ agent: Agent; options: RunOptions; ui: Ui & { finish(): void } }> {
  if (tty) intro(badge(title));
  const probe = pickAgent(await probeAgents(), args.agent);
  const agent = localAgent({ id: probe.id, ...(args.model ? { model: args.model } : {}), ...(args.effort ? { effort: args.effort } : {}) });
  const base = terminalUi(Boolean(args.yes));
  base.line(`${probe.id}${probe.plan ? ` (${probe.plan})` : ""}, model ${agent.model}. It runs on your login, with no shell and no file access of its own.`);
  const keys = heldKeys(process.env);
  if (keys.length) base.line(`${keys.join(", ")} stays out of the agent's environment, so the run bills your login and not the API.`);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const { ui, paused } = live ? await panelUi(base, { title, repo: basename(repo), agent: [probe.id, probe.plan, agent.model].filter(Boolean).join(" · ") }, () => controller.abort()) : { ui: base, paused: () => false };
  const jobs = Number(args.jobs ?? 3), timeoutMin = Number(args.timeout);
  return { agent, ui, options: { agent, ui, signal: controller.signal, paused, jobs: jobs >= 1 ? jobs : 3, ...(timeoutMin > 0 ? { timeoutMin } : {}) } };
}

async function showPage(repo: string, ui: Ui) {
  const { entry } = await (await import("./flow")).page(repo);
  const url = pathToFileURL(entry).href;
  ui.line(url);
  if (tty) await open(url).catch(() => undefined);
}

const close = (text: string) => { if (tty) outro(dim(text)); };

export async function runFill(repo: string, args: AgentArgs & { flows?: string; replan?: boolean }): Promise<number> {
  const { options, ui } = await prepare(repo, "stemap fill", args, true);
  const r = await fill(repo, { ...options, ...(Number(args.flows) > 0 ? { flows: Number(args.flows) } : {}), ...(args.replan ? { replan: true } : {}) }).finally(() => ui.finish());
  if (!r) { ui.line("Nothing ran."); close("stemap fill continues from here"); return 0; }
  ui.line(renderFill(r));
  if (r.flows || r.modules) await showPage(repo, ui);
  close(r.failures.length || r.halted ? "stemap fill continues from here" : "The map is ready");
  return r.failures.length || r.halted ? 1 : 0;
}

export async function runFix(repo: string, args: AgentArgs): Promise<number> {
  const { options, ui } = await prepare(repo, "stemap fix", args);
  const r = await fix(repo, options).finally(() => ui.finish());
  if (!r) { ui.line("Nothing ran."); close("Nothing changed"); return 0; }
  ui.line(renderFix(r));
  close(r.left ? "Run stemap status to see what is left" : "Done");
  return r.left || r.failures.length ? 1 : 0;
}

const ORDER: Verdict["verdict"][] = ["false", "incomplete", "unsure", "true"];
const VERDICT = { false: pink, incomplete: pink, unsure: butter, true: sage };

export async function runReview(repo: string, args: AgentArgs & { size?: string }): Promise<number> {
  const { options, ui } = await prepare(repo, "stemap review", args);
  const r = await review(repo, { ...options, ...(Number(args.size) > 0 ? { size: Number(args.size) } : {}) }).finally(() => ui.finish());
  for (const v of [...r.verdicts].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict))) if (v.verdict !== "true") ui.line(`${VERDICT[v.verdict](v.verdict.padEnd(10))} ${v.id}\n           ${v.reason}`);
  const tally = ORDER.map((k) => `${r.verdicts.filter((v) => v.verdict === k).length} ${k}`).join(", ");
  ui.line(`${r.checked} claims judged: ${tally}.${r.skipped ? ` ${r.skipped} got no verdict.` : ""} ${r.usage}`);
  close("Nothing was changed");
  return r.verdicts.some((v) => v.verdict === "false" || v.verdict === "incomplete") || r.skipped ? 1 : 0;
}
