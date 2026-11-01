import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  define: { __VERSION__: JSON.stringify(version) },
  // The web build lives in dist/web, so tsdown must not empty dist.
  clean: false,
  // oxc-parser ships native bindings; every other runtime dependency is bundled.
  deps: { neverBundle: ["oxc-parser"] },
});
