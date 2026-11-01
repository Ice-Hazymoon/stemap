import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { PricedLine } from "../catalog/stock";
import { db } from "../db/client";
import { orderLines, orders } from "../db/schema";

export async function createOrder(email: string, lines: PricedLine[]) {
  const totalCents = lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0);
  const [order] = await db.insert(orders)
    .values({ id: randomUUID(), email, status: "pending", totalCents, createdAt: new Date() })
    .returning();
  await db.insert(orderLines).values(lines.map((l) => ({ ...l, orderId: order!.id })));
  return order!;
}

export async function cancelOrder(id: string) {
  await db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, id));
}

/** A payment that does not match its order waits for a person. */
export async function holdForReview(id: string) {
  await db.update(orders).set({ status: "review" }).where(eq(orders.id, id));
}
