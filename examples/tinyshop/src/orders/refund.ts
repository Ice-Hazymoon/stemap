import { eq } from "drizzle-orm";
import { releaseStock } from "../catalog/stock";
import { db } from "../db/client";
import { orderLines, orders, payments } from "../db/schema";
import { refundPayment } from "../payments/provider";

const DAY = 24 * 60 * 60 * 1000;

export async function refundOrder(id: string) {
  const order = await db.select().from(orders).where(eq(orders.id, id)).get();
  if (order?.status !== "paid") return { status: "not_paid" } as const;
  if (Date.now() - order.createdAt.getTime() > 14 * DAY) return { status: "too_late" } as const;
  const payment = await db.select().from(payments).where(eq(payments.orderId, id)).get();
  const refunded = await refundPayment(payment!.providerRef, order.totalCents);
  if (!refunded) return { status: "provider_failed" } as const;
  await releaseStock(await db.select().from(orderLines).where(eq(orderLines.orderId, id)));
  await db.update(orders).set({ status: "refunded" }).where(eq(orders.id, id));
  return { status: "refunded" } as const;
}
