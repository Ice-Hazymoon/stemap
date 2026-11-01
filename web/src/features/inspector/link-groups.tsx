import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/shell/section";
import type { EntityView, LinkGroup, LinkItem } from "@/lib/api";
import { useLang } from "@/lib/lang";
import { cn } from "@/lib/utils";

/** Group titles come from the query layer, which also serves agents, so the page translates them here. */
const TITLE_ZH: Record<string, string> = {
  "Also in": "同样出现在", Functions: "函数", "Routes in": "入口路由", "Tables reached": "涉及的表", "Tables": "表", "Data changed": "写入", "Flows through here": "经过这里的流程", "Flows that touch it": "碰到它的流程",
  "Called by": "被调用", "Called from": "调用方", Calls: "调用", "Calls into": "调用到", "Data links": "数据关联", "Flows through it": "经过它的流程", "Modules crossed": "跨过的模块", "Related flows": "相关流程", Routes: "路由", Steps: "步骤", Queues: "队列", Module: "模块", "Imported by": "被引用", Imports: "引用", "Steps that change it": "改动它的步骤", "Written by": "写入方", "Read by": "读取方",
  "Linked tables": "关联表", Handler: "处理函数", "Routes it calls": "调用的路由", "Links to": "跳转到", "Linked from": "从这里跳入", "Sent by": "发送方", Consumer: "消费方",
};

function Item({ x, onItem }: { x: LinkItem; onItem: (x: LinkItem) => void }) {
  const { t } = useLang();
  const code = !x.labelZh && !["journey", "step", "module"].includes(x.kind);
  const hint = x.hint ? t(x.hintZh, x.hint) : undefined;
  return (
    <li>
      <button onClick={() => onItem(x)} className="group/item flex w-full items-start gap-2 rounded-[4px] px-2 py-1.5 text-left transition-colors duration-150 ease-out hover:bg-muted">
        <span className="grid min-w-0 flex-1">
          <span className={cn("text-ui font-medium break-words", code && "font-mono text-caption font-normal")}>{t(x.labelZh, x.label)}</span>
          {hint && <small className="text-caption break-words text-muted-foreground">{hint}</small>}
        </span>
        <ChevronRight size={14} aria-hidden className="mt-0.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/item:opacity-100" />
      </button>
    </li>
  );
}

export function Group({ g, onItem, limit = 6 }: { g: LinkGroup; onItem: (x: LinkItem) => void; limit?: number }) {
  const { t } = useLang();
  const [all, setAll] = useState(false);
  const shown = all ? g.items : g.items.slice(0, limit);
  const more = g.total - shown.length;
  return (
    <Section title={t(TITLE_ZH[g.title], g.title)} count={g.total}>
      <ul className="-mx-2 grid gap-px">{shown.map((x) => <Item key={x.id} x={x} onItem={onItem} />)}</ul>
      {more > 0 && (all
        ? <p className="mt-2 text-caption text-muted-foreground">{t(`另有 ${more} 项未列出，可以用搜索找到。`, `${more} more are not listed. Search can find them.`)}</p>
        : <Button variant="link" size="sm" className="mt-1 h-auto p-0 text-caption" onClick={() => setAll(true)}>{t(`显示全部 ${g.total} 项`, `Show all ${g.total}`)}</Button>)}
    </Section>
  );
}

export function Groups({ view, onItem, only }: { view: EntityView; onItem: (x: LinkItem) => void; only?: string[] }) {
  const list = only ? only.flatMap((k) => view.groups.filter((g) => g.key === k)) : view.groups;
  return <>{list.map((g) => <Group key={g.key} g={g} onItem={onItem} />)}</>;
}
