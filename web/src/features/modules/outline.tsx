import { useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SidebarGroup, SidebarGroupContent, SidebarInput, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub } from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Atlas, ViewNode } from "@/lib/api";
import { useLang } from "@/lib/lang";
import { cn } from "@/lib/utils";

interface RowProps { atlas: Atlas; id: string; selected: string; open: Set<string>; toggle: (id: string) => void; onSelect: (id: string) => void; filter: Set<string> | null }

function Row({ atlas, id, selected, open, toggle, onSelect, filter }: RowProps) {
  const n = atlas.nodes[id];
  if (!n || (filter && !filter.has(id))) return null;
  const kids = n.children.filter((c) => atlas.nodes[c]);
  const isOpen = filter ? true : open.has(id);
  const Button = (
    <SidebarMenuButton size="sm" isActive={id === selected} onClick={() => onSelect(id)} className="pr-6 data-[active=true]:bg-sidebar-primary data-[active=true]:text-sidebar-primary-foreground">
      <span>{n.title}</span>
    </SidebarMenuButton>
  );
  if (!kids.length) return <SidebarMenuItem>{Button}</SidebarMenuItem>;
  return (
    <SidebarMenuItem>
      <Collapsible open={isOpen} onOpenChange={() => toggle(id)}>
        {Button}
        <CollapsibleTrigger aria-label={`${isOpen ? "Collapse" : "Expand"} ${n.title}`} className="group/twist absolute top-0.5 right-1 grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-sidebar-accent">
          <ChevronRight size={13} className="transition-transform duration-150 group-data-[state=open]/twist:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub className="mr-0 gap-px pr-0">{kids.map((c) => <Row key={c} {...{ atlas, id: c, selected, open, toggle, onSelect, filter }} />)}</SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    </SidebarMenuItem>
  );
}

const matches = (n: ViewNode, q: string) => [n.title, n.id, n.zh ?? "", n.oneLine?.text ?? ""].some((s) => s.toLowerCase().includes(q));

export function ModuleOutline({ atlas }: { atlas: Atlas }) {
  const { t } = useLang();
  const navigate = useNavigate();
  const { node } = useSearch({ strict: false });
  const [q, setQ] = useState("");
  const [view, setView] = useState("tree");
  const root = atlas.nodes[atlas.rootId]!;
  const [open, setOpen] = useState(() => new Set([atlas.rootId, ...root.children]));
  const toggle = (id: string) => setOpen((s) => { const c = new Set(s); if (!c.delete(id)) c.add(id); return c; });
  const selected = node && atlas.nodes[node] ? node : atlas.rootId;
  const filter = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return null;
    const keep = new Set<string>();
    for (const n of Object.values(atlas.nodes)) {
      if (!matches(n, needle)) continue;
      for (let p: ViewNode | undefined = n; p; p = p.parent ? atlas.nodes[p.parent] : undefined) keep.add(p.id);
    }
    return keep;
  }, [q, atlas]);
  const terms = atlas.glossary.filter((x) => !q || x.term.toLowerCase().includes(q.toLowerCase()));
  const onSelect = (id: string) => void navigate({ to: "/modules", search: (p) => ({ ...p, node: id, i: undefined }), replace: true });
  return (
    <SidebarGroup>
      <SidebarGroupContent className="grid gap-2">
        <Tabs value={view} onValueChange={setView}><TabsList variant="line" className="w-full justify-start gap-4">
          <TabsTrigger value="tree" className="flex-none px-0 text-ui">{t("大纲", "Outline")}</TabsTrigger>
          <TabsTrigger value="terms" className="flex-none px-0 text-ui">{t("术语", "Terms")} {atlas.glossary.length}</TabsTrigger>
        </TabsList></Tabs>
        <SidebarInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={view === "tree" ? t("筛选模块", "Filter modules") : t("筛选术语", "Filter terms")} aria-label={t("筛选", "Filter")} />
        {view === "tree"
          ? <SidebarMenu className="gap-px"><Row {...{ atlas, id: atlas.rootId, selected, open, toggle, onSelect, filter }} /></SidebarMenu>
          : <dl className="grid">{terms.map((x) => (
              <div key={x.term} className="border-b py-1.5">
                <dt className="text-ui font-medium">{x.term} <span className="font-normal text-muted-foreground">{x.type}</span></dt>
                <dd className="text-caption text-muted-foreground">{x.definition}</dd>
              </div>
            ))}</dl>}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
