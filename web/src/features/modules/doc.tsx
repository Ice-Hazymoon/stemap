import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Prose } from "@/components/shell/prose";
import { Empty } from "@/components/shell/section";
import { Groups } from "@/features/inspector/link-groups";
import { entityQuery, type Atlas, type ViewNode } from "@/lib/api";
import { useLang } from "@/lib/lang";
import { useOpenItem, useOpenSource, type SourceRef } from "@/lib/nav";
import { DriftDot } from "@/lib/drift";
import type { ViewClaim } from "#engine/bundle";
import { ancestors } from "./tree";

type OnOpen = (r: SourceRef) => void;

function ClaimText({ claim, onOpen }: { claim: ViewClaim; onOpen: OnOpen }) {
  const { lang, t } = useLang();
  return (
    <>
      {lang === "zh" && claim.zh ? <span lang="zh">{claim.zh}</span> : <Prose text={claim.text} />}{" "}
      {claim.drift && <DriftDot state={claim.drift} noun="statement" className="mr-1" />}
      {claim.refs.map((r, i) => (
        <button key={i} title={`${r.path}:${r.startLine}`} onClick={() => onOpen(r)} className="mr-1 inline-block max-w-full truncate align-baseline font-mono text-caption text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">
          {r.path.split("/").pop()}:{r.startLine}
        </button>
      ))}
      {claim.status === "unverified" && (
        <details className="mt-1 border-l-2 border-destructive pl-2 text-caption"><summary className="cursor-pointer">{t("这句话的依据在代码里找不到", "Unverified")}</summary><ul>{claim.faults.map((f, i) => <li key={i}>{f}</li>)}</ul></details>
      )}
    </>
  );
}

function Crossing({ id }: { id: string }) {
  const { t } = useLang();
  const onItem = useOpenItem();
  const { data: view, isPending } = useQuery(entityQuery(`module:${id}`));
  if (isPending) return <div className="grid gap-2"><Skeleton className="h-4" /><Skeleton className="h-4 w-2/3" /></div>;
  if (!view?.groups.length) return <Empty>{t("索引没有找到这个节点的关联。", "The index found no link for this node.")}</Empty>;
  return <div className="grid gap-5"><Groups view={view} onItem={onItem} /></div>;
}

function Relations({ atlas, node, onSelect, onOpen }: { atlas: Atlas; node: ViewNode; onSelect: (id: string) => void; onOpen: OnOpen }) {
  const { t } = useLang();
  const within = (id: string) => ancestors(atlas, id).some((n) => n.id === node.id);
  const rows = atlas.edges.filter((e) => within(e.from) !== within(e.to));
  if (!rows.length) return <Empty>{t("没有声明的依赖。", "No declared dependency.")}</Empty>;
  return (
    <ul className="grid divide-y">
      {rows.map((e, i) => {
        const out = within(e.from);
        const other = out ? e.to : e.from;
        const first = e.refs[0];
        return (
          <li key={i} className="grid gap-0.5 py-2.5">
            <div className="flex flex-wrap items-center gap-1.5 text-ui">
              <span className="rounded-[3px] bg-muted px-1.5 text-caption leading-5">{out ? t("使用", "uses") : t("被使用", "used by")}</span>
              <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onSelect(other)}>{atlas.nodes[other]?.title ?? other}</Button>
              <span className="text-caption text-muted-foreground">{e.kind}</span>
            </div>
            <p className="text-ui text-muted-foreground" lang="zh">{e.note}</p>
            {first && <button className="justify-self-start font-mono text-caption underline underline-offset-2" onClick={() => onOpen({ path: first.path, startLine: 1, endLine: 1 })}>{first.path.split("/").pop()}</button>}
          </li>
        );
      })}
    </ul>
  );
}

type FileRow = ViewNode["files"][number];
const features = tableFeatures({});
const helper = createColumnHelper<typeof features, FileRow>();

function Files({ files, onOpen }: { files: FileRow[]; onOpen: OnOpen }) {
  const { t } = useLang();
  const columns = useMemo(() => helper.columns([
    helper.accessor("path", {
      header: t("文件", "File"),
      cell: (c) => <button title={c.getValue()} className="block max-w-[220px] truncate text-left font-mono text-caption hover:underline" onClick={() => onOpen({ path: c.getValue(), startLine: 1, endLine: 1 })}>{c.getValue().split("/").slice(-2).join("/")}</button>,
    }),
    helper.accessor("lines", { header: t("行数", "Lines"), cell: (c) => c.getValue().toLocaleString() }),
    helper.accessor("commits90d", { header: t("90 天提交", "90d") }),
  ]), [onOpen, t]);
  const table = useTable({ features, columns, data: files });
  return (
    <Table>
      <TableHeader>{table.getHeaderGroups().map((g) => <TableRow key={g.id}>{g.headers.map((h, i) => <TableHead key={h.id} className={i ? "text-right" : ""}><table.FlexRender header={h} /></TableHead>)}</TableRow>)}</TableHeader>
      <TableBody>{table.getRowModel().rows.map((r) => <TableRow key={r.id}>{r.getAllCells().map((c, i) => <TableCell key={c.id} className={i ? "text-right tabular-nums" : ""}><table.FlexRender cell={c} /></TableCell>)}</TableRow>)}</TableBody>
    </Table>
  );
}

export function ModuleDoc({ atlas, node, focused, onSelect, onFocus }: { atlas: Atlas; node: ViewNode; focused: boolean; onSelect: (id: string) => void; onFocus: (id: string) => void }) {
  const { lang, t } = useLang();
  const onOpen = useOpenSource();
  const coded = node.kind === "module" || node.kind === "capability";
  const path = ancestors(atlas, node.id);
  const within = (id: string) => ancestors(atlas, id).some((n) => n.id === node.id);
  const named = (n: ViewNode) => (n.kind === "domain" && lang === "zh" && n.zh ? n.zh : n.title);
  const blank = !node.summary.length && !node.oneLine && !node.cautions.length;
  const size = node.lines > 0 ? `${node.fileCount.toLocaleString()} ${t("个文件", "files")} · ${node.lines.toLocaleString()} ${t("行代码", "lines of code")}` : null;
  const body = "min-h-0 overflow-auto px-6 py-5 text-ui leading-relaxed";
  const tabs: { value: string; label: string; count?: number; show: boolean }[] = [
    { value: "overview", label: t("说明", "Overview"), show: true },
    { value: "links", label: t("路由与表", "Routes and tables"), show: coded },
    { value: "flows", label: t("内部流程", "Inner flows"), count: node.flows.length, show: node.flows.length > 0 },
    { value: "files", label: t("文件", "Files"), count: node.files.length, show: node.files.length > 0 },
    { value: "relations", label: t("依赖", "Depends on"), show: atlas.edges.some((e) => within(e.from) !== within(e.to)) },
    { value: "ask", label: t("常见问题", "Questions"), count: node.qa.length, show: node.qa.length > 0 },
  ];
  return (
    <aside aria-label={t("模块说明", "Module document")} className="flex h-full min-w-0 flex-col">
      <nav className="flex min-h-5 flex-wrap gap-x-1.5 px-6 pt-5 font-mono text-caption text-muted-foreground">
        {path.length > 1 && path.map((n, i, all) => <span key={n.id} className="inline-flex gap-1.5"><button className="hover:text-foreground" onClick={() => onSelect(n.id)}>{named(n)}</button>{i < all.length - 1 && <span aria-hidden className="opacity-50">/</span>}</span>)}
      </nav>
      <header className="flex items-start gap-3 px-6 pt-1.5 pb-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-title font-semibold">{node.kind === "domain" && lang === "zh" && node.zh ? node.zh : node.title}</h2>
          {lang === "zh" && node.zh && node.kind !== "domain" && <p className="text-ui text-muted-foreground" lang="zh">{node.zh}</p>}
          {size && <p className="font-mono text-caption text-muted-foreground tabular-nums">{size}</p>}
        </div>
        {!focused && node.children.length > 0 && <Button variant="outline" size="sm" onClick={() => onFocus(node.id)}>{t("只看这部分", "Show only this")}</Button>}
      </header>
      <Tabs defaultValue="overview" className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="w-full justify-start gap-4 overflow-x-auto overflow-y-hidden border-b px-6 [scrollbar-width:none]">
          {tabs.filter((x) => x.show).map((x) => <TabsTrigger key={x.value} value={x.value} className="flex-none px-0">{x.label}{!!x.count && <span className="font-mono text-caption text-muted-foreground tabular-nums">{x.count}</span>}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="overview" className={body}>
          <div className="grid gap-3">
            {node.oneLine && !node.summary.length && <p><ClaimText claim={node.oneLine} onOpen={onOpen} /></p>}
            {blank && <Empty>{t("还没有文档。运行 stemap fill 让本机代理写。", "No document yet. Run stemap fill to have a local agent write one.")}</Empty>}
            {node.summary.length > 0 && <ol className="grid gap-2.5">{node.summary.map((c, i) => <li key={i}><ClaimText claim={c} onOpen={onOpen} /></li>)}</ol>}
            {node.cautions.length > 0 && <div className="grid gap-2 border-l-2 border-edge pl-3">{node.cautions.map((c, i) => <p key={i}><ClaimText claim={c} onOpen={onOpen} /></p>)}</div>}
            {node.children.length > 0 && (
              <div className="mt-2 hidden gap-1.5 max-md:grid">
                {node.children.map((id) => { const c = atlas.nodes[id]; return c && (
                  <button key={id} onClick={() => onSelect(id)} className="rounded-[4px] bg-card p-2.5 text-left shadow-raised transition-shadow duration-150 ease-out hover:shadow-raised-hover">
                    <strong className="text-ui font-semibold">{named(c)}</strong>
                    {lang === "zh" && c.kind !== "domain" && c.zh ? <span className="block text-caption text-muted-foreground">{c.zh}</span> : lang !== "zh" && c.oneLine && <span className="block text-caption text-muted-foreground"><Prose text={c.oneLine.text} plain /></span>}
                  </button>
                ); })}
              </div>
            )}
          </div>
        </TabsContent>
        {coded && <TabsContent value="links" className={body}><Crossing id={node.id} /></TabsContent>}
        <TabsContent value="flows" className={body}>
          {node.flows.length ? node.flows.map((f, i) => (
            <section key={i} className="mb-5">
              <h3 className="mb-2 text-ui font-semibold">{f.title}</h3>
              <ol className="grid list-inside list-decimal gap-2 marker:text-muted-foreground">{f.steps.map((s, j) => <li key={j}><ClaimText claim={s} onOpen={onOpen} /></li>)}</ol>
            </section>
          )) : <Empty>{t("这一层没有内部流程。", "No flow at this level.")}</Empty>}
        </TabsContent>
        <TabsContent value="files" className={body}>{node.files.length ? <Files files={node.files} onOpen={onOpen} /> : <Empty>{t("这一层没有文件列表。", "No file list at this level.")}</Empty>}</TabsContent>
        <TabsContent value="relations" className={body}><Relations atlas={atlas} node={node} onSelect={onSelect} onOpen={onOpen} /></TabsContent>
        <TabsContent value="ask" className={body}>
          {node.qa.length ? node.qa.map((q, i) => (
            <details key={i} open={i === 0} className="border-b py-2">
              <summary className="mb-2 cursor-pointer font-semibold">{q.question}</summary>
              <ol className="grid gap-2">{q.answer.map((c, j) => <li key={j}><ClaimText claim={c} onOpen={onOpen} /></li>)}</ol>
            </details>
          )) : <Empty>{t("这个模块没有保存的问题。", "No saved question for this module.")}</Empty>}
        </TabsContent>
      </Tabs>
    </aside>
  );
}
