import { Hono } from "hono";
import { db } from "./db";
import { users } from "./schema";

const admin = new Hono();
admin.get("/stats", (c) => c.json({ n: 1 }));

export const app = new Hono()
  .get("/health", (c) => c.text("ok"))
  .post("/users", async (c) => {
    await db.insert(users).values({ name: "a" });
    return c.json({});
  });

app.route("/admin", admin);
app.route("/remote", remoteRoutes);

// A plain Map is not a router, with or without a function argument.
const cache = new Map<string, string>();
cache.get("/x");
