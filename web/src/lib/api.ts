import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { Atlas, ViewJourney, ViewNode, ViewStep } from "#engine/bundle";
import type { CodeIndex } from "#engine/codeindex";
import { Graph, type EntityKind, type EntityView, type LinkGroup, type LinkItem, type Crossings } from "#engine/graph";
import type { Cond, LogicNode, LogicTree } from "#engine/logic";
import { load } from "./data";

export type { Atlas, Cond, Crossings, EntityKind, EntityView, LinkGroup, LinkItem, LogicNode, ViewJourney, ViewNode, ViewStep };
export type Tree = LogicTree & { file: string };
export type Hit = LinkItem & { score?: number };

interface IndexChunk { index: CodeIndex; files: string[] }
interface FileChunk { source: string | null; logic: Record<number, LogicTree> }

let graph: Promise<{ graph: Graph; files: Map<string, number> }> | null = null;

/** The query layer runs here, in the page, over the same index the CLI reads. */
const site = () => (graph ??= Promise.all([load<Atlas>("atlas"), load<IndexChunk>("index")]).then(([atlas, { index, files }]) => ({
  graph: new Graph(index, atlas.journeys, atlas.nodes),
  files: new Map(files.map((f, i) => [f, i])),
})));

async function fileChunk(path: string): Promise<FileChunk | null> {
  const i = (await site()).files.get(path);
  return i === undefined ? null : load<FileChunk>(`files/${i}`).catch(() => null);
}

export const atlasQuery = queryOptions({ queryKey: ["atlas"], queryFn: () => load<Atlas>("atlas") });

export const entityQuery = (id: string) => queryOptions({ queryKey: ["entity", id], queryFn: async () => (await site()).graph.entity(id) });
export const logicQuery = (id: string) => queryOptions({
  queryKey: ["logic", id],
  queryFn: async (): Promise<Tree | null> => {
    const f = (await site()).graph.fn(id);
    const tree = f && (await fileChunk(f.file))?.logic[f.id];
    return f && tree ? { ...tree, file: f.file } : null;
  },
});
export const searchQuery = (q: string) => queryOptions({
  queryKey: ["search", q], enabled: !!q.trim(), placeholderData: keepPreviousData,
  queryFn: async (): Promise<Hit[]> => (await site()).graph.search(q),
});
export const sourceQuery = (path: string) => queryOptions({
  queryKey: ["source", path],
  queryFn: async () => {
    const source = (await fileChunk(path))?.source;
    if (source === null || source === undefined) throw new Error("This file is not in this page");
    return source;
  },
});
