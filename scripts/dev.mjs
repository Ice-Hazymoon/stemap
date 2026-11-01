// Compiles the page once for its data, then runs vite with reload. Pass a repo with STEMAP_REPO.
import { execFileSync, spawn } from "node:child_process";

execFileSync("npx", ["tsdown"], { stdio: "inherit" });
const out = execFileSync("node", ["dist/cli.mjs", "--no-open"], { encoding: "utf8", env: process.env }).trim().split("\n").at(-1);
const site = new URL(".", out).pathname;
spawn("npx", ["vite"], { stdio: "inherit", env: { ...process.env, STEMAP_SITE: site } });
