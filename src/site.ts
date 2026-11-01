import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Atlas } from "./bundle";
import type { CodeIndex, Fn } from "./codeindex";
import type { Built } from "./flow";
import { Graph } from "./graph";
import { logicReader, type LogicTree } from "./logic";
import { inside, readable } from "./tree";

/**
 * Compiles a commit into a page that opens from disk, with no server and no port. A browser refuses
 * `fetch` and module scripts on file://, but it still runs a plain <script src>, so every piece of
 * data is a script that hands its JSON to the page, loaded only when the reader asks for it.
 */
export const siteDir = (home: string) => join(home, "site");

/** One file over this stays out of the page; the reader gets a note instead of a frozen tab. */
const MAX_SOURCE = 2 << 20;

/** The same code runs from src/ and from the bundled dist/cli.mjs, so the web build sits at either ./web or ../dist/web. */
function webRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const found = [join(here, "web"), join(here, "../dist/web")].find((d) => existsSync(join(d, "index.html")));
  if (!found) throw new Error("the web build is missing; run the build script");
  return found;
}

/** Two stringify passes: parsing one big string is faster than a script of the same object, and `</` cannot end a tag. */
const chunk = (key: string, value: unknown) => `__stemap(${JSON.stringify(key)},${JSON.stringify(JSON.stringify(value)).replaceAll("</", "<\\/")});\n`;

export interface FileChunk { source: string | null; logic: Record<number, LogicTree> }

function fileChunk(root: string, path: string, fns: Fn[]): FileChunk | null {
  const full = join(root, path);
  if (!existsSync(full) || !inside(root, full) || !statSync(full).isFile()) return null;
  const size = statSync(full).size;
  const logic: FileChunk["logic"] = {};
  const own = fns.filter((f) => f.kind !== "module");
  if (own.length) {
    try {
      const read = logicReader(root, path);
      for (const f of own) logic[f.id] = read(f.line, f.end);
    } catch { /* a file the parser rejects still shows as text */ }
  }
  return { source: size > MAX_SOURCE ? null : readFileSync(full, "utf8"), logic };
}

const cited = (atlas: Atlas) => {
  const out = new Set<string>();
  for (const j of atlas.journeys) for (const s of j.steps) for (const r of s.claim.refs) out.add(r.path);
  for (const n of Object.values(atlas.nodes)) for (const c of [...n.summary, ...n.cautions, ...(n.oneLine ? [n.oneLine] : [])]) for (const r of c.refs) out.add(r.path);
  return out;
};

function chunks(b: Built, paths: string[]) {
  const byFile = new Map<string, Fn[]>();
  for (const f of b.index.fns) (byFile.get(f.file) ?? byFile.set(f.file, []).get(f.file)!).push(f);
  return paths.flatMap((path) => {
    const c = fileChunk(b.root, path, byFile.get(path) ?? []);
    return c ? [{ path, chunk: c }] : [];
  });
}

const titled = (html: string, repo: string) => html.replace("<title>stemap</title>", `<title>${(basename(repo)).replace(/[&<>]/g, "")} · stemap</title>`);

/** A complete swap: a reload during a rebuild sees the old page or the new one, never half of each. */
const shortHash = (...parts: (string | Buffer)[]) => {
  const hash = createHash("sha256");
  for (const p of parts) hash.update(p);
  return hash.digest("hex").slice(0, 10);
};

/** Identifies the page code this copy of the tool ships. A page stamped with another one is out of date whatever its data says. */
export const toolStamp = () => shortHash(readFileSync(join(webRoot(), "assets/app.js")), readFileSync(join(webRoot(), "assets/app.css")));

/**
 * The file names stay fixed so the page opens from disk, so a browser would keep running a cached copy for hours.
 * Stamping the URLs moves it to the new build the moment one exists, and the same goes for the data scripts.
 */
export const stampPage = (html: string, tool: string, data: string) => html
  .replace(/\.\/assets\/app\.(js|css)/g, (m) => `${m}?v=${tool}`)
  .replace("<html ", () => `<html data-build="${data}" `);

export const isStamped = (html: string) => html.includes(`?v=${toolStamp()}`);

export function compileSite(b: Built, repo: string, out: string) {
  const tmp = `${out}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  cpSync(webRoot(), tmp, { recursive: true });
  mkdirSync(join(tmp, "data/files"), { recursive: true });
  const paths = [...new Set([...Object.keys(b.index.files), ...cited(b.atlas)])].filter(readable).sort();
  const files = chunks(b, paths);
  files.forEach((f, i) => writeFileSync(join(tmp, `data/files/${i}.js`), chunk(`files/${i}`, f.chunk)));
  writeFileSync(join(tmp, "data/atlas.js"), chunk("atlas", b.atlas));
  writeFileSync(join(tmp, "data/index.js"), chunk("index", { index: b.index, files: files.map((f) => f.path) }));
  writeFileSync(join(tmp, "index.html"), stampPage(titled(readFileSync(join(tmp, "index.html"), "utf8"), repo), toolStamp(), shortHash(JSON.stringify(b.atlas))));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(dirname(out), { recursive: true });
  renameSync(tmp, out);
  return { files: files.length };
}

const scriptSafe = (s: string) => s.replaceAll("</script", "<\\/script");

/** One file to send to someone. It holds the code the map cites; other source stays out to keep the file small. */
export function compileSingle(b: Built, repo: string, out: string) {
  const web = webRoot();
  const css = readFileSync(join(web, "assets/app.css"), "utf8");
  const app = readFileSync(join(web, "assets/app.js"), "utf8");
  const files = chunks(b, [...cited(b.atlas)].filter(readable).sort());
  const data = [chunk("atlas", b.atlas), chunk("index", { index: b.index, files: files.map((f) => f.path) }), ...files.map((f, i) => chunk(`files/${i}`, f.chunk))];
  const html = titled(readFileSync(join(web, "index.html"), "utf8"), repo)
    .replace(/<link[^>]*app\.css[^>]*>/, () => `<style>${css.replaceAll("</style", "<\\/style")}</style>`)
    .replace(/<script[^>]*app\.js[^>]*><\/script>/, "")
    .replace("</body>", () => `<script>window.__stemapData={};window.__stemap=function(k,v){window.__stemapData[k]=v};</script>${data.map((d) => `<script>${d}</script>`).join("\n")}<script>${scriptSafe(app)}</script></body>`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  return { files: files.length, bytes: Buffer.byteLength(html) };
}

export function loadGraph(home: string): Graph {
  const ix = JSON.parse(readFileSync(join(home, "index.json"), "utf8")) as CodeIndex;
  const atlas = JSON.parse(readFileSync(join(home, "atlas.json"), "utf8")) as Atlas;
  return new Graph(ix, atlas.journeys, atlas.nodes);
}
