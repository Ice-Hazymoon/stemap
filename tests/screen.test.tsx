import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { StatusReport } from "../src/maint";
import { PanelStore, showPanel } from "../src/panel";
import { renderStatusScreen } from "../src/term";

const head = { title: "stemap fill", repo: "demo", agent: "claude · sonnet" };

/** Ink measures the stream it writes to, so a fake terminal needs a size. */
function terminal(columns: number) {
  const out = Object.assign(new PassThrough(), { columns, rows: 30, isTTY: true });
  let last = "";
  out.on("data", (d: Buffer) => { last = d.toString(); });
  return { out, frame: () => last };
}

describe("fill panel", () => {
  it("tracks a job from queue to done and counts modules, not calls", () => {
    const s = new PanelStore(head, () => undefined);
    s.apply({ type: "plan", jobs: ["flow a", "flow b"], modules: 12 });
    expect(s.rows.map((r) => r.state)).toEqual(["pending", "pending"]);
    s.apply({ type: "start", tag: "flow a" });
    s.apply({ type: "tool", tag: "flow a", tool: "write_document", detail: "" });
    s.apply({ type: "tool", tag: "flow a", tool: "write_document", detail: "", result: "FAIL: 3 claims, 1 faults" });
    expect(s.rows[0]).toMatchObject({ state: "running", tool: "write_document" });
    expect(s.rows[0]!.log).toEqual([{ tool: "write_document", detail: "", result: "FAIL: 3 claims, 1 faults" }]);
    s.apply({ type: "done", tag: "flow a", ms: 1000, modules: 0, claims: 9 });
    s.apply({ type: "start", tag: "modules 1: x" });
    s.apply({ type: "done", tag: "modules 1: x", ms: 1000, modules: 6, claims: 20 });
    expect(s.modulesDone).toBe(6);
    expect(s.claims).toBe(20);
  });

  it("drops the log column on a narrow terminal and keeps every job", async () => {
    for (const [columns, log] of [[110, true], [70, false]] as const) {
      const s = new PanelStore(head, () => undefined);
      const t = terminal(columns);
      const close = showPanel(s, { stdout: t.out as never, stdin: Object.assign(new PassThrough(), { isTTY: false }) as never, debug: true });
      s.apply({ type: "plan", jobs: ["flow checkout"], modules: 4 });
      s.apply({ type: "start", tag: "flow checkout" });
      s.apply({ type: "tool", tag: "flow checkout", tool: "search_code", detail: '"orders"' });
      await new Promise((r) => setTimeout(r, 60));
      const frame = t.frame();
      close();
      expect(frame).toContain("checkout");
      expect(frame.includes('"orders"')).toBe(log);
    }
  });

  it("a stop key reaches the run", () => {
    let stopped = 0;
    const s = new PanelStore(head, () => { stopped++; });
    s.stop();
    expect(stopped).toBe(1);
  });
});

const drift = (id: string, path: string, state: "changed" | "lost" = "changed") => ({
  state, changed: [], anchors: [{ path, candidates: [] }], claim: { id, file: "flows/a.yaml", claim: { text: `Claim ${id}`, evidence: [] } },
});
const report = (items: ReturnType<typeof drift>[]) => ({ drift: items, errors: [], hints: [], checked: 40, docs: ".stemap" }) as unknown as StatusReport;

describe("status on a screen", () => {
  it("groups by file, biggest first, and counts each state", () => {
    const text = renderStatusScreen(report([drift("a", "x.ts"), drift("b", "y.ts"), drift("c", "y.ts", "lost")]));
    expect(text).toContain("3 of 40 claims need attention");
    expect(text).toContain("2 changed");
    expect(text).toContain("1 lost");
    expect(text.indexOf("y.ts")).toBeLessThan(text.indexOf("x.ts"));
  });

  it("caps the list and says how to see the rest", () => {
    const many = Array.from({ length: 20 }, (_, i) => drift(`c${i}`, `f${i % 10}.ts`));
    expect(renderStatusScreen(report(many))).toContain("(stemap status --all)");
    expect(renderStatusScreen(report(many), true)).not.toContain("--all)");
  });

  it("says so when nothing moved", () => {
    expect(renderStatusScreen(report([]))).toContain("All 40 claims match");
  });
});
