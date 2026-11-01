import { Hono } from "hono";

const app = new Hono();
app.get("/:id", (c) => c.json({ id: c.req.param("id") }));
app.post("/", (c) => c.json({}));

export default app;
