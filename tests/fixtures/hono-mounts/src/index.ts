import { Hono } from "hono";
import { api } from "./routes";

const app = new Hono();
app.get("/health", (c) => c.text("ok"));
app.route("/api", api);

export default app;
