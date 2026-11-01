import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { LinkItem } from "@/lib/api";

export interface SourceRef { path: string; startLine: number; endLine: number }

/** Each entity kind has one home: journeys open the diagram, everything else opens the inspector. */
export function useOpenItem() {
  const navigate = useNavigate();
  return useCallback((x: Pick<LinkItem, "id" | "kind">) => {
    if (x.kind === "step") {
      const [journeyId, step] = x.id.slice(5).split("/");
      void navigate({ to: "/journeys/$journeyId", params: { journeyId: journeyId! }, search: { step } });
    } else if (x.kind === "journey") {
      void navigate({ to: "/journeys/$journeyId", params: { journeyId: x.id.slice(8) } });
    } else {
      void navigate({ to: ".", search: (p) => ({ ...p, i: x.id }) });
    }
  }, [navigate]);
}

export function useOpenSource() {
  const navigate = useNavigate();
  return useCallback((r: SourceRef) => {
    void navigate({ to: ".", search: (p) => ({ ...p, file: r.path, line: r.startLine, end: r.endLine }) });
  }, [navigate]);
}

export function useCloseSource() {
  const navigate = useNavigate();
  return useCallback(() => {
    void navigate({ to: ".", search: (p) => ({ ...p, file: undefined, line: undefined, end: undefined }) });
  }, [navigate]);
}
