import { describe, expect, it } from "vitest";
import { formatLock, parseLock } from "../src/lock";

describe("lock", () => {
  it("round-trips, and keeps a symbol with a space whole", () => {
    const lock = new Map([["flow/a/b", [{ id: "flow/a/b", fp: "12345678", anchors: { "src/a.ts#get(/a b)": "aaa", "src/b.ts#f": "bbb" }, reason: "still true" }]]]);
    expect(parseLock(formatLock(lock))).toEqual(lock);
  });
  it("keeps a reason on one line", () => {
    const lock = new Map([["x", [{ id: "x", fp: "1", anchors: {}, reason: "two\nlines\there" }]]]);
    expect(formatLock(lock).trim().split("\n")).toHaveLength(2);
  });
  it("sorts, so two branches touch different lines", () => {
    const entry = (id: string) => [{ id, fp: "1", anchors: {}, reason: "" }];
    const a = formatLock(new Map([["b", entry("b")], ["a", entry("a")]]));
    expect(a.indexOf("\na\t")).toBeLessThan(a.indexOf("\nb\t"));
  });
  it("reads both lines a union merge leaves behind", () => {
    const text = "x\t1\tf#a=1\t\nx\t1\tf#a=2\treason\n";
    expect(parseLock(text).get("x")).toHaveLength(2);
  });
});
