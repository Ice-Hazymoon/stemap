import { describe, expect, it } from "vitest";
import { groupsAround, inlineFlows, layoutFlow, mainPath } from "../web/src/features/journey/layout";
import type { ViewJourney, ViewStep } from "../web/src/lib/api";

const step = (id: string, next: string[], over: Partial<ViewStep> = {}) => ({ id, title: id, kind: next.length ? "action" : "end", lane: "service", module: "m", writes: [], next: next.map((to) => ({ to })), ...over }) as unknown as ViewStep;
const flow = (id: string, steps: ViewStep[]) => ({ id, title: id, goal: "", steps }) as unknown as ViewJourney;
const pay = flow("pay", [step("charge", ["done"]), step("done", [])]);
const buy = flow("buy", [step("start", ["pay"]), step("pay", ["end"], { kind: "subflow", subflow: "pay" }), step("end", [])]);
const atlas = { journeys: [buy, pay] };

describe("subflows opened in place", () => {
  it("adds nothing while they are shut", () => {
    const shut = inlineFlows(buy, atlas, new Set());
    expect(shut.steps.map((s) => s.id)).toEqual(["start", "pay", "end"]);
    expect(shut.within.size).toBe(0);
  });

  it("lists an opened flow after its block under prefixed ids, and remembers where each step came from", () => {
    const { steps, within, origin } = inlineFlows(buy, atlas, new Set(["pay"]));
    expect(steps.map((s) => s.id)).toEqual(["start", "pay", "pay/charge", "pay/done", "end"]);
    expect(steps[2]!.next[0]!.to).toBe("pay/done");
    expect(steps[1]!.next[0]!.to).toBe("end");
    expect(within.get("pay/charge")).toBe("pay");
    expect(origin.get("pay/charge")).toMatchObject({ journey: { id: "pay" }, step: { id: "charge" }, prefix: "pay/", callers: ["buy/pay"] });
  });

  it("keeps the same flow apart when it is opened twice", () => {
    const twice = flow("twice", [step("a", ["b"], { kind: "subflow", subflow: "pay" }), step("b", [], { kind: "subflow", subflow: "pay" })]);
    const ids = inlineFlows(twice, { journeys: [twice, pay] }, new Set(["a", "b"])).steps.map((s) => s.id);
    expect(ids).toEqual(["a", "a/charge", "a/done", "b", "b/charge", "b/done"]);
  });

  it("never opens a flow inside itself", () => {
    const loop = flow("loop", [step("again", [], { kind: "subflow", subflow: "loop" })]);
    expect(inlineFlows(loop, { journeys: [loop] }, new Set(["again", "again/again"])).steps.map((s) => s.id)).toEqual(["again"]);
  });

  it("finds every box around a deep step", () => {
    expect(groupsAround("a/b/c")).toEqual(["a", "a/b"]);
    expect(groupsAround("a")).toEqual([]);
    expect(groupsAround("")).toEqual([]);
  });

  it("folds an inner flow by its own main path", () => {
    const risky = flow("risky", [step("try", ["ok", "bad"]), step("ok", []), step("bad", [], { kind: "failure" })]);
    const host = flow("host", [step("go", [], { kind: "subflow", subflow: "risky" })]);
    const keep = (j: ViewJourney) => { const m = mainPath(j); return { ...j, steps: j.steps.filter((s) => m.has(s.id)).map((s) => ({ ...s, next: s.next.filter((n) => m.has(n.to)) })) }; };
    expect(inlineFlows(host, { journeys: [host, risky] }, new Set(["go"]), keep).steps.map((s) => s.id)).toEqual(["go", "go/try", "go/ok"]);
  });

  it("lays out a box that holds its steps and keeps the wires around it", async () => {
    const { steps, within } = inlineFlows(buy, atlas, new Set(["pay"]));
    const { pos, routes } = await layoutFlow({ ...buy, steps }, (s) => s.title, undefined, undefined, within);
    const box = pos.get("pay")!;
    for (const id of ["pay/charge", "pay/done"]) {
      const p = pos.get(id)!;
      expect(p.x).toBeGreaterThanOrEqual(box.x);
      expect(p.y).toBeGreaterThanOrEqual(box.y + 52);
      expect(p.x + p.width).toBeLessThanOrEqual(box.x + box.width);
      expect(p.y + p.height).toBeLessThanOrEqual(box.y + box.height);
    }
    const inner = routes.get("pay/charge>pay/done")!;
    expect(inner[0]![1]).toBeCloseTo(pos.get("pay/charge")!.y + pos.get("pay/charge")!.height, 0);
    expect(inner.at(-1)![1]).toBeCloseTo(pos.get("pay/done")!.y, 0);
    expect(routes.get("start>pay")!.at(-1)![1]).toBeCloseTo(box.y, 0);
    expect(routes.get("pay>end")![0]![1]).toBeCloseTo(box.y + box.height, 0);
    expect(pos.get("end")!.y).toBeGreaterThan(box.y + box.height);
  });
});
