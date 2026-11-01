import type { CodeIndex, Fn } from "./codeindex";
import type { ViewJourney, ViewNode, ViewStep } from "./bundle";

/**
 * One query layer over journeys, modules and code. Every UI link and every crossing comes from
 * here, so a new client or a new kind of link needs one new rule, not one more panel. It runs in the
 * page as well as the CLI, so this file imports nothing from Node.
 */
export type EntityKind = "journey" | "step" | "module" | "file" | "fn" | "table" | "route" | "page" | "queue";
export interface LinkItem {
  id: string;
  kind: EntityKind;
  label: string;
  labelZh?: string;
  hint?: string;
  hintZh?: string;
  /** Link strength for sorting: lower is closer. */
  rank?: number;
}
export interface LinkGroup { key: string; title: string; total: number; items: LinkItem[] }
export interface EntityView {
  id: string;
  kind: EntityKind;
  title: string;
  titleZh?: string;
  subtitle?: string;
  source?: { path: string; startLine: number; endLine: number };
  /** Cited lines of a step, each with the function around it. */
  anchors?: { path: string; line: number; endLine: number; fn: string | null; label: string | null }[];
  groups: LinkGroup[];
}
export interface Crossings {
  journeys: { id: string; title: string; titleZh?: string; steps: number }[];
  links: {
    from: string; to: string;
    subflow: boolean; after: boolean;
    data: { table: string; writer: string; reader: string }[];
    fns: number; routes: number; tables: number; weight: number;
  }[];
  tables: { table: string; cells: Record<string, { w: string[]; r: string[] }> }[];
  code: { id: string; label: string; cells: Record<string, string[]> }[];
}
export interface Support {
  edges: Record<string, boolean>;
  writes: Record<string, "direct" | "reach" | "none" | "other">;
  stats: { codeEdges: number; confirmedEdges: number; writes: number; confirmedWrites: number; other: number };
}

const CAP = 40;
const stepId = (j: string, s: string) => `step:${j}/${s}`;
const short = (p: string) => p.split("/").slice(-2).join("/");

export class Graph {
  private byFile = new Map<string, Fn[]>();
  private callers: number[][];
  private opsByFn = new Map<number, CodeIndex["tableOps"]>();
  private opsByTable = new Map<string, CodeIndex["tableOps"]>();
  private anchors = new Map<string, number[]>();
  private refFiles = new Map<string, string[]>();
  private stepsByFn = new Map<number, string[]>();
  private stepsByFile = new Map<string, string[]>();
  private stepsByTable = new Map<string, string[]>();
  private stepsByModule = new Map<string, string[]>();
  private steps = new Map<string, { j: ViewJourney; s: ViewStep }>();
  private entries: { id: string; kind: EntityKind; label: string; labelZh?: string; hay: string }[] = [];

  constructor(private ix: CodeIndex, private journeys: ViewJourney[], private nodes: Record<string, ViewNode>) {
    for (const f of ix.fns) (this.byFile.get(f.file) ?? this.byFile.set(f.file, []).get(f.file)!).push(f);
    this.callers = ix.fns.map(() => []);
    ix.calls.forEach((cs, a) => cs.forEach((b) => this.callers[b]!.push(a)));
    for (const o of ix.tableOps) {
      (this.opsByFn.get(o.fn) ?? this.opsByFn.set(o.fn, []).get(o.fn)!).push(o);
      (this.opsByTable.get(o.table) ?? this.opsByTable.set(o.table, []).get(o.table)!).push(o);
    }
    const tables = new Set(ix.tables.map((t) => t.name));
    const push = <K,>(m: Map<K, string[]>, k: K, v: string) => {
      const list = m.get(k) ?? m.set(k, []).get(k)!;
      if (!list.includes(v)) list.push(v);
    };
    for (const j of journeys) for (const s of j.steps) {
      const id = stepId(j.id, s.id);
      this.steps.set(id, { j, s });
      const fns: number[] = [];
      const files: string[] = [];
      for (const r of s.claim.refs) {
        files.push(r.path);
        push(this.stepsByFile, r.path, id);
        const f = this.fnAt(r.path, r.startLine);
        if (f && !fns.includes(f.id)) { fns.push(f.id); push(this.stepsByFn, f.id, id); }
      }
      this.anchors.set(id, fns);
      this.refFiles.set(id, files);
      push(this.stepsByModule, s.module, id);
      for (const w of s.writes) {
        const t = w.target.split(".")[0]!;
        if (tables.has(t)) push(this.stepsByTable, t, id);
      }
    }
    this.buildSearch();
  }

  /** The narrowest function around a line: a cited line belongs to its nearest scope. */
  fnAt(path: string, line: number): Fn | undefined {
    let best: Fn | undefined;
    for (const f of this.byFile.get(path) ?? []) {
      if (f.kind === "module") continue;
      if (f.line <= line && line <= f.end && (!best || f.end - f.line < best.end - best.line)) best = f;
    }
    return best ?? this.byFile.get(path)?.find((f) => f.kind === "module");
  }

  private bfs(from: number[], depth: number, dir: "down" | "up") {
    const dist = new Map<number, number>(from.map((f) => [f, 0]));
    const prev = new Map<number, number>();
    let edge = from;
    for (let d = 1; d <= depth && edge.length; d++) {
      const next: number[] = [];
      for (const a of edge) for (const b of dir === "down" ? this.ix.calls[a]! : this.callers[a]!) {
        if (dist.has(b)) continue;
        dist.set(b, d);
        prev.set(b, a);
        next.push(b);
      }
      edge = next;
    }
    return { dist, prev };
  }

  private fnId(f: Fn) { return `fn:${f.file}#${f.name}`; }
  private fnLabel(f: Fn) {
    if (f.name === "<module>" || f.name === "default") return short(f.file);
    // A handler without a name of its own is called after its route, and a route is not a call.
    return f.name.includes(" ") ? f.name : `${f.name}()`;
  }
  private fnItem(id: number, rank = 0, hint?: string, hintZh?: string): LinkItem {
    const f = this.ix.fns[id]!;
    return { id: this.fnId(f), kind: "fn", label: this.fnLabel(f), hint: hint ?? short(f.file), hintZh: hintZh ?? hint ?? short(f.file), rank };
  }
  private stepItem(id: string, rank = 0, hint?: string, hintZh?: string): LinkItem {
    const { j, s } = this.steps.get(id)!;
    return { id, kind: "step", label: s.title, labelZh: s.titleZh, hint: hint ? `${j.title} · ${hint}` : j.title, hintZh: hintZh || hint ? `${j.titleZh} · ${hintZh ?? hint}` : j.titleZh, rank };
  }
  private tableItem(t: string, hint?: string, hintZh?: string, rank = 0): LinkItem { return { id: `table:${t}`, kind: "table", label: t, hint, hintZh, rank }; }
  private fileItem(p: string, hint?: string, rank = 0): LinkItem { return { id: `file:${p}`, kind: "file", label: short(p), hint: hint ?? p, rank }; }
  private moduleItem(m: string, hint?: string, hintZh?: string, rank = 0): LinkItem {
    return { id: `module:${m}`, kind: "module", label: this.nodes[m]?.title ?? m, labelZh: this.nodes[m]?.zh, hint, hintZh, rank };
  }

  private group(key: string, title: string, items: LinkItem[]): LinkGroup[] {
    if (!items.length) return [];
    const seen = new Set<string>();
    const unique = items.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
    unique.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    return [{ key, title, total: unique.length, items: unique.slice(0, CAP) }];
  }

  /** Steps that reach these functions through calls, with the chain that proves each one. */
  private impact(from: number[], depth = 5): LinkItem[] {
    const { dist, prev } = this.bfs(from, depth, "up");
    const out: LinkItem[] = [];
    for (const [fn, d] of dist) {
      for (const id of this.stepsByFn.get(fn) ?? []) {
        const chain: string[] = [];
        for (let c: number | undefined = fn; c !== undefined; c = prev.get(c)) chain.push(this.fnLabel(this.ix.fns[c]!));
        const hint = d === 0 ? "cites this code" : chain.join(" → ");
        out.push(this.stepItem(id, d, hint, d === 0 ? "引用这段代码" : undefined));
      }
    }
    return this.perStepBest(out);
  }
  private perStepBest(items: LinkItem[]) {
    const best = new Map<string, LinkItem>();
    for (const x of items) if (!best.has(x.id) || (x.rank ?? 0) < (best.get(x.id)!.rank ?? 0)) best.set(x.id, x);
    return [...best.values()];
  }

  private tablesOf(fns: number[], depth: number) {
    const { dist } = this.bfs(fns, depth, "down");
    const out = new Map<string, { w: boolean; r: boolean; d: number }>();
    for (const [fn, d] of dist) for (const o of this.opsByFn.get(fn) ?? []) {
      const cur = out.get(o.table) ?? { w: false, r: false, d };
      if (o.op === "read") cur.r = true; else cur.w = true;
      cur.d = Math.min(cur.d, d);
      out.set(o.table, cur);
    }
    return out;
  }

  private tableGroups(fns: number[]): LinkGroup[] {
    const list = [...this.tablesOf(fns, 3)].map(([t, v]) => this.tableItem(t,
      `${v.w ? "write" : "read"}${v.d ? ` · ${v.d} ${v.d === 1 ? "call" : "calls"} away` : ""}`, undefined, v.d + (v.w ? 0 : 0.5)));
    return this.group("tables", "Tables reached", list);
  }

  private routesOf(file: string) { return this.ix.routes.map((r, i) => ({ r, i })).filter((x) => x.r.file === file); }
  private routeItem(i: number, hint?: string, hintZh?: string): LinkItem {
    const r = this.ix.routes[i]!;
    return { id: `route:${r.method} ${r.path}`, kind: "route", label: `${r.method} ${r.path}`, hint: hint ?? short(r.file), hintZh };
  }
  private entrances(fns: number[]) {
    const { dist } = this.bfs(fns, 6, "up");
    const out: LinkItem[] = [];
    for (const [fn, d] of dist) {
      const f = this.ix.fns[fn]!;
      if (f.kind === "handler" || f.name === "default") for (const { i } of this.routesOf(f.file)) out.push({ ...this.routeItem(i, d ? `${d} ${d === 1 ? "call" : "calls"} away` : "handler"), rank: d });
    }
    return out;
  }
  private otherJourneys(id: string) {
    const here = this.steps.get(id)!;
    const out: LinkItem[] = [];
    for (const f of this.anchors.get(id) ?? []) for (const other of this.stepsByFn.get(f) ?? []) {
      if (other === id || this.steps.get(other)!.j.id === here.j.id) continue;
      out.push(this.stepItem(other, 0, "same code"));
    }
    for (const w of here.s.writes) {
      const t = w.target.split(".")[0]!;
      for (const other of this.stepsByTable.get(t) ?? []) {
        if (other === id || this.steps.get(other)!.j.id === here.j.id) continue;
        out.push(this.stepItem(other, 2, `also writes ${t}`));
      }
    }
    for (const f of this.refFiles.get(id) ?? []) for (const other of this.stepsByFile.get(f) ?? []) {
      if (other === id || this.steps.get(other)!.j.id === here.j.id) continue;
      out.push(this.stepItem(other, 4, `same file ${short(f)}`));
    }
    return this.perStepBest(out);
  }

  private stepView(id: string): EntityView {
    const { j, s } = this.steps.get(id)!;
    const fns = this.anchors.get(id) ?? [];
    const r = s.claim.refs[0];
    return {
      id, kind: "step", title: s.title, titleZh: s.titleZh, subtitle: j.titleZh,
      source: r ? { path: r.path, startLine: r.startLine, endLine: r.endLine } : undefined,
      anchors: s.claim.refs.map((x) => {
        const f = this.fnAt(x.path, x.startLine);
        const named = f && f.kind !== "module" ? f : undefined;
        return { path: x.path, line: x.startLine, endLine: x.endLine, fn: named ? this.fnId(named) : null, label: named ? this.fnLabel(named) : null };
      }),
      groups: [
        ...this.group("cross", "Also in", this.otherJourneys(id)),
        ...this.group("code", "Functions", fns.map((f) => this.fnItem(f))),
        ...this.group("entry", "Routes in", this.entrances(fns)),
        ...this.tableGroups(fns),
      ],
    };
  }

  private fnView(id: string, f: Fn): EntityView {
    const callers = this.callers[f.id]!.map((c) => this.fnItem(c));
    const callees = this.ix.calls[f.id]!.map((c) => this.fnItem(c));
    const sends = this.ix.sends.filter((s) => s.fn === f.id).map((s): LinkItem => ({ id: `queue:${s.queue}`, kind: "queue", label: s.queue, hint: "sends a job", hintZh: "发送任务" }));
    return {
      id, kind: "fn", title: this.fnLabel(f), subtitle: f.file, source: { path: f.file, startLine: f.line, endLine: f.end },
      groups: [
        ...this.group("impact", "Flows through here", this.impact([f.id])),
        ...this.group("callers", "Called by", callers),
        ...this.group("callees", "Calls", callees),
        ...this.group("entry", "Routes in", this.entrances([f.id])),
        ...this.group("queues", "Queues", sends),
        ...this.tableGroups([f.id]),
      ],
    };
  }

  private fileView(id: string, path: string): EntityView | null {
    const info = this.ix.files[path];
    if (!info) return null;
    const fns = this.byFile.get(path) ?? [];
    const ids = fns.map((f) => f.id);
    const importers = this.ix.imports.filter(([, b]) => b === path).map(([a]) => this.fileItem(a));
    const imports = this.ix.imports.filter(([a]) => a === path).map(([, b]) => this.fileItem(b));
    return {
      id, kind: "file", title: short(path), subtitle: path, source: { path, startLine: 1, endLine: 1 },
      groups: [
        ...this.group("impact", "Flows through here", this.impact(ids)),
        ...(info.module ? this.group("module", "Module", [this.moduleItem(info.module)]) : []),
        ...this.group("fns", "Functions", fns.filter((f) => f.kind !== "module").map((f) => this.fnItem(f.id, f.exported ? 0 : 1, `line ${f.line}`))),
        ...this.group("importers", "Imported by", importers),
        ...this.group("imports", "Imports", imports),
        ...this.tableGroups(ids),
      ],
    };
  }

  private tableView(id: string, name: string): EntityView | null {
    const t = this.ix.tables.find((x) => x.name === name);
    if (!t) return null;
    const ops = this.opsByTable.get(name) ?? [];
    const writers = ops.filter((o) => o.op !== "read");
    const readers = ops.filter((o) => o.op === "read");
    const fk = this.ix.tables.filter((x) => x.refs.includes(name)).map((x) => this.tableItem(x.name, "points to this table"));
    const out = t.refs.map((r) => this.tableItem(r, "this table points to it"));
    const declared = (this.stepsByTable.get(name) ?? []).map((s) => {
      const w = this.steps.get(s)!.s.writes.find((x) => x.target.split(".")[0] === name)!;
      return this.stepItem(s, 0, w.change, w.changeZh);
    });
    return {
      id, kind: "table", title: name, subtitle: t.file, source: { path: t.file, startLine: t.line, endLine: t.line },
      groups: [
        ...this.group("declared", "Steps that change it", declared),
        ...this.group("impact", "Flows that touch it", this.impact([...new Set(ops.map((o) => o.fn))], 3)),
        ...this.group("writers", "Written by", writers.map((o) => this.fnItem(o.fn, o.op === "update" ? 1 : o.op === "insert" ? 0 : 2, `${o.op} · ${short(this.ix.fns[o.fn]!.file)}`))),
        ...this.group("readers", "Read by", readers.map((o) => this.fnItem(o.fn))),
        ...this.group("fk", "Linked tables", [...out, ...fk]),
      ],
    };
  }

  private routeView(id: string, key: string): EntityView | null {
    const i = this.ix.routes.findIndex((r) => `${r.method} ${r.path}` === key);
    const r = this.ix.routes[i];
    if (!r) return null;
    const fn = r.fn === null ? [] : [r.fn];
    return {
      id, kind: "route", title: key, subtitle: r.file, source: { path: r.file, startLine: 1, endLine: 1 },
      groups: [
        ...this.group("impact", "Flows through here", this.impact(fn)),
        ...this.group("callers", "Called by", this.ix.routeCalls.filter((c) => c.route === i).map((c) => this.fnItem(c.fn))),
        ...this.group("code", "Handler", fn.map((f) => this.fnItem(f))),
        ...this.tableGroups(fn),
      ],
    };
  }

  private pageView(id: string, path: string): EntityView | null {
    const p = this.ix.pages.find((x) => x.path === path);
    if (!p) return null;
    const fns = (this.byFile.get(p.file) ?? []).map((f) => f.id);
    const { dist } = this.bfs(fns, 3, "down");
    const calls = this.ix.routeCalls.filter((c) => dist.has(c.fn)).map((c) => this.routeItem(c.route));
    const pageItem = (file: string): LinkItem => { const x = this.ix.pages.find((y) => y.file === file)!; return { id: `page:${x.path}`, kind: "page", label: x.path, hint: short(file) }; };
    const fnSet = new Set(fns);
    const movesTo = this.ix.navs.filter((n) => fnSet.has(n.fn)).map((n) => pageItem(n.page));
    const movesFrom = this.ix.navs.filter((n) => n.page === p.file).flatMap((n) => { const f = this.ix.fns[n.fn]!; return this.ix.pages.some((x) => x.file === f.file) ? [pageItem(f.file)] : [this.fileItem(f.file)]; });
    return {
      id, kind: "page", title: path, subtitle: p.file, source: { path: p.file, startLine: 1, endLine: 1 },
      groups: [
        ...this.group("impact", "Flows through here", (this.stepsByFile.get(p.file) ?? []).map((s) => this.stepItem(s))),
        ...this.group("calls", "Routes it calls", calls),
        ...this.group("to", "Links to", movesTo),
        ...this.group("from", "Linked from", movesFrom),
      ],
    };
  }

  private queueView(id: string, name: string): EntityView | null {
    const q = this.ix.queues.find((x) => x.name === name);
    if (!q) return null;
    const c = q.consumer === null ? [] : [q.consumer];
    return {
      id, kind: "queue", title: name, subtitle: q.file, source: { path: q.file, startLine: q.line, endLine: q.line },
      groups: [
        ...this.group("impact", "Flows through here", this.impact(c, 2)),
        ...this.group("senders", "Sent by", this.ix.sends.filter((s) => s.queue === name).map((s) => this.fnItem(s.fn))),
        ...this.group("code", "Consumer", c.map((f) => this.fnItem(f))),
        ...this.tableGroups(c),
      ],
    };
  }

  private moduleView(id: string, m: string): EntityView | null {
    const n = this.nodes[m];
    if (!n) return null;
    const inModule = (x: string | null | undefined) => x === m || (!!x && x.startsWith(`${m}.`));
    const fns = this.ix.fns.filter((f) => inModule(this.ix.files[f.file]?.module));
    const ids = new Set(fns.map((f) => f.id));
    const outs = new Map<string, number>();
    const ins = new Map<string, number>();
    const top = (x: string) => x.split(".")[0]!;
    this.ix.calls.forEach((cs, a) => {
      const from = this.ix.files[this.ix.fns[a]!.file]?.module;
      for (const b of cs) {
        const to = this.ix.files[this.ix.fns[b]!.file]?.module;
        if (!from || !to || top(from) === top(to)) continue;
        if (ids.has(a)) outs.set(top(to), (outs.get(top(to)) ?? 0) + 1);
        if (ids.has(b)) ins.set(top(from), (ins.get(top(from)) ?? 0) + 1);
      }
    });
    const steps = [...this.steps].filter(([, v]) => v.s.module === m || v.s.claim.refs.some((r) => inModule(this.ix.files[r.path]?.module)));
    const counts = new Map<string, number>();
    for (const [, v] of steps) counts.set(v.j.id, (counts.get(v.j.id) ?? 0) + 1);
    const journeyItems = [...counts].sort((a, b) => b[1] - a[1]).map(([j, c]): LinkItem => {
      const x = this.journeys.find((y) => y.id === j)!;
      return { id: `journey:${j}`, kind: "journey", label: x.title, labelZh: x.titleZh, hint: `${c} steps`, hintZh: `${c} 步` };
    });
    const moduleCalls = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).map(([k, c], i) => this.moduleItem(k, `${c} calls`, `${c} 次调用`, i));
    const tableCounts = new Map<string, { w: number; r: number }>();
    for (const f of ids) for (const o of this.opsByFn.get(f) ?? []) {
      const c = tableCounts.get(o.table) ?? { w: 0, r: 0 };
      if (o.op === "read") c.r++; else c.w++;
      tableCounts.set(o.table, c);
    }
    const tables = [...tableCounts].sort((a, b) => b[1].w - a[1].w || b[1].r - a[1].r).map(([t, c], i) => this.tableItem(t, `${c.w} writes, ${c.r} reads`, `写 ${c.w} · 读 ${c.r}`, i));
    const routes = this.ix.routes.map((r, i) => ({ r, i })).filter((x) => inModule(this.ix.files[x.r.file]?.module)).map((x) => this.routeItem(x.i));
    return {
      id, kind: "module", title: n.title, titleZh: n.zh,
      groups: [
        ...this.group("journeys", "Flows through it", journeyItems),
        ...this.group("out", "Calls into", moduleCalls(outs)),
        ...this.group("in", "Called from", moduleCalls(ins)),
        ...this.group("tables", "Tables", tables),
        ...this.group("routes", "Routes", routes),
        ...this.group("steps", "Steps", steps.map(([s]) => this.stepItem(s))),
      ],
    };
  }

  private journeyView(id: string, jid: string): EntityView | null {
    const j = this.journeys.find((x) => x.id === jid);
    if (!j) return null;
    const c = this.crossings();
    const others = c.links.filter((l) => l.from === jid || l.to === jid).sort((a, b) => b.weight - a.weight).map((l, i): LinkItem => {
      const other = l.from === jid ? l.to : l.from;
      const x = this.journeys.find((y) => y.id === other)!;
      const parts: [string, string][] = [];
      if (l.subflow) parts.push(l.from === jid ? ["calls it", "调用它"] : ["called by it", "被它调用"]);
      if (l.after) parts.push(l.from === jid ? ["runs before it", "在它之前运行"] : ["runs after it", "在它之后运行"]);
      if (l.data.length) parts.push([`${l.data.length} data ${l.data.length === 1 ? "link" : "links"}`, `${l.data.length} 处数据关联`]);
      if (l.fns) parts.push([`${l.fns} shared ${l.fns === 1 ? "function" : "functions"}`, `${l.fns} 个共用函数`]);
      return { id: `journey:${other}`, kind: "journey", label: x.title, labelZh: x.titleZh, hint: parts.map((p) => p[0]).join(", "), hintZh: parts.map((p) => p[1]).join(" · "), rank: i };
    });
    const mods = new Map<string, number>();
    for (const s of j.steps) mods.set(s.module, (mods.get(s.module) ?? 0) + 1);
    const writes = new Map<string, string>();
    for (const s of j.steps) for (const w of s.writes) writes.set(w.target.split(".")[0]!, s.titleZh ?? s.title);
    const title = (x: string) => this.journeys.find((y) => y.id === x)!;
    const stepOf = (jid: string, s: string) => title(jid).steps.find((y) => y.id === s)!;
    const dataItems: LinkItem[] = c.links.flatMap((l) => {
      if (l.from !== jid && l.to !== jid) return [];
      return l.data.slice(0, 6).map((d) => (l.from === jid
        ? this.tableItem(d.table, `read by ${title(l.to).title}: ${stepOf(l.to, d.reader).title}`, `${title(l.to).titleZh} · ${stepOf(l.to, d.reader).titleZh} 读取`, 0)
        : this.tableItem(d.table, `written by ${title(l.from).title}: ${stepOf(l.from, d.writer).title}`, `${title(l.from).titleZh} · ${stepOf(l.from, d.writer).titleZh} 写入`, 1)));
    });
    return {
      id, kind: "journey", title: j.title, titleZh: j.titleZh,
      groups: [
        ...this.group("journeys", "Related flows", others),
        ...this.group("data", "Data links", dataItems),
        ...this.group("modules", "Modules crossed", [...mods].sort((a, b) => b[1] - a[1]).map(([m, n], i) => this.moduleItem(m, `${n} steps`, `${n} 步`, i))),
        ...this.group("tables", "Data changed", [...writes].filter(([t]) => this.ix.tables.some((x) => x.name === t)).map(([t, s]) => this.tableItem(t, s, s))),
      ],
    };
  }

  has(id: string) { return this.entity(id) !== null; }

  private fnById(id: string) {
    if (!id.startsWith("fn:")) return null;
    const key = id.slice(3), hash = key.lastIndexOf("#");
    return this.byFile.get(key.slice(0, hash))?.find((x) => x.name === key.slice(hash + 1)) ?? null;
  }
  /** Only an indexed function reaches the logic tree, so an id can never name a path of its own. */
  fn(id: string): Fn | null {
    const f = this.fnById(id);
    return f && f.kind !== "module" ? f : null;
  }

  entity(id: string): EntityView | null {
    const at = id.indexOf(":");
    const kind = id.slice(0, at), key = id.slice(at + 1);
    if (kind === "step") return this.steps.has(id) ? this.stepView(id) : null;
    if (kind === "journey") return this.journeyView(id, key);
    if (kind === "module") return this.moduleView(id, key);
    if (kind === "file") return this.fileView(id, key);
    if (kind === "table") return this.tableView(id, key);
    if (kind === "route") return this.routeView(id, key);
    if (kind === "page") return this.pageView(id, key);
    if (kind === "queue") return this.queueView(id, key);
    if (kind === "fn") {
      const hash = key.lastIndexOf("#");
      const f = this.byFile.get(key.slice(0, hash))?.find((x) => x.name === key.slice(hash + 1));
      return f ? this.fnView(id, f) : null;
    }
    return null;
  }

  private buildSearch() {
    const add = (id: string, kind: EntityKind, label: string, labelZh: string | undefined, more = "") =>
      this.entries.push({ id, kind, label, labelZh, hay: `${label} ${labelZh ?? ""} ${more}`.toLowerCase() });
    for (const j of this.journeys) {
      add(`journey:${j.id}`, "journey", j.title, j.titleZh, j.id);
      for (const s of j.steps) add(stepId(j.id, s.id), "step", s.title, s.titleZh, `${s.id} ${s.zh} ${s.claim.text}`);
    }
    for (const n of Object.values(this.nodes)) if (n.kind === "module") add(`module:${n.id}`, "module", n.title, n.zh, n.id);
    for (const t of this.ix.tables) add(`table:${t.name}`, "table", t.name, undefined, t.ts);
    for (const r of this.ix.routes) add(`route:${r.method} ${r.path}`, "route", `${r.method} ${r.path}`, undefined, r.file);
    for (const p of this.ix.pages) add(`page:${p.path}`, "page", p.path, undefined, p.file);
    for (const q of this.ix.queues) add(`queue:${q.name}`, "queue", q.name, undefined);
    for (const f of Object.keys(this.ix.files)) add(`file:${f}`, "file", f, undefined);
    for (const f of this.ix.fns) if (f.exported && f.name !== "default") add(this.fnId(f), "fn", f.name, undefined, f.file);
  }

  search(q: string, limit = 24): (LinkItem & { score: number })[] {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const order: Record<EntityKind, number> = { journey: 0, step: 1, module: 2, table: 3, route: 4, page: 5, queue: 6, fn: 7, file: 8 };
    const out: (LinkItem & { score: number })[] = [];
    for (const e of this.entries) {
      if (!words.every((w) => e.hay.includes(w))) continue;
      const name = e.label.toLowerCase();
      const zh = e.labelZh?.toLowerCase();
      const exact = name === words[0] || zh === words[0];
      const score = (exact ? 0 : words.every((w) => name.includes(w) || zh?.includes(w)) ? 20 : 60) + (name.startsWith(words[0]!) ? 0 : 5) + order[e.kind];
      out.push({ id: e.id, kind: e.kind, label: e.label, labelZh: e.labelZh, hint: e.kind === "step" ? this.steps.get(e.id)!.j.title : undefined, hintZh: e.kind === "step" ? this.steps.get(e.id)!.j.titleZh : undefined, score });
    }
    // Hundreds of routes can match one word; a cap per kind keeps every kind of answer in view.
    const seen = new Map<EntityKind, number>();
    return out.sort((a, b) => a.score - b.score || a.label.length - b.label.length).filter((x) => {
      const n = (seen.get(x.kind) ?? 0) + 1;
      seen.set(x.kind, n);
      return n <= 6;
    }).slice(0, limit);
  }

  private stepTables() {
    const out = new Map<string, Map<string, { w: boolean; r: boolean; d: number }>>();
    for (const [id, fns] of this.anchors) out.set(id, this.tablesOf(fns, 2));
    return out;
  }

  private cached?: Crossings;
  crossings(): Crossings {
    if (this.cached) return this.cached;
    const js = this.journeys;
    const reach = this.stepTables();
    const tableCells = new Map<string, Record<string, { w: string[]; r: string[] }>>();
    const cell = (t: string, j: string) => {
      const row = tableCells.get(t) ?? tableCells.set(t, {}).get(t)!;
      return (row[j] ??= { w: [], r: [] });
    };
    const known = new Set(this.ix.tables.map((t) => t.name));
    for (const [id, { j, s }] of this.steps) {
      for (const w of s.writes) {
        const t = w.target.split(".")[0]!;
        if (known.has(t)) { const c = cell(t, j.id); if (!c.w.includes(s.id)) c.w.push(s.id); }
      }
      for (const [t, v] of reach.get(id) ?? []) if (v.r) { const c = cell(t, j.id); if (!c.r.includes(s.id)) c.r.push(s.id); }
    }
    const codeRows: Crossings["code"] = [];
    for (const [fn, steps] of this.stepsByFn) {
      const cells: Record<string, string[]> = {};
      for (const id of steps) { const v = this.steps.get(id)!; (cells[v.j.id] ??= []).push(v.s.id); }
      if (Object.keys(cells).length >= 2) codeRows.push({ id: this.fnId(this.ix.fns[fn]!), label: this.fnLabel(this.ix.fns[fn]!), cells });
    }
    const links: Crossings["links"] = [];
    for (let i = 0; i < js.length; i++) for (let k = 0; k < js.length; k++) {
      if (i === k) continue;
      const a = js[i]!, b = js[k]!;
      const subflow = a.steps.some((s) => s.subflow === b.id);
      const after = b.after.includes(a.id);
      const data: Crossings["links"][number]["data"] = [];
      for (const [t, row] of tableCells) {
        const A = row[a.id], B = row[b.id];
        if (A?.w.length && B?.r.length) data.push({ table: t, writer: A.w[0]!, reader: B.r[0]! });
      }
      const rare = (t: string) => Object.keys(tableCells.get(t) ?? {}).length;
      data.sort((x, y) => rare(x.table) - rare(y.table));
      const fns = i < k ? codeRows.filter((c) => c.cells[a.id] && c.cells[b.id]).length : 0;
      if (!subflow && !after && !data.length && !fns) continue;
      links.push({ from: a.id, to: b.id, subflow, after, data, fns, routes: 0, tables: data.length, weight: (subflow ? 100 : 0) + (after ? 50 : 0) + data.length + fns * 2 });
    }
    const width = (r: Record<string, unknown>) => Object.keys(r).length;
    this.cached = {
      journeys: js.map((j) => ({ id: j.id, title: j.title, titleZh: j.titleZh, steps: j.steps.length })),
      links,
      tables: [...tableCells].filter(([, r]) => Object.values(r).some((c) => c.w.length)).sort((a, b) => width(b[1]) - width(a[1])).map(([table, cells]) => ({ table, cells })),
      code: codeRows.sort((a, b) => width(b.cells) - width(a.cells)),
    };
    return this.cached;
  }

  /** Checks model claims against the index. It never edits them: a miss is a signal for the reader. */
  support(): Support {
    const out: Support = { edges: {}, writes: {}, stats: { codeEdges: 0, confirmedEdges: 0, writes: 0, confirmedWrites: 0, other: 0 } };
    const known = new Set(this.ix.tables.map((t) => t.name));
    const CODE = new Set(["page", "api", "service", "database", "queue"]);
    for (const j of this.journeys) for (const s of j.steps) {
      const id = stepId(j.id, s.id);
      const fns = this.anchors.get(id) ?? [];
      s.writes.forEach((w, i) => {
        const t = w.target.split(".")[0]!;
        const key = `${j.id}/${s.id}/${i}`;
        if (!known.has(t)) { out.writes[key] = "other"; out.stats.other++; return; }
        out.stats.writes++;
        const reach = this.tablesOf(fns, 6).get(t);
        out.writes[key] = reach?.w ? (reach.d === 0 ? "direct" : "reach") : "none";
        if (reach?.w) out.stats.confirmedWrites++;
      });
      for (const n of s.next) {
        const other = j.steps.find((x) => x.id === n.to);
        if (!other || !CODE.has(s.lane) || !CODE.has(other.lane) || s.kind === "subflow" || other.kind === "subflow") continue;
        out.stats.codeEdges++;
        const ok = this.connected(id, stepId(j.id, other.id));
        out.edges[`${j.id}/${s.id}>${n.to}`] = ok;
        if (ok) out.stats.confirmedEdges++;
      }
    }
    return out;
  }

  /**
   * Two steps connect when one calls the other, one orchestrator calls both, one page links to the
   * other, or they share a file. Whole cited files count too: a page reaches its API through a
   * mutation elsewhere in the page, and the cited line is rarely on that path.
   */
  private connected(a: string, b: string) {
    const A = this.anchors.get(a) ?? [], B = this.anchors.get(b) ?? [];
    if (!A.length || !B.length) return false;
    const filesA = new Set(this.refFiles.get(a)), filesB = new Set(this.refFiles.get(b));
    if ([...filesB].some((f) => filesA.has(f))) return true;
    const down = this.bfs(A, 8, "down").dist, up = this.bfs(B, 8, "down").dist;
    if (B.some((x) => down.has(x)) || A.some((x) => up.has(x))) return true;
    const pa = this.bfs(A, 2, "up").dist, pb = this.bfs(B, 2, "up").dist;
    if ([...pa.keys()].some((x) => pb.has(x))) return true;
    const whole = (files: Set<string>) => [...files].flatMap((f) => (this.byFile.get(f) ?? []).map((x) => x.id));
    const wa = whole(filesA), wb = whole(filesB);
    const da = this.bfs(wa, 4, "down").dist, db = this.bfs(wb, 4, "down").dist;
    if (wb.some((x) => da.has(x)) || wa.some((x) => db.has(x))) return true;
    return this.ix.navs.some((n) => (da.has(n.fn) && filesB.has(n.page)) || (db.has(n.fn) && filesA.has(n.page)));
  }
}
