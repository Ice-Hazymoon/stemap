// Installs the packed tarball into a clean folder and drives it as a user would, under plain Node.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "stemap-smoke-"));
// `npm publish --dry-run` passes this down, and `npm pack` would then write no tarball.
const { npm_config_dry_run: _, ...inherited } = process.env;
const env = { ...inherited, XDG_DATA_HOME: join(work, "data"), XDG_CACHE_HOME: join(work, "cache") };
const run = (cmd, args, cwd, opts = {}) => execFileSync(cmd, args, { cwd, env: { ...env, ...opts.env }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input: opts.input });
const say = (s) => console.log(`ok  ${s}`);
const must = (cond, msg) => { if (!cond) throw new Error(`smoke failed: ${msg}`); };

try {
  const tarball = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], root))[0];
  const files = tarball.files.map((f) => f.path);
  must(files.includes("dist/cli.mjs") && files.includes("dist/web/index.html") && files.includes("LICENSE"), "tarball is missing files");
  must(!files.some((f) => /^(src|tests|docs|web\/|\.stemap)/.test(f)), "tarball holds source files");
  say(`packed ${tarball.filename}: ${files.length} files, ${(tarball.size / 1e6).toFixed(1)} MB`);

  const app = join(work, "install");
  mkdirSync(app);
  run("npm", ["init", "-y"], app);
  run("npm", ["install", "--no-audit", "--no-fund", join(work, tarball.filename)], app);
  const bin = join(app, "node_modules/.bin/stemap");
  say("installed");

  // Words a person gets wrong: a typo stops with a suggestion and never falls through to a compile.
  const typo = spawnSync(bin, ["statsu"], { cwd: app, env, encoding: "utf8" });
  must(typo.status === 1 && typo.stderr.includes("stemap status"), "a mistyped command should suggest the real one");
  const lost = spawnSync(bin, ["--no-open"], { cwd: work, env, encoding: "utf8" });
  must(lost.status === 1 && lost.stderr.includes("git repository") && !lost.stderr.includes("    at "), "outside a repository should be one sentence");
  must(run(bin, ["--help"], app).includes("Keep it true"), "help should group commands by what a person is doing");
  must(run(bin, ["status", "--help"], app).includes("stemap status"), "a command's help should name the command");
  say("mistakes");

  const repo = join(work, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  const code = `export function pay(amount: number) {\n  if (amount <= 0) throw new Error("bad amount");\n  return amount;\n}\n`;
  writeFileSync(join(repo, "src/pay.ts"), code);
  writeFileSync(join(repo, "package.json"), `{"name":"demo"}\n`);
  run("git", ["init", "-q", "-b", "main"], repo);
  run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], repo);
  run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], repo);

  const cli = (...args) => run(bin, args, repo, { env: { STEMAP_BIN: bin } });
  must(cli("init", "--yes").includes("stemap-bootstrap"), "init did not point at the next step");
  must(readFileSync(join(repo, ".claude/settings.json"), "utf8").includes("claude-pre"), "hooks were not written");
  say("init");

  const flow = { id: "pay", title: "Pay", actor: "Buyer", goal: "Pay", steps: [
    { id: "a", title: "Start", lane: "user", module: "src", kind: "start", text: "The buyer pays.", evidence: [{ path: "src/pay.ts", contains: "export function pay" }], next: [{ to: "b" }] },
    { id: "b", title: "Guard", lane: "service", module: "src", kind: "action", text: "The code refuses an amount of zero or less.", evidence: [{ path: "src/pay.ts", contains: "if (amount <= 0)" }], next: [{ to: "c" }] },
    { id: "c", title: "End", lane: "service", module: "src", kind: "end", text: "The code returns the amount.", evidence: [{ path: "src/pay.ts", contains: "return amount;" }] },
  ] };
  writeFileSync(join(work, "flow.json"), JSON.stringify(flow));
  must(cli("write", join(work, "flow.json")).includes("PASS"), "write failed");
  must(cli("status").includes("All 3 claims"), "status is not clean");
  say("write and status");
  must(JSON.parse(cli("agents", "--json")).length === 3, "agents did not list the three programs");
  say("agents");

  writeFileSync(join(repo, "src/pay.ts"), code.replace("return amount;", "return amount; // comment"));
  must(cli("status").includes("All 3 claims"), "a comment read as a change");
  writeFileSync(join(repo, "src/pay.ts"), code.replace("return amount;", "return amount; ".repeat(1) + "\n  // n\n").replace("if (amount <= 0)", "if (amount < 0)"));
  const drift = JSON.parse(cli("status", "--json"));
  must(drift.drift.some((d) => d.id === "flow/pay/b" && d.state === "lost"), "a changed quote was not reported");
  writeFileSync(join(repo, "src/pay.ts"), code.replace("return amount;", "return amount * 2;").replace("return amount * 2;", "return amount;\n  // kept"));
  say("drift");

  const payload = JSON.stringify({ session_id: "smoke", cwd: repo, tool_input: { file_path: join(repo, "src/pay.ts") } });
  must(run(bin, ["hook", "claude-pre"], repo, { input: payload }).includes("additionalContext"), "pre hook gave no context");
  say("hook");

  const out = cli("--no-open");
  const page = fileURLToPath(out.trim().split("\n").at(-1));
  const html = readFileSync(page, "utf8");
  must(!html.includes('type="module"'), "the page needs a module script, which file:// refuses");
  const bundle = readFileSync(join(dirname(page), "assets/app.js"), "utf8");
  must(!/fetch\(["'`]\/api/.test(bundle), "the page still calls a server");
  must(existsSync(join(dirname(page), "data/atlas.js")) && existsSync(join(dirname(page), "data/files/0.js")), "the page has no data");
  say("page compiled, no server");

  const single = join(work, "map.html");
  cli("--no-open", "--single", "--out", single);
  must(readFileSync(single, "utf8").includes("__stemap(\"atlas\""), "the single file has no data");
  say("single file");

  const server = spawn(bin, ["serve", "--port", "5299"], { cwd: repo, env, stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((done, fail) => {
      server.stdout.on("data", (d) => { if (String(d).includes("stemap http")) done(); });
      server.once("exit", () => fail(new Error("server exited")));
      setTimeout(() => fail(new Error("server timed out")), 30000);
    });
    must((await (await fetch("http://127.0.0.1:5299/")).text()).includes('id="root"'), "no page over HTTP");
    const home = await (await fetch("http://127.0.0.1:5299/")).text();
    const asset = /src="\.\/(assets\/app\.js\?v=[0-9a-f]+)"/.exec(home);
    must(asset && (await fetch(`http://127.0.0.1:5299/${asset[1]}`)).status === 200, "the stamped page code should load");
    must((await fetch("http://127.0.0.1:5299/../package.json")).status !== 200, "serve left the site folder");
    say("serve");
  } finally { server.kill("SIGTERM"); }
  console.log("smoke passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
