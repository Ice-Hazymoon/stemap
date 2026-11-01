import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { orders, shipments } from "../db/schema";
import { queueReceipt } from "../notify/receipts";

export async function fulfilOrder(id: string) {
  await db.update(orders).set({ status: "paid" }).where(eq(orders.id, id));
  await db.insert(shipments).values({ orderId: id, status: "waiting" });
  await queueReceipt(id);
}
