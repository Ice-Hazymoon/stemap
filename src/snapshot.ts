import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeOf } from "./repo";

export interface SnapshotInfo { repo: string; home: string; sha: string; created: boolean; dir: string }

const git = (repo: string, args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Extract the committed tree only: the working tree holds other sessions' edits and ignored secrets. */
function extract(repo: string, sha: string, into: string): Promise<void> {
  return new Promise((done, fail) => {
    mkdirSync(into, { recursive: true });
    const archive = spawn("git", ["-C", repo, "archive", "--format=tar", sha], { stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-C", into], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    archive.stderr.on("data", (d) => (err += d));
    tar.stderr.on("data", (d) => (err += d));
    archive.stdout.pipe(tar.stdin);
    const codes: number[] = [];
    const end = (code: number | null) => {
      codes.push(code ?? 1);
      if (codes.length < 2) return;
      if (codes.some((c) => c !== 0)) fail(new Error(`git archive failed: ${err.slice(0, 300)}`));
      else done();
    };
    archive.on("error", fail);
    tar.on("error", fail);
    archive.on("close", end);
    tar.on("close", end);
  });
}

export function headSha(repo: string): string {
  try { return git(repo, ["rev-parse", "--verify", "HEAD"]); } catch { throw new Error(`${repo} has no commits yet`); }
}

export function currentSha(home: string): string | null {
  const file = join(home, "CURRENT");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

/** An existing `<home>/<sha>` is reused as is; the directory appears only once the extract is whole. */
export async function ensureSnapshot(repo: string, ref = "HEAD", pin = true): Promise<SnapshotInfo> {
  const home = homeOf(repo);
  const sha = ref === "HEAD" ? headSha(repo) : git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const dir = join(home, sha);
  let created = false;
  if (!existsSync(dir)) {
    mkdirSync(home, { recursive: true });
    const tmp = join(home, `.tmp-${sha}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    try { await extract(repo, sha, tmp); renameSync(tmp, dir); } finally { rmSync(tmp, { recursive: true, force: true }); }
    created = true;
  }
  if (!existsSync(join(home, "REPO"))) writeFileSync(join(home, "REPO"), repo + "\n");
  if (pin && currentSha(home) !== sha) writeFileSync(join(home, "CURRENT"), sha + "\n");
  prune(home);
  return { repo, home, sha, created, dir };
}

/** Each snapshot is a full copy of the tree, so only the served one and the latest two stay. */
function prune(home: string) {
  const current = currentSha(home);
  const all = readdirSync(home, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^[0-9a-f]{40}$/.test(e.name))
    .map((e) => ({ name: e.name, at: statSync(join(home, e.name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const s of all.slice(2)) if (s.name !== current) rmSync(join(home, s.name), { recursive: true, force: true });
}
