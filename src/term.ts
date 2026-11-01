import type { StatusReport } from "./maint";

/** The terminal speaks the page's palette: ink ground, four pastels, one dim. Each is the same OKLCH colour in sRGB. */
export const HEX = { sage: "#addcd5", pink: "#f8b3d3", butter: "#fadb86", lilac: "#cbafed", dim: "#97979e", ink: "#161619", row: "#323239" } as const;
type Name = keyof typeof HEX;

const rgb = (name: Name) => [1, 3, 5].map((i) => parseInt(HEX[name].slice(i, i + 2), 16)).join(";");
// Terminals without truecolor get the nearest 256-colour cell, because a raw 24-bit code reads as noise there.
const CELL: Record<Name, number> = { sage: 152, pink: 218, butter: 222, lilac: 183, dim: 246, ink: 233, row: 236 };

const colorOn = () => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";
};
const deep = () => /truecolor|24bit/i.test(process.env.COLORTERM ?? "") || /^(iTerm|WezTerm|ghostty|vscode)/i.test(process.env.TERM_PROGRAM ?? "");
const fg = (name: Name) => (deep() ? `38;2;${rgb(name)}` : `38;5;${CELL[name]}`);
const bg = (name: Name) => (deep() ? `48;2;${rgb(name)}` : `48;5;${CELL[name]}`);
const paint = (name: Name) => (s: string) => (colorOn() ? `\x1b[${fg(name)}m${s}\x1b[39m` : s);

export const sage = paint("sage"), pink = paint("pink"), butter = paint("butter"), lilac = paint("lilac"), dim = paint("dim");
export const bold = (s: string) => (colorOn() ? `\x1b[1m${s}\x1b[22m` : s);
export const badge = (s: string) => (colorOn() ? `\x1b[${bg("sage")};${fg("ink")};1m ${s} \x1b[0m` : s);

export const elapsed = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const TONE = { changed: butter, lost: pink, unlocked: lilac, edited: lilac };

/** The screen version of `status`: grouped by file, because one edit usually moves many claims at once. Pipes keep the line format. */
export function renderStatusScreen(r: StatusReport, all = false): string {
  const blocking = r.drift.length + r.errors.length;
  if (!blocking) return sage(`All ${r.checked} claims match the code.`);
  const tally = Object.entries(Object.groupBy(r.drift, (d) => d.state)).map(([state, list]) => TONE[state as keyof typeof TONE](`${list!.length} ${state}`));
  const out = [bold(`${blocking} of ${r.checked} claims need attention`), [...tally, ...(r.errors.length ? [pink(`${r.errors.length} broken`)] : [])].join("  "), ""];
  for (const e of r.errors) out.push(sage(`${r.docs}/${e.file}`), `  ${pink("broken")}  ${e.message}`, "");
  const groups = Map.groupBy(r.drift, (d) => d.anchors[0]?.path ?? d.claim.file);
  const files = [...groups].sort((a, b) => b[1].length - a[1].length);
  let room = all ? Infinity : 12, hidden = 0, hiddenFiles = 0;
  for (const [file, list] of files) {
    if (room <= 0) { hidden += list.length; hiddenFiles++; continue; }
    out.push(sage(file));
    list.slice(0, room).forEach((d, i) => {
      out.push(`  ${TONE[d.state](d.state.padEnd(8))} ${d.claim.id}`);
      if (i === 0) out.push(`  ${" ".repeat(8)} ${dim(clip(d.claim.claim.text, 72))}`);
    });
    if (list.length > room) { hidden += list.length - room; }
    room -= list.length;
    out.push("");
  }
  if (hidden) out.push(dim(`… ${hidden} more${hiddenFiles ? ` in ${hiddenFiles} files` : ""}  (stemap status --all)`));
  out.push(dim("stemap fix has your local agent resolve them; --json lists the exact next step for each."));
  return out.join("\n");
}
