import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHashHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

// A compiled page does not change while it is open, so nothing here goes stale.
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: 1, refetchOnWindowFocus: false } } });
// A page on file:// has one path, so routes live in the hash.
const router = createRouter({ routeTree, history: createHashHistory(), context: { queryClient }, defaultPreload: "intent", scrollRestoration: false });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
