import { Hono } from "hono";
import { fulfilOrder } from "../orders/fulfil";
import { holdForReview } from "../orders/orders";
import { recordPayment, type PaymentEvent } from "../payments/confirm";
import { verifySignature } from "../payments/provider";

export const webhooks = new Hono().post("/payment", async (c) => {
  const body = await c.req.text();
  if (!verifySignature(body, c.req.header("x-signature"))) return c.json({ error: "bad_signature" }, 401);
  const result = await recordPayment(JSON.parse(body) as PaymentEvent);
  if (result.status === "duplicate") return c.json({ ok: true });
  if (result.status === "mismatch") {
    await holdForReview(result.orderId);
    return c.json({ ok: true });
  }
  await fulfilOrder(result.orderId);
  return c.json({ ok: true });
});
