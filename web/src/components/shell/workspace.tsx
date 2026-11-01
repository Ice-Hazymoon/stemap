import type { ReactNode } from "react";
import { useSearch } from "@tanstack/react-router";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Inspector } from "@/features/inspector/inspector";
import { SourcePanel } from "@/features/source/source-panel";
import { useIsMobile } from "@/hooks/use-mobile";
import { useLang } from "@/lib/lang";
import { useCloseSource } from "@/lib/nav";

/** One layout for every view. A step, a table or a function all open in the same two places. */
export function Workspace({ main, side, phoneMain = "above" }: { main: ReactNode; side?: ReactNode; phoneMain?: "above" | "hidden" | "only" }) {
  const { i, file, line, end } = useSearch({ strict: false });
  const phone = useIsMobile();
  const { t } = useLang();
  const close = useCloseSource();
  const panel = i ? <Inspector key={i} id={i} /> : side;
  const target = file ? { path: file, startLine: line ?? 1, endLine: end ?? line ?? 1 } : null;
  if (phone) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {phoneMain !== "hidden" && <div className={phoneMain === "only" ? "shrink-0" : "h-[44dvh] shrink-0 border-b"}>{main}</div>}
        {panel && <div className="min-h-[60dvh] shrink-0">{panel}</div>}
        <Sheet open={!!target} onOpenChange={(open) => { if (!open) close(); }}>
          <SheetContent side="bottom" className="h-[70dvh] gap-0 p-0 [&>button]:hidden">
            <SheetTitle className="sr-only">{t("源代码", "Source")}</SheetTitle>
            {target && <SourcePanel target={target} />}
          </SheetContent>
        </Sheet>
      </div>
    );
  }
  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel minSize="420px">
        <ResizablePanelGroup orientation="vertical">
          <ResizablePanel minSize="160px"><div className="h-full min-h-0">{main}</div></ResizablePanel>
          {target && <ResizableHandle />}
          {target && <ResizablePanel id="source" defaultSize="42%" minSize="120px"><SourcePanel target={target} /></ResizablePanel>}
        </ResizablePanelGroup>
      </ResizablePanel>
      {panel && <ResizableHandle />}
      {panel && <ResizablePanel id="side" defaultSize="400px" minSize="320px" maxSize="640px"><div className="h-full min-h-0 bg-card">{panel}</div></ResizablePanel>}
    </ResizablePanelGroup>
  );
}
