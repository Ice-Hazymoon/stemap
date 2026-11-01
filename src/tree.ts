import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

/** One read-only view of the repository, so every check runs the same way on the working tree and on a commit. */
export interface Tree {
  label: string;
  read(path: string): string | null;
  /** Every path git would commit, including new files that are not ignored. */
  list(): string[];
  /** Code that holds this exact text. The map itself quotes it, so the map is left out. */
  grep(text: string): string[];
  /** Fill the read cache in one git call, because one process per file is slow on a large map. */
  prefetch(paths: string[]): void;
}

const git = (root: string, args: string[], input?: string) => spawnSync("git", ["-C", root, "-c", "core.quotepath=off", ...args], { maxBuffer: 1 << 30, input });
const lines0 = (b: Buffer) => b.toString("utf8").split("\0").filter(Boolean);

/** Files no map should quote and no page should show, even when someone committed them. */
const SECRET = /^(\.env.*|\.aws|\.ssh|\.gnupg|\.git|secrets?|credentials?(\..*)?|id_(rsa|dsa|ecdsa|ed25519).*|.*\.(pem|key|p12|pfx))$/i;

/** A cited path can never leave the repository. */
export const readable = (path: string) => {
  const p = normalize(path).replaceAll("\\", "/");
  return !p.startsWith("..") && !p.startsWith("/") && !p.split("/").some((part) => SECRET.test(part));
};

/** A committed symlink can point anywhere, so the real path decides. */
export function inside(root: string, full: string): boolean {
  try { return realpathSync(full).startsWith(realpathSync(root) + sep); } catch { return false; }
}

export function workTree(root: string): Tree {
  const cache = new Map<string, string | null>();
  return {
    label: "working tree",
    read(path) {
      if (!readable(path)) return null;
      if (!cache.has(path)) {
        const full = join(root, path);
        cache.set(path, existsSync(full) && inside(root, full) && statSync(full).isFile() ? readFileSync(full, "utf8") : null);
      }
      return cache.get(path)!;
    },
    list: () => lines0(git(root, ["ls-files", "-c", "-o", "--exclude-standard", "-z"]).stdout).filter((p) => existsSync(join(root, p))),
    grep: (text) => lines0(git(root, ["grep", "-F", "-l", "-z", "--untracked", "-e", text, "--", ".", ":(exclude).stemap"]).stdout),
    prefetch: () => undefined,
  };
}

export function gitTree(root: string, ref: string): Tree {
  const sha = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).stdout.toString().trim();
  if (!sha) throw new Error(`git cannot find ${ref}`);
  const cache = new Map<string, string | null>();
  let listed: string[] | null = null;
  const list = () => (listed ??= lines0(git(root, ["ls-tree", "-r", "--name-only", "-z", sha]).stdout));

  /** `cat-file --batch` answers each request with `<id> blob <size>\n<bytes>\n` or `<ask> missing\n`. */
  const prefetch = (paths: string[]) => {
    const want = [...new Set(paths)].filter((p) => !cache.has(p) && readable(p) && !/[\n\r]/.test(p));
    if (!want.length) return;
    const out = git(root, ["cat-file", "--batch"], want.map((p) => `${sha}:${p}\n`).join("")).stdout;
    let at = 0;
    for (const p of want) {
      const eol = out.indexOf(10, at);
      if (eol < 0) { cache.set(p, null); continue; }
      const m = /^\S+ (\w+) (\d+)$/.exec(out.subarray(at, eol).toString("utf8"));
      if (!m) { cache.set(p, null); at = eol + 1; continue; }
      const size = Number(m[2]);
      cache.set(p, m[1] === "blob" ? out.subarray(eol + 1, eol + 1 + size).toString("utf8") : null);
      at = eol + 1 + size + 1;
    }
  };

  return {
    label: sha.slice(0, 9),
    read(path) {
      if (!readable(path)) return null;
      if (!cache.has(path)) prefetch([path]);
      return cache.get(path) ?? null;
    },
    list,
    grep: (text) => lines0(git(root, ["grep", "-F", "-l", "-z", "-e", text, sha, "--", ".", ":(exclude).stemap"]).stdout).map((p) => p.slice(sha.length + 1)),
    prefetch,
  };
}
