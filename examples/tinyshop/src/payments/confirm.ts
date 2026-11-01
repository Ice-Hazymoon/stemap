import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { orders, payments } from "../db/schema";

export interface PaymentEvent { id: string; reference: string; paymentId: string; amount: number }

/** The event id is the primary key, so a provider that repeats itself records nothing twice. */
export async function recordPayment(event: PaymentEvent) {
  const [payment] = await db.insert(payments)
    .values({ eventId: event.id, orderId: event.reference, providerRef: event.paymentId, amountCents: event.amount })
    .onConflictDoNothing({ target: payments.eventId })
    .returning();
  if (!payment) return { status: "duplicate" } as const;
  const order = await db.select().from(orders).where(eq(orders.id, event.reference)).get();
  if (order?.totalCents !== event.amount) return { status: "mismatch", orderId: event.reference } as const;
  return { status: "paid", orderId: event.reference } as const;
}
