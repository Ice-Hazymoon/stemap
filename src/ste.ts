import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimRef, Term, TextType } from "./schema";

/** The checker and its word lists stay outside this package; only a local install turns this gate on. */
const STE = join(homedir(), ".config/stemap/ste");
export const steInstalled = () => existsSync(join(STE, "bin/ste100")) && existsSync(join(STE, "ste-lint.py"));

export interface Fault { key: string; rule: string; severity: "hard" | "soft"; message: string }

const run = promisify(execFile);

/** Both checkers exit nonzero when they find faults, so the output is read from the error too. */
async function capture(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const r = await run(cmd, args, { maxBuffer: 1 << 28 });
    return { stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const r = e as { stdout?: string; stderr?: string };
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? String(e) };
  }
}

const MASK = "CODEREF";

/** The lexical engine rejects identifiers, so code spans become one approved noun. */
export const maskCode = (s: string) => s.replace(/`[^`]*`/g, MASK);

function officialTechnical(): { nouns: Set<string>; verbs: Set<string> } {
  const nouns = new Set<string>([MASK]);
  const verbs = new Set<string>();
  for (const line of readFileSync(join(STE, "data/technical.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const t = JSON.parse(line) as { name: string; type_?: string; category?: string };
    if (!/^[A-Za-z-]+$/.test(t.name)) continue;
    if (t.category?.startsWith("TV")) verbs.add(t.name);
    else if (t.type_ === "TN") nouns.add(t.name);
  }
  // The checker's extract drops words the other extract keeps; add them back.
  for (const line of readFileSync(join(STE, "data/base.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const w = JSON.parse(line) as { name: string; status: string; type_?: string };
    if (w.status !== "approved" || !/^[A-Za-z-]+$/.test(w.name)) continue;
    if (w.type_ === "v") verbs.add(w.name.toLowerCase());
    else nouns.add(w.name.toLowerCase());
  }
  return { nouns, verbs };
}

function writeGlossary(dir: string, terms: Term[]): string {
  const { nouns, verbs } = officialTechnical();
  for (const t of terms) (t.type === "verb" ? verbs : nouns).add(t.term);
  const entry = (w: string, pos: string) => `  - {word: ${JSON.stringify(w)}, part_of_speech: ${pos}}\n`;
  const path = join(dir, "glossary.yaml");
  writeFileSync(path, `name: stemap\ntechnical_nouns:\n${[...nouns].map((w) => entry(w, "noun")).join("")}technical_verbs:\n${[...verbs].map((w) => entry(w, "verb")).join("")}`);
  return path;
}

/** One claim per line, so a linter's line number or character offset maps back to its claim. */
function layout(claims: ClaimRef[]) {
  const spans: { start: number; end: number; key: string }[] = [];
  let text = "";
  for (const c of claims) {
    const start = text.length;
    text += maskCode(c.claim.text);
    spans.push({ start, end: text.length, key: c.key });
    text += "\n\n";
  }
  return { text, spans };
}

async function lexical(dir: string, glossary: string, claims: ClaimRef[], type: Exclude<TextType, "note">): Promise<Fault[]> {
  if (!claims.length) return [];
  const { text, spans } = layout(claims);
  const file = join(dir, `${type}.txt`);
  writeFileSync(file, text);
  const out = await capture(join(STE, "bin/ste100"), ["check", file, "--glossary", glossary, "--text-type", type]);
  const stdout = out.stdout;
  if (!stdout.trim()) throw new Error(`ste100 returned no report: ${out.stderr.slice(0, 300)}`);
  const report = JSON.parse(stdout) as { findings: { rule_id: string; severity: string; message: string; start?: number }[] };
  return report.findings.map((f) => ({
    key: spans.find((s) => f.start !== undefined && f.start >= s.start && f.start <= s.end)?.key ?? "?",
    rule: f.rule_id,
    severity: f.severity === "error" ? "hard" : "soft",
    message: f.message,
  }));
}

async function structural(dir: string, claims: ClaimRef[]): Promise<Fault[]> {
  const file = join(dir, "structure.md");
  writeFileSync(file, claims.map((c) => c.claim.text).join("\n\n") + "\n");
  const out = await capture("python3", ["-I", join(STE, "ste-lint.py"), "--json", "--disable", "long-sentence", file]);
  const report = JSON.parse(out.stdout) as { violations: { line: number; rule: string; level: string; message: string }[] };
  return report.violations.map((v) => ({
    key: claims[Math.floor((v.line - 1) / 2)]?.key ?? "?",
    rule: v.rule,
    severity: v.level === "advisory-free" ? "hard" : "soft",
    message: v.message,
  }));
}

export async function checkSte(claims: ClaimRef[], terms: Term[]): Promise<Fault[]> {
  const dir = mkdtempSync(join(tmpdir(), "stemap-"));
  try {
    const glossary = writeGlossary(dir, terms);
    const [s, d, p] = await Promise.all([
      structural(dir, claims),
      lexical(dir, glossary, claims.filter((c) => c.textType === "description"), "description"),
      lexical(dir, glossary, claims.filter((c) => c.textType === "procedure"), "procedure"),
    ]);
    return [...s, ...d, ...p].filter((f) => f.rule !== "STE-UNITS-FORMAT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
