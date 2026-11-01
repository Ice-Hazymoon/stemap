import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const Ctx = createContext<{ trail: string[]; visit: (journey: string, step: string) => void }>({ trail: [], visit: () => undefined });

/** The steps walked in this journey. The sidebar and the diagram both read it. */
export function TrailProvider({ children }: { children: ReactNode }) {
  const [state, set] = useState<{ journey: string; steps: string[] }>({ journey: "", steps: [] });
  const value = useMemo(() => ({
    trail: state.steps,
    visit: (journey: string, step: string) => set((s) => {
      if (s.journey !== journey) return { journey, steps: [step] };
      return s.steps.includes(step) ? s : { journey, steps: [...s.steps, step] };
    }),
  }), [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTrail = () => useContext(Ctx).trail;

export function useVisit(journey: string, step: string) {
  const { visit } = useContext(Ctx);
  // `visit` changes with the trail, so depending on it would re-run this for every step walked.
  useEffect(() => { visit(journey, step); }, [journey, step]); // eslint-disable-line react-hooks/exhaustive-deps
}
