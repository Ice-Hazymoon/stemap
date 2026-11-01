import { Fragment } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams, useSearch } from "@tanstack/react-router";
import { ChevronsUpDown, Keyboard, Moon, Search, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { atlasQuery } from "@/lib/api";
import { useLang, type Lang } from "@/lib/lang";
import { cn } from "@/lib/utils";

/** The flow list is its own contents, so only an open flow has an outline beside it. */
export const hasOutline = (pathname: string) => /^\/journeys\/[^/]/.test(pathname) || pathname.startsWith("/modules");

/** The path through subflows lives here, so a reader always sees how deep they went. */
function Crumbs({ onSwitch }: { onSwitch: () => void }) {
  const { data: atlas } = useSuspenseQuery(atlasQuery);
  const { t } = useLang();
  const { journeyId } = useParams({ strict: false });
  const { via = [] } = useSearch({ strict: false });
  const journey = atlas.journeys.find((j) => j.id === journeyId);
  if (!journey) return null;
  const chain = via.flatMap((v, i) => {
    const [j, s] = v.split("/");
    const x = atlas.journeys.find((y) => y.id === j);
    return x ? [{ j: x, s: s!, via: via.slice(0, i) }] : [];
  });
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap gap-1 text-ui sm:gap-1.5">
        <BreadcrumbSeparator className="mr-1 text-muted-foreground">/</BreadcrumbSeparator>
        {chain.map((c) => (
          <Fragment key={c.j.id}>
            <BreadcrumbItem className="min-w-0"><BreadcrumbLink asChild><Link to="/journeys/$journeyId" params={{ journeyId: c.j.id }} search={{ step: c.s, via: c.via }} className="truncate">{t(c.j.titleZh, c.j.title)}</Link></BreadcrumbLink></BreadcrumbItem>
            <BreadcrumbSeparator />
          </Fragment>
        ))}
        <BreadcrumbItem className="min-w-0">
          {/* Search opens on the flow list, so this one control both names the flow and changes it. */}
          <button onClick={onSwitch} title={t("切换流程", "Switch flow")} className="inline-flex min-w-0 items-center gap-1 text-foreground hover:text-foreground"><span className="truncate">{t(journey.titleZh, journey.title)}</span><ChevronsUpDown size={12} aria-hidden className="shrink-0 text-muted-foreground" /></button>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function Tabs() {
  const { data: atlas } = useSuspenseQuery(atlasQuery);
  const { t } = useLang();
  const { pathname } = useLocation();
  const tab = "rounded-[5px] px-3 py-1.5 text-ui leading-5 font-medium text-muted-foreground transition-[color,background-color] duration-150 ease-out hover:text-foreground data-[on=true]:bg-primary data-[on=true]:text-primary-foreground";
  return (
    <nav aria-label={t("视图", "Views")} className="flex items-center gap-0.5">
      <Link to="/" className={tab} data-on={pathname === "/"}>{t("总览", "Overview")}</Link>
      {atlas.journeys.length > 0 && <Link to="/journeys" className={tab} data-on={pathname.startsWith("/journeys")}>{t("流程", "Flows")}</Link>}
      <Link to="/modules" className={tab} data-on={pathname.startsWith("/modules")}>{t("模块", "Modules")}</Link>
      {atlas.crossings && atlas.journeys.length > 0 && <Link to="/connections" className={tab} data-on={pathname.startsWith("/connections")}>{t("关联", "Links")}</Link>}
    </nav>
  );
}

function ThemeToggle() {
  const { t } = useLang();
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const label = dark ? t("使用浅色主题", "Use the light theme") : t("使用深色主题", "Use the dark theme");
  return <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={label} title={label} onClick={() => setTheme(dark ? "light" : "dark")}>{dark ? <Sun /> : <Moon />}</Button>;
}

export function TopBar({ onSearch, onKeys }: { onSearch: () => void; onKeys: () => void }) {
  const { t, lang, hasZh, setLang } = useLang();
  const { pathname } = useLocation();
  return (
    <header className="flex shrink-0 items-center gap-x-4 gap-y-1.5 border-b bg-card px-3.5 py-2 max-sm:flex-wrap sm:h-12">
      {hasOutline(pathname) && <SidebarTrigger className="size-8 text-muted-foreground" />}
      <Link to="/" className="font-mono text-body leading-none font-medium tracking-[-0.01em]">stemap</Link>
      <div className="max-sm:order-last max-sm:w-full"><Tabs /></div>
      <div className="min-w-0 flex-1 text-ui max-md:hidden"><Crumbs onSwitch={onSearch} /></div>
      <div className={cn("ml-auto flex shrink-0 items-center gap-1")}>
        <Button variant="outline" size="sm" onClick={onSearch} aria-label={t("搜索", "Search")} className="h-8 w-52 justify-start gap-2 border-transparent bg-muted pr-1.5 pl-2.5 font-normal text-muted-foreground shadow-none hover:bg-secondary max-lg:w-8 max-lg:justify-center max-lg:px-0">
          <Search className="size-3.5" /><span className="truncate max-lg:hidden">{t("搜索函数、表、路由", "Search everything")}</span><Kbd className="ml-auto bg-card font-mono max-lg:hidden">⌘K</Kbd>
        </Button>
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground max-md:hidden" aria-label={t("键盘操作", "Keyboard")} title={t("键盘操作", "Keyboard")} onClick={onKeys}><Keyboard /></Button>
        <ThemeToggle />
        {hasZh && (
          <ToggleGroup type="single" size="sm" className="text-muted-foreground" value={lang} onValueChange={(v) => { if (v) setLang(v as Lang); }} aria-label={t("内容语言", "Content language")}>
            <ToggleGroupItem value="zh" title="显示中文内容" className="h-8 min-w-8 px-1.5 text-caption">中</ToggleGroupItem>
            <ToggleGroupItem value="en" title="Show content in STE English" className="h-8 min-w-8 px-1.5 text-caption">EN</ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>
    </header>
  );
}
