import { useCallback, useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Workspace } from "@/components/shell/workspace";
import { ModuleCanvas } from "@/features/modules/canvas";
import { ModuleDoc } from "@/features/modules/doc";
import { ancestors } from "@/features/modules/tree";
import { atlasQuery } from "@/lib/api";

export const Route = createFileRoute("/modules")({
  validateSearch: z.object({
    node: z.string().optional().catch(undefined),
    x: z.array(z.string()).optional().catch(undefined),
    focus: z.string().optional().catch(undefined),
  }),
  component: ModulesPage,
});

function ModulesPage() {
  const { data: atlas } = useSuspenseQuery(atlasQuery);
  const navigate = Route.useNavigate();
  const { node, x = [], focus } = Route.useSearch();
  const selected = node && atlas.nodes[node] ? node : atlas.rootId;
  const root = focus && atlas.nodes[focus] ? focus : atlas.rootId;
  const expanded = useMemo(() => new Set(x.filter((id) => atlas.nodes[id])), [x, atlas]);
  const select = useCallback((id: string) => {
    // A node chosen from the outline must be visible on the canvas.
    const chain = ancestors(atlas, id).slice(0, -1).filter((n) => n.kind === "module").map((n) => n.id);
    void navigate({ search: (p) => ({
      ...p, node: id, i: undefined, x: [...new Set([...(p.x ?? []), ...chain])],
      focus: ancestors(atlas, id).some((n) => n.id === root) ? p.focus : undefined,
    }), replace: true });
  }, [atlas, navigate, root]);
  const toggle = useCallback((id: string) => {
    void navigate({ search: (p) => {
      const s = new Set(p.x);
      if (!s.delete(id)) s.add(id);
      return { ...p, x: [...s] };
    }, replace: true });
  }, [navigate]);
  const setFocus = useCallback((id: string) => void navigate({ search: (p) => ({ ...p, focus: id === atlas.rootId ? undefined : id }), replace: true }), [atlas.rootId, navigate]);
  return (
    <Workspace phoneMain="hidden"
      main={
        <div className="relative h-full">
          {root !== atlas.rootId && <Button variant="outline" size="sm" className="absolute top-2.5 left-2.5 z-10" onClick={() => setFocus(atlas.rootId)}>All domains</Button>}
          <ModuleCanvas atlas={atlas} selected={selected} focus={root} expanded={expanded} onSelect={select} onToggle={toggle} />
        </div>
      }
      side={<ModuleDoc key={selected} atlas={atlas} node={atlas.nodes[selected]!} focused={root === selected} onSelect={select} onFocus={setFocus} />}
    />
  );
}
