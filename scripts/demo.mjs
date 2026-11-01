import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// stemap reads a whole repository and this folder sits inside ours, so the shop gets a repository of its own.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(tmpdir(), "stemap-demo", "tinyshop");
const git = (...args) => execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.com", ...args], { cwd: dir, stdio: "ignore" });

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
cpSync(join(root, "examples/tinyshop"), dir, { recursive: true });
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "tinyshop");
execFileSync(process.execPath, [join(root, "dist/cli.mjs"), ...process.argv.slice(2)], { cwd: dir, stdio: "inherit" });
