import { Hono } from "hono";
import { refundOrder } from "../orders/refund";

export const orders = new Hono().post("/:id/refund", async (c) => {
  const result = await refundOrder(c.req.param("id"));
  if (result.status === "refunded") return c.json({ ok: true });
  return c.json({ error: result.status }, result.status === "provider_failed" ? 502 : 409);
});
