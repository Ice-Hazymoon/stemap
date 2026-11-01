import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { CornerDownRight } from "lucide-react";
import { Workspace } from "@/components/shell/workspace";
import { FlowFacts, FlowGlyph } from "@/features/journey/glyph";
import { journeyTree } from "@/features/journey/layout";
import { atlasQuery } from "@/lib/api";
import { movedIn } from "@/lib/drift";
import { useLang } from "@/lib/lang";

export const Route = createFileRoute("/journeys/")({ component: Flows });

/** Every flow in reading order. A subflow sits under the flow that enters it, so the list itself shows what leads where. */
function Flows() {
  const { data: atlas } = useSuspenseQuery(atlasQuery);
  const { t } = useLang();
  const rows = journeyTree(atlas);
  if (!rows.length) return <Navigate to="/" replace />;
  return (
    <Workspace phoneMain="only" main={
      <div className="h-full overflow-auto">
        <div className="mx-auto grid max-w-[920px] gap-6 px-8 py-9 max-sm:px-4 max-sm:py-6">
          <h1 className="text-display font-semibold tracking-[-0.01em]">{t("流程", "Flows")}</h1>
          <ol className="divide-y overflow-hidden rounded-md bg-card shadow-raised">
            {rows.map(({ j, depth }) => (
              <li key={j.id}>
                <Link to="/journeys/$journeyId" params={{ journeyId: j.id }} style={{ paddingLeft: 16 + Math.max(depth - 1, 0) * 20 }} className="flex items-center gap-6 py-3.5 pr-4 -outline-offset-2 transition-colors duration-150 ease-out hover:bg-muted">
                  <span className="flex min-w-0 flex-1 gap-2">
                    {depth > 0 && <CornerDownRight size={14} aria-hidden className="mt-[3px] shrink-0 text-muted-foreground" />}
                    <span className="grid min-w-0 gap-0.5">
                      <span className="text-body leading-snug font-medium">{t(j.titleZh, j.title)}</span>
                      <span className="line-clamp-2 text-ui text-pretty text-muted-foreground">{t(j.goalZh, j.goal)}</span>
                      <span className="mt-1"><FlowFacts j={j} moved={movedIn(atlas, j.id)} /></span>
                    </span>
                  </span>
                  <div className="w-48 shrink-0 max-md:hidden"><FlowGlyph j={j} /></div>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      </div>
    } />
  );
}
