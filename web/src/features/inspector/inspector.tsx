import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { KIND_NAME, KIND_ZH } from "@/components/shell/icons";
import { Empty, Section } from "@/components/shell/section";
import { LogicView } from "@/features/logic/logic-view";
import { entityQuery, type EntityKind } from "@/lib/api";
import { useLang } from "@/lib/lang";
import { useOpenItem, useOpenSource } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { Groups } from "./link-groups";

export function Inspector({ id }: { id: string }) {
  const { t } = useLang();
  const router = useRouter();
  const navigate = useNavigate();
  const onItem = useOpenItem();
  const onSource = useOpenSource();
  const { data: view, isPending } = useQuery(entityQuery(id));
  const kind = id.slice(0, id.indexOf(":")) as EntityKind;
  const mono = ["fn", "table", "route", "file", "queue", "page"].includes(kind);
  return (
    <aside aria-label={t("详情", "Details")} className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 pt-3 pr-3 pl-4">
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t("返回", "Go back")} onClick={() => router.history.back()}><ArrowLeft /></Button>
        <span className="font-mono text-caption text-muted-foreground">{t(KIND_ZH[kind], KIND_NAME[kind].toLowerCase())}</span>
        <Button variant="ghost" size="icon" className="ml-auto size-8 text-muted-foreground" aria-label={t("关闭详情", "Close details")} onClick={() => void navigate({ to: ".", search: (p) => ({ ...p, i: undefined }) })}><X /></Button>
      </div>
      {isPending && <div className="grid gap-2.5 p-4"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-4" /><Skeleton className="h-4 w-4/5" /></div>}
      {!isPending && !view && <div className="px-6"><Empty>{t("索引里没有这一项，它可能在索引范围之外。", "The index has no entry for this. It may be outside the indexed folders.")}</Empty></div>}
      {view && (
        <>
          <header className="grid gap-1 px-6 pt-1 pb-3.5">
            <h2 className={cn("text-title font-semibold break-words", mono && "font-mono text-[17px] font-medium")}>{t(view.titleZh, view.title)}</h2>
            {view.subtitle && <p className="font-mono text-caption break-words text-muted-foreground">{view.subtitle}</p>}
          </header>
          {(view.source || kind === "module") && (
            <div className="flex flex-wrap gap-2 px-6 pb-4">
              {view.source && <Button className="h-9 px-3.5" onClick={() => onSource(view.source!)}>{t("打开源码", "Open source")}</Button>}
              {kind === "module" && <Button variant="outline" className="h-9 px-3.5" onClick={() => void navigate({ to: "/modules", search: { node: id.slice(7) } })}>{t("在模块图中打开", "Open in module map")}</Button>}
            </div>
          )}
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-6 overflow-auto border-t px-6 py-5">
            {kind === "fn" && <Section title={t("判断逻辑", "Decision logic")} aside={t("来自代码", "from the code")}><LogicView id={id} onOpen={onSource} /></Section>}
            {view.groups.length ? <Groups view={view} onItem={onItem} /> : <Empty>{t("索引没有找到关联。动态调用和原始 SQL 不在索引内，所以关联仍可能存在。", "The index found no link. Dynamic calls and raw SQL sit outside it, so a link can still exist.")}</Empty>}
          </div>
        </>
      )}
    </aside>
  );
}
