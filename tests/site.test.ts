import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compute } from "../src/flow";
import { write } from "../src/maint";
import { compileSingle, compileSite, isStamped, toolStamp } from "../src/site";
import { commit, draft, put, repo, workspace } from "./helpers";

const graphSource = readFileSync(new URL("../src/graph.ts", import.meta.url), "utf8");
const web = new URL("../dist/web/index.html", import.meta.url).pathname;

describe("the query layer", () => {
  it("imports nothing from Node, because it runs in the page", () => {
    expect(graphSource).not.toMatch(/from "node:|require\(/);
    expect(graphSource.match(/^import (?!type)/gm) ?? []).toEqual([]);
  });
});

// The compiler needs a built page, so this runs after `bun run build`; CI builds before the smoke test does the same check.
describe.runIf(existsSync(web))("the compiled page", () => {
  const data = mkdtempSync(join(tmpdir(), "stemap-site-"));
  const prior = process.env.XDG_DATA_HOME;
  let dir: string;
  let out: string;
  beforeAll(async () => {
    process.env.XDG_DATA_HOME = data;
    dir = repo();
    put(dir, ".env", "SECRET=abc123\n");
    await write(workspace(dir), draft(dir));
    commit(dir, "map");
    const b = await compute(dir);
    out = join(data, "site");
    compileSite(b, dir, out);
    compileSingle(b, dir, join(data, "one.html"));
  });
  afterAll(() => { process.env.XDG_DATA_HOME = prior; rmSync(data, { recursive: true, force: true }); });

  it("runs from disk: a plain script, no module", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).not.toContain('type="module"');
    expect(html).toContain(`<script defer src="./assets/app.js?v=${toolStamp()}">`);
    expect(html).toContain("<title>");
  });
  it("names its build, so a browser cannot keep an old copy and an upgrade recompiles", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain(`app.css?v=${toolStamp()}`);
    expect(html).toMatch(/<html data-build="[0-9a-f]{10}"/);
    expect(isStamped(html)).toBe(true);
    expect(isStamped(html.replaceAll(toolStamp(), "0000000000"))).toBe(false);
  });
  it("hands data over as scripts", () => {
    expect(readFileSync(join(out, "data/atlas.js"), "utf8")).toMatch(/^__stemap\("atlas",/);
    expect(readdirSync(join(out, "data/files")).length).toBeGreaterThan(0);
  });
  it("never ships a secret", () => {
    const all = readdirSync(join(out, "data/files")).map((f) => readFileSync(join(out, "data/files", f), "utf8")).join("");
    expect(all).toContain("chargeCard");
    expect(all).not.toContain("abc123");
  });
  it("precomputes logic trees with the source", () => {
    const text = readFileSync(join(out, "data/files/0.js"), "utf8");
    const json = JSON.parse(JSON.parse(text.slice(text.indexOf(",") + 1, text.lastIndexOf(")")).replaceAll("<\\/", "</"))) as { source: string; logic: Record<string, { branches: number }> };
    expect(Object.values(json.logic).some((t) => t.branches > 0)).toBe(true);
  });
  it("puts everything in one file, with no tag a quote could close", () => {
    const html = readFileSync(join(data, "one.html"), "utf8");
    expect(html).not.toContain('src="./assets');
    expect(html).not.toContain('href="./assets');
    expect(html).toContain('__stemap("atlas"');
  });
});
