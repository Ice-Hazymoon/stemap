import { describe, expect, it } from "vitest";
import { findQuote, locator, topSymbols } from "../src/symbols";

const at = (path: string, code: string, quote: string) => locator(path, code).at(code.indexOf(quote));

describe("hash", () => {
  const base = `export function f(a: number) {\n  const b = "x";\n  return a + 1;\n}\n`;
  const hash = (c: string) => at("a.ts", c, "return").hash;

  it("ignores formatting, comments and quote style", () => {
    const same = `// note\nexport   function f( a:number ){\n\n  /* why */ const b = 'x'\n  return a+1\n}\n`;
    expect(hash(same)).toBe(hash(base));
  });
  it("ignores unnecessary parentheses", () => {
    expect(hash(base.replace("a + 1", "(a + 1)"))).toBe(hash(base));
  });
  it("moves with any change in behaviour", () => {
    expect(hash(base.replace("a + 1", "a + 2"))).not.toBe(hash(base));
    expect(hash(base.replace("a + 1", "a - 1"))).not.toBe(hash(base));
    expect(hash(base.replace('"x"', '"y"'))).not.toBe(hash(base));
  });
  it("stays put when code around the symbol changes", () => {
    const moved = `import z from "z";\nconst k = 1;\n\n${base}\nexport const other = 2;\n`;
    expect(hash(moved)).toBe(hash(base));
  });
});

describe("nested functions", () => {
  const code = `export default handler(async (event) => {
  assertAdmin(event);
  const run = async () => {
    await remove();
  };
  const other = () => {
    return 1;
  };
  return run();
});
`;
  const hash = (c: string) => at("a.ts", c, "await remove").hash;

  it("moves when a guard in the enclosing function goes", () => {
    expect(at("a.ts", code, "await remove").symbol).toBe("default.run");
    expect(hash(code.replace("  assertAdmin(event);\n", ""))).not.toBe(hash(code));
  });
  it("stays put when a sibling function changes", () => {
    expect(hash(code.replace("return 1;", "return 2;"))).toBe(hash(code));
  });
  it("moves when the function itself changes", () => {
    expect(hash(code.replace("await remove()", "await remove(1)"))).not.toBe(hash(code));
  });
});

describe("symbol", () => {
  it("names the innermost function and keeps the path", () => {
    const code = `export function useCart() {\n  const total = 1;\n  const buy = async () => {\n    await pay(total);\n  };\n  return { buy };\n}\n`;
    expect(at("a.ts", code, "await pay").symbol).toBe("useCart.buy");
    expect(at("a.ts", code, "const total").symbol).toBe("useCart");
  });
  it("names class methods and object methods", () => {
    expect(at("a.ts", `class Shop {\n  sell() {\n    return 1;\n  }\n}\n`, "return 1").symbol).toBe("Shop.sell");
    expect(at("a.ts", `export const api = {\n  sell() {\n    return 1;\n  },\n};\n`, "return 1").symbol).toBe("api.sell");
  });
  it("names constants, types and default exports", () => {
    expect(at("a.ts", `export const LIMIT = 10;\n`, "LIMIT").symbol).toBe("LIMIT");
    expect(at("a.ts", `export type Plan = "a" | "b";\n`, "Plan").symbol).toBe("Plan");
    expect(at("a.ts", `export default defineHandler(async () => {\n  return 1;\n});\n`, "return 1").symbol).toBe("default");
  });
  it("names a route call by its path", () => {
    expect(at("a.ts", `app.get("/users", (c) => {\n  return c.json([]);\n});\n`, "c.json").symbol).toBe("get(/users)");
  });
  it("gives a quote in a comment to the code below it", () => {
    const code = `// the fee is 5%\nexport const fee = 5;\n`;
    expect(at("a.ts", code, "the fee").symbol).toBe("fee");
  });
  it("reads the export keyword as the name it exports", () => {
    expect(at("a.ts", `export const fee = 5;\n`, "export const").symbol).toBe("fee");
    expect(at("a.ts", `export function pay() {}\n`, "export function").symbol).toBe("pay");
  });
  it("keeps two bare statements in one file apart", () => {
    const code = `import a from "a";\nimport b from "b";\n`;
    expect(at("a.ts", code, `"a"`).symbol).not.toBe(at("a.ts", code, `"b"`).symbol);
  });
  it("reads a re-export as a bare statement, not the whole file", () => {
    expect(at("a.ts", `export const x = 1;\nexport { y } from "./y";\n`, "./y").symbol).toMatch(/^<top:/);
  });
});

describe("vue", () => {
  const sfc = `<script setup lang="ts">\nconst buy = async () => {\n  await pay();\n};\n</script>\n\n<template>\n  <!-- note -->\n  <button @click="buy">Buy</button>\n</template>\n`;
  it("reads script symbols with real line numbers", () => {
    const l = at("a.vue", sfc, "await pay");
    expect(l.symbol).toBe("buy");
    expect(l.line).toBe(2);
  });
  it("hashes the template as markup", () => {
    const t = (c: string) => at("a.vue", c, "<button");
    expect(t(sfc).symbol).toBe("<template>");
    expect(t(sfc.replace("<!-- note -->", "<!-- other -->")).hash).toBe(t(sfc).hash);
    expect(t(sfc.replace("Buy<", "Pay<")).hash).not.toBe(t(sfc).hash);
  });
});

describe("odd syntax", () => {
  it("hashes BigInt literals", () => {
    const code = `export const big = () => 10n;\n`;
    expect(at("a.ts", code, "10n").hash).not.toBe(at("a.ts", code.replace("10n", "11n"), "11n").hash);
    expect(topSymbols("a.ts", code).has("big")).toBe(true);
  });
  it("reads a script tag whose attribute holds a closing bracket", () => {
    const sfc = `<script setup lang="ts" generic="T extends Foo<Bar>">\nconst buy = () => pay();\n</script>\n<template><div /></template>\n`;
    expect(at("a.vue", sfc, "pay()").symbol).toBe("buy");
  });
  it("finds nothing for an empty quote instead of looping", () => {
    expect(findQuote("abc", "")).toBeNull();
  });
});

describe("fallback", () => {
  it("hashes a whole file it cannot read", () => {
    expect(at("a.py", "def f():\n  return 1\n", "return").symbol).toBe("<file>");
    expect(at("a.ts", "function (((", "(((").symbol).toBe("<file>");
  });
});

describe("topSymbols", () => {
  it("lists top-level names only", () => {
    const m = topSymbols("a.ts", `export function a() { function inner() {} }\nconst b = 1;\nexport default 2;\n`);
    expect([...m.keys()].sort()).toEqual(["a", "b", "default"]);
  });
});

describe("findQuote", () => {
  it("survives reflowed whitespace and quote style", () => {
    const hit = findQuote(`call(\n  'a',\n  b,\n);`, `call( "a", b,`);
    expect(hit?.exact).toBe(false);
    expect(hit?.offset).toBe(0);
  });
  it("uses near to pick between two matches", () => {
    const code = `first();\ntarget();\n\nsecond();\ntarget();\n`;
    expect(findQuote(code, "target()", "second")?.offset).toBe(code.lastIndexOf("target()"));
  });
  it("reports a missing quote", () => {
    expect(findQuote("abc", "xyz")).toBeNull();
  });
});
