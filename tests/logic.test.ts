import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { logicOf, type LogicNode } from "../src/logic";

const root = mkdtempSync(join(tmpdir(), "stemap-logic-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const treeOf = (code: string) => {
  writeFileSync(join(root, "a.ts"), code);
  return logicOf(root, "a.ts", 1, code.split("\n").length).nodes;
};
const onlyReturn = (nodes: LogicNode[]) => {
  const n = nodes[0];
  if (n?.t !== "if") throw new Error("expected an if");
  return n.then[0];
};

describe("logic text", () => {
  it("leaves type assertions out of a return value", () => {
    const as = treeOf(`export function f(a: boolean) {\n  if (a) return { status: "late" } as const;\n  return 1;\n}\n`);
    expect(onlyReturn(as)).toMatchObject({ t: "return", text: `{ status: "late" }` });
    const satisfies = treeOf(`export function f(a: boolean) {\n  if (a) return { n: 1 } satisfies object;\n  return 1;\n}\n`);
    expect(onlyReturn(satisfies)).toMatchObject({ t: "return", text: "{ n: 1 }" });
  });

  it("keeps a query chain whole in a call", () => {
    const nodes = treeOf(`export async function f(a: boolean) {\n  if (a) return 1;\n  await db.select().from(payments).where(eq(payments.orderId, id)).get();\n}\n`);
    expect(nodes.at(-1)).toMatchObject({ t: "call", text: "db.select().from(payments).where(eq(payments.orderId, id)).get" });
  });
});
