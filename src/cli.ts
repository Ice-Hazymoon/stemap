#!/usr/bin/env node
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cancel, confirm, intro, isCancel, log, spinner } from "@clack/prompts";
import { defineCommand, runMain } from "citty";
import open from "open";
import { repoRoot, homeOf } from "./repo";
import { VERSION } from "./version";

const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
const secs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

const pageArgs = {
  out: { type: "string", description: "Also write the page here: a folder, or a file with --single" },
  single: { type: "boolean", description: "Write one self-contained HTML file with --out" },
  open: { type: "boolean", description: "Open the page in the browser", default: true },
} as const;

/** Query commands read the saved index; a repo with none, or one behind HEAD, gets a build first. */
async function ready(repo: string) {
  return (await import("./flow")).ensureTarget(repo);
}

const argsOf = (a: { _: string[] }) => a._;
const positional = { positional: { type: "positional", required: false, description: "Arguments" } } as const;
const asJson = (o: unknown) => console.log(JSON.stringify(o, null, 1));

const agentArgs = {
  agent: { type: "string", description: "claude, codex or opencode (default: the first one signed in)" },
  model: { type: "string", description: "Model name the program accepts (default: sonnet for claude, the account default otherwise)" },
  effort: { type: "string", description: "low, medium or high, where the program has it" },
  jobs: { type: "string", description: "Agent calls at once, up to 6", default: "3" },
  timeout: { type: "string", description: "Minutes per agent call" },
  yes: { type: "boolean", description: "Do not ask before spending quota", alias: "y" },
} as const;

const subCommands = {
  agents: defineCommand({ meta: { description: "List the agent programs on this computer and whether they are signed in" }, args: { json: { type: "boolean", description: "Print JSON" } }, async run({ args }) {
    const { probeAgents } = await import("./agentcli");
    const probes = await probeAgents();
    if (args.json) asJson(probes);
    else {
      const { butter, dim, sage } = await import("./term");
      for (const p of probes) console.log(`${p.id.padEnd(9)} ${(p.status === "ready" ? sage : butter)(p.status.padEnd(14))} ${(p.plan ?? "").padEnd(9)} ${dim(p.path ?? "")}`.trimEnd());
    }
  } }),
  fill: defineCommand({ meta: { description: "Have your local agent write the map: one call per flow, then the modules" }, args: {
    ...agentArgs,
    flows: { type: "string", description: "Most flows to plan", default: "10" },
    replan: { type: "boolean", description: "Drop the saved plan and make a new one" },
  }, async run({ args }) {
    process.exit(await (await import("./agentui")).runFill(repoRoot(), args));
  } }),
  fix: defineCommand({ meta: { description: "Have your local agent resolve every claim the code no longer backs" }, args: agentArgs, async run({ args }) {
    process.exit(await (await import("./agentui")).runFix(repoRoot(), args));
  } }),
  review: defineCommand({ meta: { description: "Have a fresh agent judge a sample of claims; nothing is changed" }, args: {
    ...agentArgs,
    size: { type: "string", description: "Claims to sample", default: "20" },
  }, async run({ args }) {
    process.exit(await (await import("./agentui")).runReview(repoRoot(), args));
  } }),
  init: defineCommand({ meta: { description: "Set up a map and agent wiring in this repository" }, args: {
    yes: { type: "boolean", description: "Accept every default, for scripts", alias: "y" },
    local: { type: "boolean", description: "Keep the map outside the repository" },
    agents: { type: "string", description: "Comma list: claude,codex,cursor" },
    languages: { type: "string", description: "Comma list: en,zh" },
    fill: { type: "boolean", description: "Fill the map with your local agent right after setup" },
  }, async run({ args }) {
    await (await import("./init")).init(repoRoot(), { yes: args.yes, local: args.local, fill: args.fill, agents: args.agents?.split(","), languages: args.languages?.split(",") });
  } }),
  status: defineCommand({ meta: { description: "List claims the code no longer backs" }, args: {
    json: { type: "boolean", description: "Print JSON" },
    all: { type: "boolean", description: "List every claim on screen" },
    ...positional,
  }, async run({ args }) {
    const { open: openMap, status, renderStatus } = await import("./maint");
    const r = status(openMap(repoRoot()), { files: argsOf(args) });
    if (args.json) asJson({ checked: r.checked, errors: r.errors, drift: r.drift.map((d) => ({ id: d.claim.id, state: d.state, file: d.claim.file, text: d.claim.claim.text, changed: d.changed, candidates: d.anchors.flatMap((a) => a.candidates) })), hints: r.hints.map((h) => ({ id: h.claim.id, via: h.via })) });
    else console.log(tty ? (await import("./term")).renderStatusScreen(r, Boolean(args.all)) : renderStatus(r));
  } }),
  check: defineCommand({ meta: { description: "Fail when this change left the map behind" }, args: {
    base: { type: "string", description: "Branch to compare with (default: config base)" },
    all: { type: "boolean", description: "Compare with nothing: every finding counts" },
    "no-index": { type: "boolean", description: "Skip the call-graph checks" },
    format: { type: "string", description: "text, json or github", default: "text" },
  }, async run({ args }) {
    const { check, renderGithub, renderSummary, renderText, writeSummary } = await import("./check");
    const { open: openMap } = await import("./maint");
    const repo = repoRoot();
    const base = args.all ? undefined : args.base ?? openMap(repo).map.config.base;
    const r = await check(repo, { base, index: args["no-index"] ? false : undefined });
    if (args.format === "json") asJson(r);
    else if (args.format === "github") { console.log(renderGithub(r)); writeSummary(renderSummary(r)); console.log(renderText(r)); }
    else console.log(renderText(r));
    process.exit(r.ok ? 0 : 1);
  } }),
  confirm: defineCommand({ meta: { description: "Keep claims after rereading them: confirm <id...> -m <reason>" }, args: {
    message: { type: "string", alias: "m", description: "Why the claim still holds", required: true },
    ...positional,
  }, async run({ args }) {
    const { open: openMap, confirm: accept } = await import("./maint");
    const ids = argsOf(args);
    if (!ids.length) throw new Error("usage: stemap confirm <claim id...> -m <reason>");
    const done = accept(openMap(repoRoot()), ids, args.message);
    console.log(`Confirmed ${done.length} of ${ids.length}.`);
  } }),
  write: defineCommand({ meta: { description: "Check a flow or module document and add it to the map" }, args: positional, async run({ args }) {
    const { open: openMap, write } = await import("./maint");
    const files = argsOf(args);
    if (!files.length) throw new Error("usage: stemap write <file...>");
    const w = openMap(repoRoot());
    let ok = true;
    for (const f of files) {
      const r = await write(w, f);
      console.log(`${r.report.ok ? "PASS" : "FAIL"} ${r.file}: ${r.report.claims} claims, ${r.report.hard.length} faults`);
      for (const x of [...r.report.hard, ...r.report.soft].slice(0, 60)) console.log(`  ${x.key} [${x.rule}] ${x.message}`);
      ok &&= r.report.ok;
    }
    process.exit(ok ? 0 : 1);
  } }),
  reanchor: defineCommand({ meta: { description: "Follow quotes that moved to another file" }, args: { apply: { type: "boolean", description: "Rewrite the paths" } }, async run({ args }) {
    const { open: openMap, reanchor } = await import("./maint");
    const r = reanchor(openMap(repoRoot()), Boolean(args.apply));
    for (const m of r.moves) console.log(`${m.id}: ${m.from} -> ${m.to}`);
    if (r.unresolved.length) console.log(`${r.unresolved.length} claim(s) have no single new place: ${r.unresolved.slice(0, 10).join(", ")}`);
    if (r.moves.length && !args.apply) console.log("Run again with --apply to rewrite these paths.");
  } }),
  context: defineCommand({ meta: { description: "Print what to know before editing a file" }, args: positional, async run({ args }) {
    const { open: openMap, context } = await import("./maint");
    console.log(context(openMap(repoRoot()), argsOf(args)[0] ?? "") ?? "This file has no map entries.");
  } }),
  flow: defineCommand({ meta: { description: "Print one flow as text: flow <id>" }, args: positional, async run({ args }) {
    const { open: openMap, renderFlow } = await import("./maint");
    const w = openMap(repoRoot());
    const id = argsOf(args)[0];
    if (!id) { for (const f of w.map.flows) console.log(`${f.doc.id}  ${f.doc.title}`); return; }
    console.log(renderFlow(w, id) ?? `no flow ${id}`);
  } }),
  reconcile: defineCommand({ meta: { description: "Print a sample of claims for an independent review" }, args: { size: { type: "string", description: "Claims to sample", default: "20" } }, async run({ args }) {
    const { open: openMap, reconcile } = await import("./maint");
    asJson(reconcile(openMap(repoRoot()), Number(args.size)));
  } }),
  candidates: defineCommand({ meta: { description: "List entry points worth a flow, most consequential first" }, args: { json: { type: "boolean", description: "Print JSON" } }, async run({ args }) {
    const t = await ready(repoRoot());
    const list = (await import("./candidates")).candidates(t.home);
    if (args.json) asJson(list);
    else for (const c of list.slice(0, 30)) console.log(`${c.kind.padEnd(6)} ${c.label}  writes ${c.tables.length ? c.tables.join(", ") : "nothing"}  (${c.file})`);
  } }),
  upgrade: defineCommand({ meta: { description: "Regenerate skills, rules and hooks; edited files are kept" }, async run() {
    await (await import("./init")).upgrade(repoRoot());
  } }),
  hook: defineCommand({ meta: { description: "Agent hook entry point: hook <claude-pre|claude-stop>" }, args: positional, async run({ args }) {
    await (await import("./hooks")).runHook(argsOf(args)[0] ?? "");
  } }),
  mcp: defineCommand({ meta: { description: "Serve map queries to agents over MCP on stdio" }, async run() {
    await (await import("./mcp")).serveMcp(repoRoot());
  } }),
  index: defineCommand({ meta: { description: "Rebuild the code index and check it" }, async run() {
    const { build } = await import("./flow");
    const b = await build(repoRoot());
    console.log(b.index.stats);
    const c = (await import("./indexcheck")).checkIndex(b.index, b.root);
    console.log(`call precision ${(c.precision * 100).toFixed(1)}% of ${c.sampled}, write recall ${(c.recall * 100).toFixed(1)}% of ${c.writes}`);
    if (!c.ok) { console.error("index check failed: a rate fell under the floor"); process.exit(1); }
  } }),
  links: defineCommand({ meta: { description: "Show an entity's links: links <id or words>" }, args: positional, async run({ args }) {
    const arg = argsOf(args).join(" ");
    const t = await ready(repoRoot());
    const g = (await import("./site")).loadGraph(t.home);
    const id = g.has(arg) ? arg : g.search(arg)[0]?.id;
    if (!id) { console.error(`nothing matches ${arg}`); process.exit(1); }
    const v = g.entity(id)!;
    console.log(`${v.kind}  ${v.title}  (${id})`);
    for (const s of v.groups) {
      console.log(`\n${s.title} (${s.total})`);
      for (const x of s.items.slice(0, 12)) console.log(`  ${x.label}${x.hint ? `  — ${x.hint}` : ""}`);
    }
  } }),
  logic: defineCommand({ meta: { description: "Print a function's logic tree: logic <fn id>" }, args: positional, async run({ args }) {
    const t = await ready(repoRoot());
    const f = (await import("./site")).loadGraph(t.home).fn(argsOf(args).join(" "));
    asJson(f ? { ...(await import("./logic")).logicOf(t.root, f.file, f.line, f.end), file: f.file } : null);
  } }),
  serve: defineCommand({ meta: { description: "Share the compiled page over HTTP, for a browser on another machine" }, args: {
    port: { type: "string", description: "Port to listen on", default: "5177" },
    host: { type: "string", description: "Address to bind", default: "127.0.0.1" },
  }, async run({ args }) {
    const repo = repoRoot();
    const { page } = await import("./flow");
    await page(repo);
    await (await import("./serve")).serveSite((await import("./site")).siteDir(homeOf(repo)), Number(args.port), args.host);
    console.log(`stemap http://${args.host}:${args.port}`);
  } }),
};

/** Bare `stemap`: confirm the repo, compile whatever is stale, open the page. No server starts and no port is taken. */
async function bare(args: { out?: string; single?: boolean; open: boolean }) {
  const repo = repoRoot();
  const { compute, describeRepo, page } = await import("./flow");
  const info = describeRepo(repo);
  const summary = `${repo}  (${info.framework}, ${info.files} source files)`;
  if (tty) {
    intro((await import("./term")).badge("stemap"));
    const ok = await confirm({ message: `Map ${summary}?` });
    if (isCancel(ok) || !ok) { cancel("Nothing changed."); return; }
  } else console.log(`stemap ${summary}`);

  const { butter } = await import("./term");
  const spin = spinner({ frames: ["◐", "◓", "◑", "◒"].map(butter) });
  const step = async <T,>(label: string, fn: () => Promise<T> | T): Promise<T> => {
    const t = performance.now();
    if (tty) spin.start(label); else console.log(`${label}...`);
    try {
      const out = await fn();
      const msg = `${label} ${secs(performance.now() - t)}`;
      if (tty) spin.stop(msg); else console.log(msg);
      return out;
    } catch (e) {
      if (tty) spin.error(`${label} failed`);
      throw e;
    }
  };

  const { entry, built: fresh } = await page(repo, step);
  if (!fresh) log.info("The page is current; nothing to compile.");
  let target = entry;
  if (args.out) {
    const site = await import("./site");
    const out = resolve(args.out);
    const b = fresh ?? await compute(repo);
    if (args.single) {
      const r = site.compileSingle(b, repo, out);
      console.log(`${(r.bytes / 1e6).toFixed(1)} MB with the source of ${r.files} cited files`);
      target = out;
    } else {
      site.compileSite(b, repo, out);
      target = join(out, "index.html");
    }
  }
  const url = pathToFileURL(target).href;
  console.log(url);
  if (fresh && !fresh.atlas.mapped) log.info("Next: stemap init sets up the map, then stemap fill has your agent write it.");
  if (args.open && tty) await open(url).catch(() => undefined);
}

const meta = { name: "stemap", version: VERSION, description: "A map of your code that agents keep true" };
const fail = (e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); };
const bareCommand = defineCommand({ meta, args: pageArgs, async run({ args }) { await bare(args).catch(fail); } });
const main = defineCommand({ meta, subCommands });
// citty prints a stack for anything thrown; a missing map or a signed-out agent is a sentence for the person.
for (const [name, c] of Object.entries(subCommands)) {
  // Without its own name a command's --help prints the path of this script.
  c.meta = { ...(c.meta as object), name };
  const run = c.run!;
  c.run = (async (ctx: never) => { try { return await (run as (x: never) => unknown)(ctx); } catch (e) { fail(e); } }) as typeof c.run;
}

type Command = keyof typeof subCommands;
/** Commands by what a person is doing, in the order they meet them. `hook` is called by agents and stays out of the list. */
const GROUPS: [string, Command[]][] = [
  ["Write the map", ["init", "agents", "fill", "fix", "review"]],
  ["Keep it true", ["status", "check", "confirm", "reanchor", "write", "upgrade"]],
  ["Read it", ["flow", "links", "logic", "context", "candidates", "index", "serve"]],
  ["For agents", ["mcp", "reconcile"]],
];

async function help() {
  const { badge, bold, dim, sage } = await import("./term");
  const line = (name: string, what: string) => `  ${sage(name.padEnd(12))}${what}`;
  const about = (c: Command) => (subCommands[c] as { meta?: { description?: string } }).meta?.description ?? "";
  console.log(`\n${badge("stemap")} ${dim(`v${VERSION}`)}  ${meta.description}\n\n${line("stemap", "Compile this repository into a page and open it. Needs no server and no port.")}\n${dim("  --out <dir>  also write the page there   --single  make it one HTML file   --no-open  print the path only")}\n`);
  for (const [title, list] of GROUPS) console.log(`${bold(title)}\n${list.map((c) => line(c, about(c))).join("\n")}\n`);
  console.log(dim("stemap <command> --help shows the flags of a command."));
}

/** A typo must not fall through to a full compile. Edit distance is enough for one or two slips in a short word. */
function closest(word: string) {
  const far = (a: string, b: string) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let last = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) { const old = row[j]!; row[j] = Math.min(old + 1, row[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1)); last = old; }
    }
    return row[b.length]!;
  };
  return Object.keys(subCommands).map((c) => [c, far(word, c)] as const).sort((x, y) => x[1] - y[1]).find(([, d]) => d <= 2)?.[0];
}

// citty reads a flag's value (`--out dist`) as a subcommand name, so the command word is found here instead.
const argv = process.argv.slice(2);
const word = argv.find((a, i) => !a.startsWith("-") && argv[i - 1] !== "--out");
if (word && !(word in subCommands) && word !== "help") {
  const near = closest(word);
  console.error(`Unknown command: ${word}.${near ? ` Did you mean stemap ${near}?` : ""} stemap --help lists them all.`);
  process.exit(1);
}
const wantsHelp = argv.includes("--help") || argv.includes("-h");
if (word === "help" || (!word && wantsHelp)) await help();
else (word ? runMain(main) : runMain(bareCommand)).catch(fail);
