import { Hono } from "hono";
import { releaseStock, reserveStock, type CartLine } from "../catalog/stock";
import { cancelOrder, createOrder } from "../orders/orders";
import { startPayment } from "../payments/provider";

export const checkout = new Hono().post("/", async (c) => {
  const { email, lines } = await c.req.json<{ email: string; lines: CartLine[] }>();
  if (lines.length === 0) return c.json({ error: "cart_empty" }, 400);
  const reservation = await reserveStock(lines);
  if (!reservation.ok) return c.json({ error: "out_of_stock", productId: reservation.productId }, 409);
  const order = await createOrder(email, reservation.lines);
  const session = await startPayment(order);
  if (!session.ok) {
    await cancelOrder(order.id);
    await releaseStock(reservation.lines);
    return c.json({ error: "payment_unavailable" }, 502);
  }
  return c.json({ orderId: order.id, payUrl: session.url }, 201);
});
