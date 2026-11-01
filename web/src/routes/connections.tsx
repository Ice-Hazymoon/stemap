import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { Empty } from "@/components/shell/section";
import { Workspace } from "@/components/shell/workspace";
import { Matrix, type CellPick } from "@/features/connections/matrix";
import { Relations } from "@/features/connections/relations";
import { CrossingSide } from "@/features/connections/side";
import { atlasQuery } from "@/lib/api";
import { useLang } from "@/lib/lang";

export const Route = createFileRoute("/connections")({
  validateSearch: z.object({ tab: z.enum(["tables", "code"]).optional().catch(undefined) }),
  component: ConnectionsPage,
});

const key = "block w-4 border-t-[1.5px]";

function ConnectionsPage() {
  const { data: atlas } = useSuspenseQuery(atlasQuery);
  const { t } = useLang();
  const navigate = Route.useNavigate();
  const { tab = "tables", i } = Route.useSearch();
  const [cell, setCell] = useState<CellPick | null>(null);
  const c = atlas.crossings;
  if (!c || !atlas.journeys.length) return <div className="p-6"><Empty>{t("关联比较各条流程，这张地图还没有流程。", "Links compare flows, and this map has none yet.")} <Link to="/" className="underline underline-offset-2">{t("看看怎么添加", "See how to add them")}</Link></Empty></div>;
  const selected = i?.startsWith("journey:") ? i.slice(8) : undefined;
  const inspect = (id: string) => void navigate({ search: (p) => ({ ...p, i: `journey:${id}` }) });
  return (
    <Workspace phoneMain="only"
      main={
        <div className="flex h-full min-h-0 flex-col">
          <section className="shrink-0 border-b px-6 pt-5 pb-3.5">
            <header className="flex items-start justify-between gap-4 max-md:flex-col max-md:gap-1.5">
              <div>
                <h1 className="text-title font-semibold">{t("流程之间", "How flows connect")}</h1>
                <p className="mt-1 text-ui text-muted-foreground">{t("选一条流程，看哪些流程依赖它的数据。", "Choose a flow to see which other flows depend on its data.")}</p>
              </div>
              <ul className="mt-1 flex shrink-0 gap-3.5 text-caption text-muted-foreground">
                <li className="flex items-center gap-1.5"><i className={`${key} border-primary`} />{t("调用", "Calls")}</li>
                <li className="flex items-center gap-1.5"><i className={`${key} border-dashed border-edge`} />{t("随后运行", "Runs after")}</li>
                <li className="flex items-center gap-1.5"><i className={`${key} border-dotted border-edge`} />{t("数据", "Data")}</li>
              </ul>
            </header>
            <Relations c={c} selected={selected} onPick={inspect} />
          </section>
          <Matrix atlas={atlas} c={c} tab={tab} cell={cell} focus={selected} onJourney={inspect}
            onCell={(p) => { setCell(p); void navigate({ search: (s) => ({ ...s, i: undefined }), replace: true }); }}
            onTab={(t) => { setCell(null); void navigate({ search: (s) => ({ ...s, tab: t === "tables" ? undefined : t }), replace: true }); }} />
        </div>
      }
      side={<CrossingSide atlas={atlas} cell={cell} />}
    />
  );
}
