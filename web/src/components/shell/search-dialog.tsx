import { useDeferredValue, useMemo, useState } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { KIND_NAME, KIND_ZH } from "@/components/shell/icons";
import { atlasQuery, searchQuery, type EntityKind, type Hit } from "@/lib/api";
import { useLang } from "@/lib/lang";
import { useOpenItem } from "@/lib/nav";
import { cn } from "@/lib/utils";

const ORDER: EntityKind[] = ["journey", "step", "module", "table", "route", "page", "queue", "fn", "file"];

/** Nothing typed yet still answers something: the flows are where most reading starts. */
export function SearchDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data: atlas } = useSuspenseQuery(atlasQuery);
  const { t } = useLang();
  const onItem = useOpenItem();
  const [q, setQ] = useState("");
  const deferred = useDeferredValue(q.trim());
  const { data: hits = [] } = useQuery(searchQuery(deferred));
  const starters = useMemo<Hit[]>(() => atlas.journeys.map((j) => ({ id: `journey:${j.id}`, kind: "journey", label: j.title, labelZh: j.titleZh, hint: `${j.steps.length} steps`, hintZh: `${j.steps.length} 步` })), [atlas]);
  const shown = q.trim() ? hits : starters;
  const groups = useMemo(() => ORDER.flatMap((k) => { const items = shown.filter((h) => h.kind === k); return items.length ? [{ kind: k, items }] : []; }), [shown]);
  const close = (next: boolean) => { onOpenChange(next); if (!next) setQ(""); };
  return (
    <CommandDialog open={open} onOpenChange={close} title={t("搜索", "Search")} description={t("搜索流程、表、路由、函数和文件", "Search flows, tables, routes, functions and files")} className="sm:max-w-xl">
      {/* The server ranks the results, so the client filter stays off. */}
      <Command shouldFilter={false}>
        <CommandInput value={q} onValueChange={setQ} placeholder={t("搜索流程、表、路由、函数、文件", "Search flows, tables, routes, functions, files")} />
        <CommandList className="max-h-[60vh]">
          <CommandEmpty>{q.trim() ? t(`没有匹配“${q}”的结果。试试表名、路由或文件路径的一部分。`, `Nothing matches “${q}”. Try a table name, a route, or part of a file path.`) : t("输入表名、路由或文件路径的一部分。", "Type a table name, a route, or part of a file path.")}</CommandEmpty>
          {groups.map((g) => (
            <CommandGroup key={g.kind} heading={q.trim() ? t(KIND_ZH[g.kind], `${KIND_NAME[g.kind]}s`) : t("从一条流程开始", "Start with a flow")}>
              {g.items.map((h) => {
                const code = !h.labelZh && h.kind !== "journey" && h.kind !== "module";
                return (
                  <CommandItem key={h.id} value={h.id} onSelect={() => { close(false); onItem(h); }}>
                    <span className={cn("min-w-0 truncate", code && "font-mono text-caption")}>{t(h.labelZh, h.label)}</span>
                    {h.hint && <span className="ml-auto max-w-[44%] truncate text-caption text-muted-foreground tabular-nums">{t(h.hintZh, h.hint)}</span>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
