import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** `STEMAP_REPO` points the tool at another checkout; a hook passes the directory it was called in. */
export function repoRoot(from?: string): string {
  const start = resolve(from ?? process.env.STEMAP_REPO ?? process.cwd());
  try {
    const top = execFileSync("git", ["-C", start, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return realpathSync(top);
  } catch {
    throw new Error(`${start} is not inside a git repository. Run stemap in a repository, or run git init here first.`);
  }
}

const DATA = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "stemap");
const clean = (s: string) => s.replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "") || "repo";

/** Two repos with one folder name must not share data; the first one to write REPO owns the plain slug. */
export function homeOf(root: string): string {
  const slug = clean(basename(root));
  const plain = join(DATA, slug);
  const owner = join(plain, "REPO");
  if (!existsSync(owner) || readFileSync(owner, "utf8").trim() === root) return plain;
  return join(DATA, `${slug}-${createHash("sha1").update(root).digest("hex").slice(0, 6)}`);
}
