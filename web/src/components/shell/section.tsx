import type { ReactNode } from "react";

export function Section({ title, mark, count, aside, children }: { title: string; mark?: ReactNode; count?: number; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <header className="mb-2 flex items-center gap-1.5">
        {mark}
        <h3 className="text-ui font-semibold">{title}</h3>
        {count !== undefined && <span className="font-mono text-caption text-muted-foreground tabular-nums">{count}</span>}
        {aside && <span className="ml-auto text-caption text-muted-foreground">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="py-5 text-ui text-muted-foreground">{children}</p>;
