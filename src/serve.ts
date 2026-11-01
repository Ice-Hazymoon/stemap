import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { inside } from "./tree";

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Plain file serving of the compiled page, for a machine whose browser is somewhere else. The page never needs it. */
export function serveSite(dir: string, port: number, host: string): Promise<Server> {
  const guarded = /^(127\.0\.0\.1|localhost|::1)$/.test(host);
  const server = createServer((req, res) => {
    const end = (code: number, text: string) => { res.writeHead(code, { "content-type": "text/plain" }); res.end(text); };
    // A page on another origin can reach loopback through DNS rebinding, and these files hold source code.
    if (guarded && !LOOPBACK.test(req.headers.host ?? "")) return end(403, "forbidden host");
    let rel: string;
    try { rel = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^[/\\]+/, ""); } catch { return end(400, "bad request"); }
    const file = resolve(dir, rel || "index.html");
    if (!file.startsWith(dir + sep) || !existsSync(file) || !inside(dir, file) || !statSync(file).isFile()) return end(404, "not found");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    createReadStream(join(file)).pipe(res);
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => done(server));
  });
}
