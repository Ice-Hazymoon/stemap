import { useEffect, useState, useSyncExternalStore } from "react";
import { Box, render, Text, useInput, useWindowSize, type RenderOptions } from "ink";
import type { JobEvent } from "./agentrun";
import { elapsed, HEX } from "./term";

export interface LogRow { tool: string; detail: string; result?: string }
export interface JobRow { tag: string; state: "pending" | "running" | "done" | "failed"; tool: string; started: number; ms: number; size: number; log: LogRow[]; message?: string }

/** The run writes here and the panel reads it, so a job never has to know a screen exists. */
export class PanelStore {
  rows: JobRow[] = [];
  modules = 0;
  modulesDone = 0;
  claims = 0;
  tokens = { input: 0, output: 0 };
  note = "";
  paused = false;
  stopping = false;
  version = 0;
  readonly started = Date.now();
  private listeners = new Set<() => void>();

  constructor(readonly head: { title: string; repo: string; agent: string }, readonly stop: () => void) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  snapshot = () => this.version;
  touch() { this.version++; for (const fn of this.listeners) fn(); }

  private row(tag: string) {
    let r = this.rows.find((x) => x.tag === tag);
    if (!r) { r = { tag, state: "pending", tool: "", started: 0, ms: 0, size: 1, log: [] }; this.rows.push(r); }
    return r;
  }

  apply(e: JobEvent) {
    if (e.type === "plan") { this.modules = e.modules; for (const t of e.jobs) this.row(t); }
    else if (e.type === "start") Object.assign(this.row(e.tag), { state: "running", started: Date.now() });
    else if (e.type === "tool") {
      const r = this.row(e.tag);
      if (e.result) { const last = r.log.findLast((x) => x.tool === e.tool && !x.result); if (last) last.result = e.result; }
      else { r.tool = e.tool; r.log.push({ tool: e.tool, detail: e.detail }); }
    } else if (e.type === "done") {
      Object.assign(this.row(e.tag), { state: "done", ms: e.ms, tool: "" });
      this.modulesDone += e.modules;
      this.claims = e.claims;
    } else if (e.type === "failed") Object.assign(this.row(e.tag), { state: "failed", message: e.message, tool: "" });
    else if (e.type === "usage") this.tokens = { input: e.input, output: e.output };
    this.touch();
  }
}

const SPIN = ["◐", "◓", "◑", "◒"];
const isFlow = (r: JobRow) => r.tag.startsWith("flow ");
const name = (r: JobRow) => r.tag.replace(/^flow /, "").replace(/^modules \d+: /, "");
const kilo = (n: number) => `${Math.round(n / 1000)}k`;

function Row({ r, on, tick, width }: { r: JobRow; on: boolean; tick: number; width: number }) {
  const mark = r.state === "done" ? <Text color={HEX.sage}>✓</Text> : r.state === "failed" ? <Text color={HEX.pink}>✕</Text> : r.state === "running" ? <Text color={HEX.butter}>{SPIN[tick % 4]}</Text> : <Text color={HEX.dim}>○</Text>;
  const room = Math.max(10, width - 22);
  const right = r.state === "done" ? elapsed(r.ms) : r.state === "running" ? r.tool || "starting" : r.state === "failed" ? "failed" : "";
  return (
    <Box justifyContent="space-between" {...(on ? { backgroundColor: HEX.row } : {})}>
      <Box width={room}><Text wrap="truncate-end">{mark} <Text color={r.state === "pending" ? HEX.dim : undefined}>{name(r)}</Text></Text></Box>
      <Text color={r.state === "running" ? HEX.lilac : HEX.dim} wrap="truncate-end">{right}</Text>
    </Box>
  );
}

function Bar({ done, total, width }: { done: number; total: number; width: number }) {
  const room = Math.max(8, width - 14);
  const fill = total ? Math.round((done / total) * room) : 0;
  return <Text><Text color={HEX.sage}>{"━".repeat(fill)}</Text><Text color={HEX.dim}>{"━".repeat(room - fill)}</Text>  {done} of {total}</Text>;
}

function Log({ r, height }: { r: JobRow | undefined; height: number }) {
  if (!r) return null;
  const rows = r.log.flatMap((l) => [{ k: "t", l }, ...(l.detail ? [{ k: "d", l }] : [])]).slice(-height);
  return (
    <>
      <Text bold wrap="truncate-end">{name(r)}</Text>
      {r.message && <Text color={HEX.pink} wrap="truncate-end">{r.message}</Text>}
      {rows.map(({ k, l }, i) => k === "t"
        ? <Text key={i} wrap="truncate-end"><Text color={HEX.lilac}>{l.tool}</Text>{l.result ? <Text color={l.result.startsWith("PASS") ? HEX.sage : HEX.pink}>  {l.result}</Text> : null}</Text>
        : <Text key={i} color={HEX.dim} wrap="truncate-end">  {l.detail}</Text>)}
    </>
  );
}

function Panel({ store }: { store: PanelStore }) {
  useSyncExternalStore(store.subscribe, store.snapshot);
  const { columns, rows: height } = useWindowSize();
  const [tick, setTick] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 250); return () => clearInterval(t); }, []);

  const flows = store.rows.filter(isFlow);
  const moduleRows = store.rows.filter((r) => !isFlow(r));
  const working = moduleRows.filter((r) => r.state === "running" || r.state === "failed");
  const list = [...flows, ...working];
  // Until a person chooses, the log follows whichever job moved last.
  const live = list.findLast((r) => r.state === "running") ?? list.at(-1);
  const selected = list.find((r) => r.tag === picked) ?? live;
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) { store.stopping = true; store.stop(); store.touch(); }
    if (input === "p") { store.paused = !store.paused; store.touch(); }
    if (key.upArrow || key.downArrow) {
      const at = list.findIndex((r) => r.tag === selected?.tag);
      setPicked(list[Math.max(0, Math.min(list.length - 1, at + (key.downArrow ? 1 : -1)))]?.tag ?? null);
    }
  });

  const wide = columns >= 92;
  const left = wide ? Math.min(52, Math.floor(columns * 0.54)) : columns;
  // Ink repaints the whole screen once a frame outgrows the terminal, so the list scrolls instead of growing.
  const space = Math.max(3, height - 15 - Math.min(working.length, 3));
  const from = Math.max(0, Math.min(flows.findIndex((r) => r.tag === selected?.tag) - Math.floor(space / 2), flows.length - space));
  const shown = flows.slice(from, from + space);
  const done = flows.filter((r) => r.state === "done").length;
  const ms = Date.now() - store.started;
  const box = { borderStyle: "round", borderColor: HEX.dim, paddingX: 1, flexDirection: "column" } as const;
  return (
    <Box flexDirection="column" width={columns}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text><Text backgroundColor={HEX.sage} color={HEX.ink} bold> {store.head.title} </Text> {store.head.repo}</Text>
        <Text color={HEX.dim}>{store.head.agent} · {elapsed(ms)}</Text>
      </Box>
      <Box>
        <Box flexDirection="column" width={left} flexShrink={0}>
          <Box {...box}>
            <Text color={HEX.dim}>Flows {done}/{flows.length}</Text>
            {shown.map((r) => <Row key={r.tag} r={r} on={wide && r.tag === selected?.tag} tick={tick} width={left - 4} />)}
            {flows.length > shown.length && <Text color={HEX.dim}>{flows.length - shown.length} more</Text>}
          </Box>
          <Box {...box}>
            <Text color={HEX.dim}>Modules</Text>
            <Bar done={store.modulesDone} total={store.modules} width={left - 4} />
            {working.slice(0, 3).map((r) => <Row key={r.tag} r={r} on={wide && r.tag === selected?.tag} tick={tick} width={left - 4} />)}
          </Box>
        </Box>
        {wide && <Box {...box} flexGrow={1} marginLeft={1}><Log r={selected} height={Math.max(4, height - 10)} /></Box>}
      </Box>
      <Box justifyContent="space-between" marginTop={1}>
        <Text color={HEX.dim}>{kilo(store.tokens.input)} tokens in · {kilo(store.tokens.output)} out</Text>
        {store.claims > 0 && <Text color={HEX.sage}>{store.claims} claims passed the gate</Text>}
      </Box>
      <Text wrap="truncate-end">
        {store.stopping ? <Text color={HEX.butter}>Stopping. Finished work stays; stemap fill continues from there.</Text> : store.note ? <Text color={HEX.dim}>{store.note}</Text> : (
          <Text><Text color={HEX.sage}>↑↓</Text><Text color={HEX.dim}> choose job   </Text><Text color={HEX.sage}>p</Text><Text color={HEX.dim}> {store.paused ? "resume new jobs" : "pause new jobs"}   </Text><Text color={HEX.sage}>q</Text><Text color={HEX.dim}> stop; stemap fill resumes</Text></Text>
        )}
      </Text>
    </Box>
  );
}

export function showPanel(store: PanelStore, options: Omit<RenderOptions, "exitOnCtrlC" | "patchConsole"> = {}) {
  const app = render(<Panel store={store} />, { ...options, exitOnCtrlC: false, patchConsole: false });
  return () => { app.unmount(); };
}
