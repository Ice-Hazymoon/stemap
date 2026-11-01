import { createHmac, timingSafeEqual } from "node:crypto";

const API = "https://payments.example.com";
const SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "";

export async function startPayment(order: { id: string; totalCents: number }) {
  const res = await fetch(`${API}/sessions`, { method: "POST", body: JSON.stringify({ reference: order.id, amount: order.totalCents }) });
  if (!res.ok) return { ok: false } as const;
  const { url } = await res.json() as { url: string };
  return { ok: true, url } as const;
}

export async function refundPayment(providerRef: string, amountCents: number) {
  const res = await fetch(`${API}/payments/${providerRef}/refund`, { method: "POST", body: JSON.stringify({ amount: amountCents }) });
  return res.ok;
}

export function verifySignature(body: string, signature: string | undefined) {
  if (!signature) return false;
  const expected = createHmac("sha256", SECRET).update(body).digest("hex");
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
