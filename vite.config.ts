import { createReadStream, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

const web = fileURLToPath(new URL("./web", import.meta.url));

/** A browser runs a plain script from file:// but refuses a module, and `defer` keeps the same timing. */
const classicScript = (): Plugin => ({
  name: "classic-script",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler: (html) => html
      .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/, '<script defer src="$1"></script>')
      .replace(/<link rel="stylesheet" crossorigin /, '<link rel="stylesheet" '),
  },
});

/** `bun run dev` reads a compiled site for its data, the same way the real page does. */
const devData = (): Plugin => ({
  name: "dev-data",
  apply: "serve",
  configureServer(server) {
    const site = process.env.STEMAP_SITE;
    if (!site) return;
    server.middlewares.use("/data", (req, res, next) => {
      const file = join(site, "data", normalize(decodeURIComponent((req.url ?? "").split("?")[0]!)));
      if (!file.startsWith(join(site, "data")) || !existsSync(file)) return next();
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      createReadStream(file).pipe(res);
    });
  },
});

export default defineConfig({
  root: web,
  base: "./",
  plugins: [
    tanstackRouter({ target: "react", routesDirectory: `${web}/src/routes`, generatedRouteTree: `${web}/src/routeTree.gen.ts`, autoCodeSplitting: false }),
    react(),
    tailwindcss(),
    classicScript(),
    devData(),
  ],
  resolve: { alias: { "@": `${web}/src`, "#engine": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    chunkSizeWarningLimit: 6000,
    cssCodeSplit: false,
    // Fonts and wasm stay inside the bundle: file:// cannot fetch them from beside the page.
    assetsInlineLimit: 1 << 26,
    rollupOptions: { output: { format: "iife", inlineDynamicImports: true, entryFileNames: "assets/app.js", assetFileNames: "assets/app[extname]" } },
  },
});
