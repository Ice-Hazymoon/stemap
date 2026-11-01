import { Queue, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { orders } from "../db/schema";

export const receiptQueue = new Queue("receipts");

export async function queueReceipt(orderId: string) {
  await receiptQueue.add("send", { orderId }, { attempts: 5, backoff: { type: "exponential", delay: 60_000 } });
}

export async function sendReceipt(orderId: string) {
  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  const res = await fetch("https://mail.example.com/send", { method: "POST", body: JSON.stringify({ to: order!.email, template: "receipt", orderId }) });
  if (!res.ok) throw new Error(`mail refused: ${res.status}`);
}

new Worker("receipts", async (job) => {
  await sendReceipt(job.data.orderId);
});
