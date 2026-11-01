import { useNavigate } from "@tanstack/react-router";
import { Section } from "@/components/shell/section";
import { Progress } from "./progress";
import type { Atlas } from "@/lib/api";
import { useLang } from "@/lib/lang";
import type { CellPick } from "./matrix";

const Meter = ({ value, total, label }: { value: number; total: number; label: string }) => (
  <div>
    <div className="mb-1.5 flex items-baseline justify-between text-ui text-muted-foreground"><span>{label}</span><strong className="font-semibold text-foreground tabular-nums">{value}<span className="font-normal text-muted-foreground">/{total}</span></strong></div>
    <Progress value={(value / total) * 100} />
  </div>
);

/** With nothing picked the panel says how to read the table, then how far a blank cell can be trusted. */
export function CrossingSide({ atlas, cell }: { atlas: Atlas; cell: CellPick | null }) {
  const { t } = useLang();
  const navigate = useNavigate();
  const head = (kicker: string, title: string, sub: string, mono?: boolean) => (
    <header className="px-6 pt-5 pb-3.5">
      <span className="font-mono text-caption text-muted-foreground">{kicker}</span>
      <h2 className={mono ? "mt-1 font-mono text-[17px] font-medium break-words" : "mt-1 text-title font-semibold"}>{title}</h2>
      <p className="mt-0.5 text-ui text-muted-foreground">{sub}</p>
    </header>
  );
  if (cell) {
    const j = atlas.journeys.find((x) => x.id === cell.journey)!;
    const list = (ids: string[], title: string) => ids.length > 0 && (
      <Section title={title} count={ids.length}>
        <ul className="-mx-2 grid gap-px">{ids.map((id) => {
          const s = j.steps.find((x) => x.id === id);
          return s && (
            <li key={id}><button className="flex w-full items-center gap-2 rounded-[4px] px-2 py-1.5 text-left text-ui font-medium transition-colors duration-150 ease-out hover:bg-muted" onClick={() => void navigate({ to: "/journeys/$journeyId", params: { journeyId: j.id }, search: { step: id } })}>
              <span className="min-w-0">{t(s.titleZh, s.title)}</span>
            </button></li>
          );
        })}</ul>
      </Section>
    );
    return (
      <aside className="flex h-full min-w-0 flex-col">
        {head(t("交叉点", "crossing"), cell.row, t(j.titleZh, j.title), true)}
        <div className="grid min-h-0 flex-1 content-start gap-5 overflow-auto border-t px-6 py-5">{list(cell.w, t("写入的步骤", "Steps that write"))}{list(cell.r, t("涉及的步骤", "Steps involved"))}</div>
      </aside>
    );
  }
  const s = atlas.support?.stats;
  return (
    <aside className="flex h-full min-w-0 flex-col">
      {head(t("怎么读", "how to read it"), t("哪条流程碰了什么", "What each flow touches"), t("每一列是一条流程。点圆点或数字，看是哪几步。", "Each column is a flow. Click a dot or number to see the steps."))}
      {s && (
        <div className="grid min-h-0 flex-1 content-start gap-3 overflow-auto border-t px-6 py-5">
          <Section title={t("这张图覆盖了多少", "How much this covers")}>
            <div className="grid gap-3">
              <Meter value={s.confirmedEdges} total={s.codeEdges} label={t("流程里的连线在代码里找到了", "Flow links found in the code")} />
              <Meter value={s.confirmedWrites} total={s.writes} label={t("数据写入追到了", "Data writes traced")} />
            </div>
            <p className="mt-2 text-caption text-muted-foreground">{t("没找到不等于有错：第三方库内部的写入和仓库外发起的 webhook 看不到，这些连线在流程图上是点线。", "A miss is not an error. Writes inside libraries and webhooks from outside cannot be seen; those links are dotted in a flow.")}</p>
          </Section>
        </div>
      )}
    </aside>
  );
}
