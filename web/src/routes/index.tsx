import { useMemo, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, ChevronRight, Copy as CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Workspace } from "@/components/shell/workspace";
import { FlowFacts, FlowGlyph } from "@/features/journey/glyph";
import { orderedJourneys } from "@/features/journey/layout";
import { atlasQuery, type Atlas, type ViewJourney } from "@/lib/api";
import { movedIn } from "@/lib/drift";
import { useLang } from "@/lib/lang";
import { useOpenSource } from "@/lib/nav";

export const Route = createFileRoute("/")({ component: Home });

/** What the code index found, so even an empty map says something true about the repository. */
function facts(atlas: Atlas, t: (zh: string, en: string) => string) {
  const ix = atlas.index;
  const modules = Object.values(atlas.nodes).filter((n) => n.kind === "module").length;
  const line = (zh: string, en: string, n?: number) => [t(zh, n === 1 ? en : `${en}s`), n] as const;
  return [line("模块", "module", modules), line("路由", "route", ix?.routes), line("表", "table", ix?.tables), line("函数", "function", ix?.fns)].filter(([, v]) => v !== undefined);
}

function Start({ atlas }: { atlas: Atlas }) {
  const { t } = useLang();
  const name = atlas.nodes[atlas.rootId]?.title;
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto grid max-w-xl content-start gap-6 px-6 py-12 max-sm:px-4 max-sm:py-6">
        <header className="grid gap-2">
          <h1 className="text-display font-semibold tracking-[-0.01em] break-words">{atlas.mapped ? t("还没有流程", "No flows yet") : `${name ?? "This repository"} has no map yet`}</h1>
          <p className="text-ui text-muted-foreground">{atlas.mapped ? t("地图里有模块，但没有流程。流程把一次用户操作逐步对到代码上。", "The map has modules but no flows. Flows show a user action step by step through the code.") : t("代理写好流程和模块说明后，内容会出现在这里。", "Flows and module notes appear here once an agent has written them.")}</p>
        </header>
        <p className="font-mono text-caption text-muted-foreground tabular-nums">{facts(atlas, t).map(([k, v]) => `${v?.toLocaleString()} ${k}`).join("  ·  ")}</p>
        <ol className="grid gap-3 text-ui">
          {!atlas.mapped && <li className="grid gap-1.5"><span>1. {t("在仓库里运行", "In the repository, run")}</span><Copy text="npx stemap init" /></li>}
          <li className="grid gap-1.5"><span>{atlas.mapped ? "" : "2. "}{t("让本机代理填写地图", "Let a local agent fill the map")}</span><Copy text="npx stemap fill" quiet={!atlas.mapped} /></li>
        </ol>
        {atlas.mapped && <Link to="/modules" className="text-ui underline underline-offset-2">{t("打开模块", "Open modules")}</Link>}
      </div>
    </div>
  );
}

function Tile({ j, moved }: { j: ViewJourney; moved: number }) {
  const { t } = useLang();
  return (
    <Link to="/journeys/$journeyId" params={{ journeyId: j.id }} className="group/tile flex flex-col gap-3 rounded-md bg-card p-4 shadow-raised transition-shadow duration-150 ease-out hover:shadow-raised-hover">
      <span className="grid gap-0.5">
        <span className="text-[17px] leading-snug font-medium">{t(j.titleZh, j.title)}</span>
        <span className="line-clamp-2 text-ui text-pretty text-muted-foreground">{t(j.goalZh, j.goal)}</span>
        <span className="mt-1"><FlowFacts j={j} moved={moved} /></span>
      </span>
      <FlowGlyph j={j} />
    </Link>
  );
}

function Copy({ text, quiet }: { text: string; quiet?: boolean }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }); };
  return (
    <Button variant={quiet ? "secondary" : "default"} className="h-10 justify-between font-mono text-ui font-normal" onClick={copy} aria-label={t(`复制 ${text}`, `Copy ${text}`)}>
      {text}{copied ? <Check /> : <CopyIcon />}
    </Button>
  );
}

/** Where a moved claim is written, as something to click: a claim id names its document. */
function Place({ atlas, id }: { atlas: Atlas; id: string }) {
  const { t } = useLang();
  const [kind, owner, step] = id.split("/");
  const row = "grid w-full rounded-[4px] px-2 py-1 text-left transition-colors duration-150 ease-out hover:bg-muted";
  const name = "truncate text-ui";
  const hint = "truncate text-caption text-muted-foreground";
  const j = kind === "flow" ? atlas.journeys.find((x) => x.id === owner) : undefined;
  const s = j?.steps.find((x) => x.id === step);
  if (j && s) return <Link to="/journeys/$journeyId" params={{ journeyId: j.id }} search={{ step: s.id }} className={row}><span className={name}>{t(s.titleZh, s.title)}</span><span className={hint}>{t(j.titleZh, j.title)}</span></Link>;
  const node = kind === "module" ? atlas.nodes[owner ?? ""] : undefined;
  return <Link to="/modules" search={node ? { node: node.id } : {}} className={row}><span className={name}>{node ? node.title : kind === "term" ? t("术语表", "Glossary") : t("系统总览", "System overview")}</span>{node && <span className={hint}>{t("模块", "Module")}</span>}</Link>;
}

/** A file is only the way in: what a reader must reread is the claims resting on it, so the row opens onto them. */
function MovedFile({ atlas, path, name, ids }: { atlas: Atlas; path: string; name: string; ids: string[] }) {
  const { t } = useLang();
  const onOpen = useOpenSource();
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button title={path} aria-expanded={open} onClick={() => setOpen(!open)} className="group/file flex w-full items-center gap-2 rounded-[4px] px-2 py-1 text-left transition-colors duration-150 ease-out hover:bg-muted">
        <ChevronRight size={13} aria-hidden className="shrink-0 text-muted-foreground transition-transform duration-150 group-aria-expanded/file:rotate-90" />
        <span className="min-w-0 flex-1 truncate font-mono text-caption">{name}</span>
        <span className="font-mono text-caption text-muted-foreground tabular-nums">{ids.length}</span>
      </button>
      {open && (
        <div className="mt-px mb-1.5 ml-[14px] grid gap-px border-l pl-1.5">
          {ids.map((id) => <Place key={id} atlas={atlas} id={id} />)}
          <button onClick={() => onOpen({ path, startLine: 1, endLine: 1 })} className="w-fit px-2 py-1 text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{t("看这个文件的代码", "Read this file")}</button>
        </div>
      )}
    </li>
  );
}

function Drift({ atlas }: { atlas: Atlas }) {
  const { t } = useLang();
  const { items, checked } = atlas.drift;
  const [all, setAll] = useState(false);
  const files = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const d of items) for (const p of d.paths) by.set(p, [...(by.get(p) ?? []), d.id]);
    return [...by].sort((a, b) => b[1].length - a[1].length);
  }, [items]);
  const shown = all ? files : files.slice(0, 7);
  // Two files can share a name, and a list of the same name twice says nothing: those show their folder too.
  const base = (p: string) => p.split("/").pop()!;
  const shortName = (p: string) => (files.filter(([f]) => base(f) === base(p)).length > 1 ? p.split("/").slice(-2).join("/") : base(p));
  return (
    <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
      <div>
        <div className="flex items-baseline gap-2">
          <span className="text-display font-semibold tabular-nums">{items.length}</span>
          <span className="font-mono text-caption text-muted-foreground tabular-nums">/ {checked}</span>
        </div>
        <p className="mt-1 text-ui text-muted-foreground">{items.length ? t("句说明依据的代码改了，需要重读", "sentences rest on code that has changed") : t("句说明都与代码一致", "sentences all match the code")}</p>
      </div>
      {shown.length > 0 && (
        <ul className="-mx-2 grid gap-px">
          {shown.map(([path, ids]) => <MovedFile key={path} atlas={atlas} path={path} name={shortName(path)} ids={ids} />)}
          {files.length > shown.length && <li><button onClick={() => setAll(true)} className="px-2 py-1 pl-[29px] font-mono text-caption text-muted-foreground hover:text-foreground">+{files.length - shown.length} {t("个文件", "files")}</button></li>}
        </ul>
      )}
      {items.length > 0 && <div className="grid gap-1.5"><span className="text-caption text-muted-foreground">{t("让本机代理逐句重读并修正", "Have a local agent reread and correct them")}</span><Copy text="stemap fix" /></div>}
    </aside>
  );
}

function Overview({ atlas, flows }: { atlas: Atlas; flows: ViewJourney[] }) {
  const { t } = useLang();
  // Only the failures: a second x/y here would sit beside the drift total with a different denominator.
  const { unverified } = atlas.stats;
  const line = [...facts(atlas, t).map(([k, v]) => `${v?.toLocaleString()} ${k}`), ...(unverified ? [t(`${unverified} 句找不到依据`, `${unverified} sentences without evidence`)] : []), t(`基于 ${atlas.commit.slice(0, 7)}`, `at ${atlas.commit.slice(0, 7)}`)];
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-start gap-x-10 gap-y-7 px-8 py-9 max-sm:px-4 max-sm:py-6">
        <header className="grid w-full gap-1.5">
          <h1 className="text-display font-semibold tracking-[-0.01em] break-words">{atlas.nodes[atlas.rootId]?.title}</h1>
          <p className="font-mono text-caption text-muted-foreground tabular-nums">{line.join("  ·  ")}</p>
        </header>
        <section aria-label={t("流程", "Flows")} className="grid min-w-0 flex-[999_1_520px] grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-3">
          {flows.map((j) => <Tile key={j.id} j={j} moved={movedIn(atlas, j.id)} />)}
        </section>
        {atlas.drift.checked > 0 && <Drift atlas={atlas} />}
      </div>
    </div>
  );
}

/** A repository without flows gets the way to start; one with flows gets what they are and what moved. */
function Home() {
  const { data: atlas } = useSuspenseQuery(atlasQuery);
  const flows = orderedJourneys(atlas);
  return <Workspace phoneMain="only" main={flows.length ? <Overview atlas={atlas} flows={flows} /> : <Start atlas={atlas} />} />;
}
