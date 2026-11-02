import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { Atlas, ViewJourney, ViewStep } from "@/lib/api";

export const CARD_W = 224;
const CHIP_ROW = 28, ACTION_H = 56, TEST_TAG = 20, SUB_H = 52, END_H = 42;
export const SUB_W = CARD_W + 24;
const GROUP_PAD = 20, GROUP_HEAD = SUB_H + 28, GROUP_MIN_W = SUB_W + GROUP_PAD * 2;
/** The flow's own title and goal sit above the first step and scroll with it. */
export const INTRO_H = 140;
const elk = new ELK();

export const tableOf = (target: string) => target.split(".")[0]!;
export const stepTables = (s: ViewStep) => [...new Set(s.writes.map((w) => tableOf(w.target)))];

/**
 * Only tables that at least two steps write earn a hue, so a colour always means "this runs through the flow".
 * Four is what the eye can follow; the rest stay neutral and are still named on their chip.
 */
export function tableHues(j: ViewJourney) {
  const count = new Map<string, number>();
  for (const s of j.steps) for (const t of stepTables(s)) count.set(t, (count.get(t) ?? 0) + 1);
  const top = [...count].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return new Map(top.map(([t], i) => [t, i + 1]));
}

/** The stretch of flow between a table's first and last write: where that row is live. Tracing shows it on demand. */
export function traceWires(j: ViewJourney, table: string) {
  const out = new Map<string, string[]>(), into = new Map<string, string[]>();
  for (const s of j.steps) for (const n of s.next) {
    if (n.failure) continue;
    out.set(s.id, [...(out.get(s.id) ?? []), n.to]);
    into.set(n.to, [...(into.get(n.to) ?? []), s.id]);
  }
  const reach = (start: string[], links: Map<string, string[]>) => {
    const seen = new Set(start);
    for (const id of seen) for (const n of links.get(id) ?? []) seen.add(n);
    return seen;
  };
  const writers = j.steps.filter((s) => stepTables(s).includes(table)).map((s) => s.id);
  const after = reach(writers, out), before = reach(writers, into);
  return new Set([...out].flatMap(([from, tos]) => (after.has(from) ? tos.filter((to) => before.has(to)).map((to) => `${from}>${to}`) : [])));
}

/** Mono digits are 0.6em wide, so a chip's width is known before layout and the row can be fitted without measuring. */
const chipWidth = (table: string) => Math.min(table.length * 6.9 + 16, CARD_W - 24);
export function fitChips(tables: string[]) {
  let room = CARD_W - 24 - 28, n = 0;
  for (const t of tables) { room -= chipWidth(t) + 4; if (room < 0 && n > 0) break; n++; }
  return { shown: tables.slice(0, n), more: tables.length - n };
}

/** Pills hug their text. Layout runs per language because Chinese and STE titles differ in width. */
const pillWidth = (title: string) => {
  const w = [...title].reduce((sum, c) => sum + (c.charCodeAt(0) > 0x2e7f ? 13.5 : 7), 0) + 44;
  return Math.min(CARD_W, Math.max(104, Math.ceil(w)));
};

function size(s: ViewStep, title: string) {
  if (s.kind === "start") return { width: pillWidth(title) + 18, height: END_H };
  if (s.kind === "end" || s.kind === "failure") return { width: pillWidth(title), height: END_H };
  if (s.kind === "subflow") return { width: SUB_W, height: SUB_H };
  return { width: CARD_W, height: ACTION_H + (s.kind === "decision" ? TEST_TAG : 0) + (s.writes.length ? CHIP_ROW : 0) };
}

export interface Placed { x: number; y: number; width: number; height: number; stub?: number }
export type Point = [number, number];
/** A condition, placed by the layout so that it can never land on a node or on another condition. */
export interface WhenBox { text: string; x: number; y: number; width: number; height: number }

const WHEN_W = 156, WHEN_LINE = 16, WHEN_PAD_X = 12, WHEN_PAD_Y = 4;
/** Conditions run to a sentence, so a label stops at two lines; the whole text is on its tooltip and in the panel. */
function whenSize(text: string) {
  const w = [...text].reduce((sum, c) => sum + (c.charCodeAt(0) > 0x2e7f ? 12 : 6.3), 0);
  const inner = WHEN_W - WHEN_PAD_X;
  return { width: Math.ceil(Math.min(w, inner)) + WHEN_PAD_X, height: Math.min(2, Math.ceil(w / inner)) * WHEN_LINE + WHEN_PAD_Y };
}

/** Where a step shown on this page really lives. Its key is `s.id`, or `outer/inner` once a subflow is opened in place. */
export interface Origin { journey: ViewJourney; step: ViewStep; prefix: string; callers: string[]; path: string[] }
export interface Inlined { steps: ViewStep[]; within: Map<string, string>; origin: Map<string, Origin> }

/** The steps above each key, outermost first: a link to an inner step has to open every box around it. */
export const groupsAround = (key: string) => key.split("/").slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join("/"));

/**
 * One flat list of what the page shows, with the steps of each opened subflow right after it and their ids prefixed, so the
 * same flow opened from two places stays two sets of nodes. A flow that is already open further out never opens inside itself.
 */
export function inlineFlows(root: ViewJourney, atlas: Pick<Atlas, "journeys">, open: Set<string>, keep: (j: ViewJourney) => ViewJourney = (j) => j): Inlined {
  const steps: ViewStep[] = [], within = new Map<string, string>(), origin = new Map<string, Origin>();
  const add = (j: ViewJourney, prefix: string, callers: string[], path: string[]) => {
    for (const s of keep(j).steps) {
      const key = prefix + s.id;
      steps.push({ ...s, id: key, next: s.next.map((n) => ({ ...n, to: prefix + n.to })) });
      origin.set(key, { journey: j, step: j.steps.find((x) => x.id === s.id) ?? s, prefix, callers, path });
      if (prefix) within.set(key, prefix.slice(0, -1));
      const inner = s.subflow && open.has(key) && !path.includes(s.subflow) ? atlas.journeys.find((x) => x.id === s.subflow) : undefined;
      if (inner?.steps.length) add(inner, `${key}/`, [...callers, `${j.id}/${s.id}`], [...path, inner.id]);
    }
  };
  add(root, "", [], [root.id]);
  return { steps, within, origin };
}

const OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  // The router only fixes where a wire crosses each layer; `wirePath` draws the curve between those points.
  "elk.edgeRouting": "POLYLINE",
  "elk.edgeLabels.placement": "CENTER",
  "elk.layered.edgeLabels.sideSelection": "ALWAYS_DOWN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "52",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "11",
  "elk.spacing.nodeNode": "26",
  "elk.spacing.edgeNode": "18",
  "elk.spacing.edgeEdge": "11",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.crossingMinimization.forceNodeModelOrder": "false",
};

/**
 * Layers give "when", the branch gives "where". Node order follows `next`, so the main path stays leftmost.
 * An opened subflow is a node with its own graph inside, so the wires into and out of it do not change at all.
 */
export async function layoutFlow(j: ViewJourney, title: (s: ViewStep) => string, when: (n: ViewStep["next"][number]) => string | undefined = () => undefined, folded: (s: ViewStep) => number = () => 0, within: ReadonlyMap<string, string> = new Map()) {
  const ids = new Set(j.steps.map((s) => s.id));
  const inside = new Map<string | undefined, ViewStep[]>();
  for (const s of j.steps) inside.set(within.get(s.id), [...(inside.get(within.get(s.id)) ?? []), s]);
  const wires = (list: ViewStep[]) => list.flatMap((s) => s.next.filter((n) => ids.has(n.to)).map((n) => {
    const i = s.next.indexOf(n), text = when(n);
    return { id: `${s.id}>${n.to}`, sources: [`${s.id}>${n.to}#${i}`], targets: [`${n.to}^`], labels: text ? [{ id: `${s.id}>${n.to}~`, text, ...whenSize(text) }] : [] };
  }));
  const node = (s: ViewStep): ElkNode => {
    // A folded failure keeps a port of its own, so its stub is spaced among the wires and never lands on one.
    const south = [...s.next.map((n, i) => ({ id: `${s.id}>${n.to}#${i}`, layoutOptions: { "elk.port.side": "SOUTH" } })), ...(folded(s) ? [{ id: `${s.id}!`, layoutOptions: { "elk.port.side": "SOUTH" } }] : [])];
    // Every wire arrives at one port, so many inbound branches read as a merge and not as a comb.
    const ports = [{ id: `${s.id}^`, layoutOptions: { "elk.port.side": "NORTH" } }, ...south];
    const kids = inside.get(s.id);
    if (!kids) return { id: s.id, ...size(s, title(s)), ports, layoutOptions: { "elk.portConstraints": "FIXED_SIDE" } };
    return {
      id: s.id, ports, children: kids.map(node), edges: wires(kids),
      layoutOptions: {
        ...OPTIONS, "elk.portConstraints": "FIXED_SIDE", "elk.padding": `[top=${GROUP_HEAD},left=${GROUP_PAD},bottom=${GROUP_PAD},right=${GROUP_PAD}]`,
        "elk.nodeSize.constraints": "MINIMUM_SIZE", "elk.nodeSize.minimum": `(${GROUP_MIN_W},${GROUP_HEAD * 2})`, "elk.contentAlignment": "[H_CENTER, V_TOP]",
      },
    };
  };
  const top = inside.get(undefined) ?? [];
  const input: ElkNode = { id: "root", layoutOptions: OPTIONS, children: top.map(node), edges: wires(top) };
  const graph = await elk.layout(input);
  const pos = new Map<string, Placed>();
  const routes = new Map<string, Point[]>();
  const labels = new Map<string, WhenBox>();
  // ELK reports what is inside a node relative to that node, and the page needs one coordinate system.
  const place = (box: ElkNode, dx: number, dy: number) => {
    for (const n of box.children ?? []) {
      const x = (n.x ?? 0) + dx, y = (n.y ?? 0) + dy;
      pos.set(n.id, { x, y, width: n.width ?? CARD_W, height: n.height ?? ACTION_H, stub: n.ports?.find((p) => p.id === `${n.id}!`)?.x });
      place(n, x, y);
    }
    for (const e of (box.edges ?? []) as ElkExtendedEdge[]) {
      const sec = e.sections?.[0];
      if (!sec) continue;
      const points = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p): Point => [p.x + dx, p.y + dy]);
      routes.set(e.id, points);
      const l = e.labels?.[0];
      if (!l?.text) continue;
      // ELK sets a label beside its wire, where two neighbours can claim it. Centred on the wire, it has one owner.
      const width = l.width ?? WHEN_W, height = l.height ?? WHEN_LINE, y = (l.y ?? 0) + dy;
      labels.set(e.id, { text: l.text, x: wireX(points, y + height / 2) - width / 2, y, width, height });
    }
  };
  place(graph, 0, INTRO_H);
  return { pos, routes, labels, width: graph.width ?? CARD_W, height: (graph.height ?? 0) + INTRO_H };
}

function wireX(points: Point[], y: number) {
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!, [bx, by] = points[i]!;
    if ((y - ay) * (y - by) <= 0) return ay === by ? ax : ax + ((bx - ax) * (y - ay)) / (by - ay);
  }
  return points[0]![0];
}

/**
 * Every wire leaves and arrives vertically, and a sideways move is one S across the gap: no corners, however far it travels.
 * A wire that turns back at the top of a loop crosses that point sideways, because a vertical tangent there would be a cusp.
 */
export function wirePath(points: Point[]) {
  const [first] = points;
  if (!first) return "";
  const turns = (i: number) => {
    const a = points[i - 1], b = points[i]!, c = points[i + 1];
    return !!a && !!c && (b[1] - a[1]) * (c[1] - b[1]) < 0;
  };
  let d = `M${first[0]},${first[1]}`;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]!, [x, y] = points[i]!, mid = (ay + y) / 2;
    if (Math.abs(x - ax) < 1) { d += ` L${x},${y}`; continue; }
    const c1 = turns(i - 1) ? `${ax + (x - ax) * 0.6},${ay}` : `${ax},${mid}`;
    const c2 = turns(i) ? `${x - (x - ax) * 0.6},${y}` : `${x},${mid}`;
    d += ` C${c1} ${c2} ${x},${y}`;
  }
  return d;
}

/** A wide diamond with soft corners, the flowchart's own sign for a test. Drawn at the node's real size, so its points never stretch. */
export function diamondPath(w: number, h: number, cut = 18, r = 5) {
  const p: Point[] = [[cut, 0.5], [w - cut, 0.5], [w - 0.5, h / 2], [w - cut, h - 0.5], [cut, h - 0.5], [0.5, h / 2]];
  const toward = (a: Point, b: Point, d: number): Point => { const n = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [a[0] + ((b[0] - a[0]) / n) * d, a[1] + ((b[1] - a[1]) / n) * d]; };
  return `${p.map((c, i) => {
    const before = toward(c, p[(i + p.length - 1) % p.length]!, r), after = toward(c, p[(i + 1) % p.length]!, r);
    return `${i ? "L" : "M"}${before[0]},${before[1]} Q${c[0]},${c[1]} ${after[0]},${after[1]}`;
  }).join(" ")} Z`;
}

/** A branch that only failures reach stays folded, so a long journey still reads as one line. */
export function mainPath(j: ViewJourney) {
  const byId = new Map(j.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const walk = (id: string) => {
    const s = byId.get(id);
    if (!s || seen.has(id) || s.kind === "failure") return;
    seen.add(id);
    for (const n of s.next) if (!n.failure) walk(n.to);
  };
  if (j.steps[0]) walk(j.steps[0].id);
  return seen;
}

/** Calls and required order come first, so the list reads in the order a user lives it. */
export function orderedJourneys(a: Atlas) {
  const rank = new Map(a.journeys.map((j) => [j.id, 0]));
  const links = (a.crossings?.links ?? []).filter((l) => l.subflow || l.after);
  for (let i = 0; i < a.journeys.length; i++) for (const l of links) {
    if (!rank.has(l.to) || !rank.has(l.from)) continue;
    rank.set(l.to, Math.max(rank.get(l.to)!, Math.min(rank.get(l.from)! + 1, a.journeys.length - 1)));
  }
  return [...a.journeys].sort((x, y) => rank.get(x.id)! - rank.get(y.id)!);
}

/** Callers first, each subflow under its first caller: the list itself shows how journeys nest. */
export function journeyTree(a: Atlas) {
  const called = new Map<string, string>();
  for (const j of a.journeys) for (const s of j.steps) {
    if (s.subflow && !called.has(s.subflow) && a.journeys.some((x) => x.id === s.subflow)) called.set(s.subflow, j.id);
  }
  const out: { j: ViewJourney; depth: number }[] = [];
  const seen = new Set<string>();
  const add = (j: ViewJourney, depth: number) => {
    if (seen.has(j.id)) return;
    seen.add(j.id);
    out.push({ j, depth });
    for (const c of a.journeys) if (called.get(c.id) === j.id) add(c, depth + 1);
  };
  for (const j of orderedJourneys(a)) if (!called.has(j.id)) add(j, 0);
  for (const j of a.journeys) add(j, 0);
  return out;
}
