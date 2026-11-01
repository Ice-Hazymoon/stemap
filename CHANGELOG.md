# Changelog

## 0.1.0

First release.

- `npx stemap` compiles a repository into a static page: flows, modules, tables and code links. It opens from disk and takes no port.
- `--out` writes the page elsewhere, and `--single` writes one self-contained HTML file.
- `stemap init` adds a `.stemap/` map and wires Claude Code, Codex and Cursor.
- `stemap status`, `confirm`, `write` and `check` keep each claim tied to the code it rests on.
- `stemap mcp` serves map queries to agents.
- `stemap fill`, `fix` and `review` run your local Claude Code, Codex or opencode on your own login, locked down to a tool server. `stemap agents` shows what is available.
- The index reads Nuxt, Next.js, Hono, Express, Fastify, Drizzle, Prisma and BullMQ.
- The page has its own design system: tests stand out by shape, colour, icon and label, each branch carries its condition on the wire, and wires are smooth curves. Colour means one thing each, and tracing a table shows it through the flow.
- Decision logic marks each construct, and folds `if (bad) throw` into a one-line guard.
- The page answers to the keyboard: arrows walk a flow, 1 to 9 take a branch, Esc closes what opened last, and `?` lists all of it.
- Moved code is a way through, not a number: a file on the overview opens onto the steps resting on it, and the amber count in a flow steps through each one.
- Tracing a table can be kept with a click, which also frames its whole stretch.
- One word for one idea on the page: a test is a test, a written sentence has evidence, and each flow card says what the flow is for.
- The Flows tab lists every flow with subflows nested under the flow that enters them, instead of opening the first one.
- Upgrading stemap recompiles the page, and a browser can no longer keep running an old copy of it.
- `bun run demo` opens the map of an invented shop, with a claim that the code has outgrown.
- `stemap --help` groups commands by what you are doing, and a mistyped command stops with a suggestion instead of compiling.
- `stemap fill` shows a live panel on a terminal, and `stemap status` groups claims by file. `stemap status --all` lists every claim.
