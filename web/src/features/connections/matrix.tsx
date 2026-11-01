import { useMemo, useState } from "react";
import { columnFilteringFeature, createColumnHelper, createFilteredRowModel, filterFn_includesString, tableFeatures, useTable } from "@tanstack/react-table";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty } from "@/components/shell/section";
import { orderedJourneys } from "@/features/journey/layout";
import type { Atlas, Crossings } from "@/lib/api";
import { useLang } from "@/lib/lang";
import { useOpenItem } from "@/lib/nav";
import { cn } from "@/lib/utils";

export type MatrixTab = "tables" | "code";
interface Cell { w: string[]; r: string[] }
export interface Row { id: string; label: string; cells: Record<string, Cell> }
export interface CellPick { row: string; journey: string; w: string[]; r: string[] }

const features = tableFeatures({ columnFilteringFeature, filteredRowModel: createFilteredRowModel(), filterFns: { includesString: filterFn_includesString } });
const helper = createColumnHelper<typeof features, Row>();

function toRows(c: Crossings, tab: MatrixTab): Row[] {
  if (tab === "tables") return c.tables.map((t) => ({ id: `table:${t.table}`, label: t.table, cells: t.cells }));
  const reads = (cells: Record<string, string[]>) => Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, { w: [], r: v }]));
  return c.code.map((x) => ({ id: x.id, label: x.label, cells: reads(x.cells) }));
}

/** Written is mass, read is a point. An outlined square would read as an empty checkbox. */
const Mark = ({ write, strong }: { write: boolean; strong?: boolean }) => <i className={cn("inline-block rounded-full", write ? "size-2.5 bg-muted-foreground" : "size-1 bg-edge", strong && "bg-foreground")} />;

export function Matrix({ atlas, c, tab, cell, focus, onTab, onCell, onJourney }: {
  atlas: Atlas; c: Crossings; tab: MatrixTab; cell: CellPick | null; focus?: string; onTab: (t: MatrixTab) => void; onCell: (p: CellPick) => void; onJourney: (id: string) => void;
}) {
  const { t } = useLang();
  const onItem = useOpenItem();
  const [q, setQ] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const cols = useMemo(() => orderedJourneys(atlas), [atlas]);
  const data = useMemo(() => toRows(c, tab), [c, tab]);
  const columns = useMemo(() => helper.columns([
    helper.accessor("label", { id: "label", header: "", filterFn: "includesString" }),
    ...cols.map((j) => helper.accessor((r) => r.cells[j.id], { id: j.id, header: t(j.titleZh, j.title) })),
  ]), [cols, t]);
  const table = useTable({
    features, columns, data, getRowId: (r) => r.id,
    state: { columnFilters: q ? [{ id: "label", value: q }] : [] },
  });
  const rows = table.getRowModel().rows;
  const legend = tab === "tables"
    ? <><span className="inline-flex items-center gap-1.5"><Mark write />{t("写入", "Writes")}</span><span className="inline-flex items-center gap-1.5"><Mark write={false} />{t("读取", "Reads")}</span></>
    : <span>{t("同一个函数被多条流程引用，改动会影响全部。", "One function, cited by several flows. A change reaches all of them.")}</span>;
  return (
    <section className="flex min-h-0 flex-1 flex-col max-md:min-h-[420px]">
      <div className="flex shrink-0 items-center gap-4 border-b px-4 max-md:flex-wrap">
        <Tabs value={tab} onValueChange={(v) => onTab(v as MatrixTab)}>
          <TabsList variant="line" className="gap-4">
            <TabsTrigger value="tables" className="flex-none px-0">{t("表", "Tables")}<span className="font-mono text-caption text-muted-foreground tabular-nums">{c.tables.length}</span></TabsTrigger>
            <TabsTrigger value="code" className="flex-none px-0">{t("共用代码", "Shared code")}<span className="font-mono text-caption text-muted-foreground tabular-nums">{c.code.length}</span></TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex min-w-0 flex-1 justify-end gap-3.5 overflow-hidden text-caption whitespace-nowrap text-muted-foreground max-md:hidden">{legend}</div>
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("筛选", "Filter rows")} aria-label={t("筛选", "Filter rows")} className="my-1.5 h-8 w-36 max-md:w-full" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[620px] table-fixed border-separate border-spacing-0 text-ui">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-30 w-56 border-b bg-background" />
              {cols.map((j) => (
                <th key={j.id} scope="col" className="sticky top-0 z-20 border-b bg-background px-1 py-2 align-bottom text-caption leading-tight font-medium">
                  <button onClick={() => onJourney(j.id)} className={cn("text-muted-foreground transition-colors hover:text-primary", (hover === j.id || focus === j.id) && "text-primary")}>{t(j.titleZh, j.title)}</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody onMouseLeave={() => setHover(null)}>
            {rows.map(({ original: r }) => (
              <tr key={r.id} className="group/row">
                <th scope="row" className="sticky left-0 z-10 border-b bg-background pr-3 pl-4 text-left font-normal group-hover/row:bg-muted">
                  <button title={r.label} onClick={() => onItem({ id: r.id, kind: r.id.slice(0, r.id.indexOf(":")) as "table" })} className="block max-w-full truncate font-mono text-caption transition-colors hover:text-primary">{r.label}</button>
                </th>
                {cols.map((j) => {
                  const v = r.cells[j.id];
                  const lit = hover === j.id || focus === j.id;
                  const on = cell?.row === r.label && cell.journey === j.id;
                  return (
                    <td key={j.id} onMouseEnter={() => setHover(j.id)} className={cn("border-b p-0 text-center group-hover/row:bg-muted", lit && "bg-muted")}>
                      {v && (
                        <button aria-pressed={on} aria-label={`${r.label}, ${j.titleZh}`} onClick={() => onCell({ row: r.label, journey: j.id, w: v.w, r: v.r })} className={cn("grid h-7 w-full place-items-center transition-colors hover:bg-accent", on && "bg-primary *:bg-primary-foreground!")}>
                          {tab === "tables" ? <Mark write={v.w.length > 0} strong={focus === j.id} /> : <span className="text-caption font-medium text-muted-foreground tabular-nums">{v.r.length}</span>}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="px-4"><Empty>{t(`没有匹配“${q}”的行。`, `No row matches “${q}”.`)}</Empty></div>}
      </div>
    </section>
  );
}
