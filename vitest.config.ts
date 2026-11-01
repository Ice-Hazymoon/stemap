import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests build real indexes, which must not land in the person's own data folder.
export default defineConfig({ test: { include: ["tests/**/*.test.ts"], testTimeout: 30000, env: { XDG_DATA_HOME: join(tmpdir(), "stemap-test-data") } } });
