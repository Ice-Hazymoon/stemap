import { useEffect, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet, useRouter } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { z } from "zod";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { TermContext } from "@/components/shell/prose";
import { KeysDialog } from "@/components/shell/keys-dialog";
import { SearchDialog } from "@/components/shell/search-dialog";
import { TopBar } from "@/components/shell/top-bar";
import { atlasQuery } from "@/lib/api";
import { atlasHasZh, LangProvider } from "@/lib/lang";
import { TrailProvider } from "@/lib/trail";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // The inspector and the source live in the URL, so any view can be shared and the back button walks them.
  validateSearch: z.object({
    i: z.string().optional().catch(undefined),
    file: z.string().optional().catch(undefined),
    line: z.number().optional().catch(undefined),
    end: z.number().optional().catch(undefined),
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(atlasQuery),
  component: Root,
  pendingComponent: () => <div className="grid h-full place-items-center"><span className="animate-pulse font-mono text-[15px] font-medium">stemap</span></div>,
  errorComponent: () => (
    <div className="grid h-full place-items-center p-6 text-center text-ui text-muted-foreground">
      <p>The map did not load. Run <code className="font-mono">stemap</code> in the repository, then reload.</p>
    </div>
  ),
});

function Root() {
  const { data: atlas } = useSuspenseQuery(atlasQuery);
  const router = useRouter();
  const [search, setSearch] = useState(false);
  const [keys, setKeys] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea");
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) { e.preventDefault(); setSearch(true); }
      if (e.key === "?" && !typing) setKeys(true);
      if (e.key !== "Escape" || document.querySelector("[role=dialog]")) return;
      // Esc takes back what opened last: the source panel sits on top of the details.
      const open = router.state.location.search as { file?: string; i?: string };
      if (open.file) void router.navigate({ to: ".", search: (p: object) => ({ ...p, file: undefined, line: undefined, end: undefined }) });
      else if (open.i) void router.navigate({ to: ".", search: (p: object) => ({ ...p, i: undefined }) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <LangProvider hasZh={atlasHasZh(atlas)}>
        <TrailProvider>
          <TooltipProvider delayDuration={300}>
            <TermContext.Provider value={atlas.glossary}>
              <SidebarProvider defaultOpen={false} className="h-svh min-h-0 flex-col" style={{ "--sidebar-width": "15rem" } as React.CSSProperties}>
                <TopBar onSearch={() => setSearch(true)} onKeys={() => setKeys(true)} />
                <div className="flex min-h-0 flex-1">
                  <AppSidebar />
                  <SidebarInset className="min-h-0 min-w-0"><Outlet /></SidebarInset>
                </div>
              </SidebarProvider>
              <SearchDialog open={search} onOpenChange={setSearch} />
              <KeysDialog open={keys} onOpenChange={setKeys} />
            </TermContext.Provider>
          </TooltipProvider>
        </TrailProvider>
      </LangProvider>
    </ThemeProvider>
  );
}
