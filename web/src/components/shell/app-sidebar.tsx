import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams, useSearch } from "@tanstack/react-router";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { hasOutline } from "@/components/shell/top-bar";
import { journeyTree } from "@/features/journey/layout";
import { ModuleOutline } from "@/features/modules/outline";
import { atlasQuery, type Atlas } from "@/lib/api";
import { useLang } from "@/lib/lang";
import { useTrail } from "@/lib/trail";
import { cn } from "@/lib/utils";

const inked = "data-[active=true]:bg-sidebar-primary data-[active=true]:text-sidebar-primary-foreground data-[active=true]:font-medium";

function JourneyNav({ atlas }: { atlas: Atlas }) {
  const { t } = useLang();
  const trail = useTrail();
  const { journeyId } = useParams({ strict: false });
  const { step } = useSearch({ strict: false });
  const current = atlas.journeys.find((j) => j.id === journeyId);
  const activeStep = step ?? current?.steps[0]?.id;
  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>{t("流程", "Flows")}</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu className="gap-px">
            {journeyTree(atlas).map(({ j, depth }) => (
              <SidebarMenuItem key={j.id} style={{ paddingLeft: depth * 12 }}>
                <SidebarMenuButton asChild size="sm" isActive={j.id === journeyId} title={t(j.titleZh, j.title)} className={cn("pr-8", inked)}>
                  <Link to="/journeys/$journeyId" params={{ journeyId: j.id }}><span className="truncate">{t(j.titleZh, j.title)}</span></Link>
                </SidebarMenuButton>
                <SidebarMenuBadge className="font-mono tabular-nums">{j.steps.length}</SidebarMenuBadge>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      {current && (
        <SidebarGroup>
          <SidebarGroupLabel className="justify-between"><span>{t("步骤", "Steps")}</span><span className="font-mono font-normal tabular-nums">{trail.length}/{current.steps.length}</span></SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-px">
              {current.steps.map((s, i) => (
                <SidebarMenuItem key={s.id}>
                  <SidebarMenuButton asChild size="sm" isActive={s.id === activeStep} className={cn("h-auto min-h-6 py-1 text-sidebar-foreground/70", inked, trail.includes(s.id) && "text-sidebar-foreground", s.kind === "failure" && "text-destructive")}>
                    <Link to="/journeys/$journeyId" params={{ journeyId: current.id }} search={(p) => ({ ...p, step: s.id, i: undefined })}>
                      <span className="w-5 shrink-0 text-right font-mono text-caption text-muted-foreground tabular-nums">{i + 1}</span><span className="line-clamp-2 leading-tight whitespace-normal">{t(s.titleZh, s.title)}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      )}
    </>
  );
}

/** The outline of what the tabs opened: the view's own contents, never a second navigation. */
export function AppSidebar() {
  const { data: atlas } = useSuspenseQuery(atlasQuery);
  const { pathname } = useLocation();
  if (!hasOutline(pathname)) return null;
  return (
    <Sidebar collapsible="offcanvas" className="top-12 h-[calc(100svh-3rem)]">
      <SidebarContent className="gap-0">
        {pathname.startsWith("/journeys") ? <JourneyNav atlas={atlas} /> : <ModuleOutline atlas={atlas} />}
      </SidebarContent>
    </Sidebar>
  );
}
