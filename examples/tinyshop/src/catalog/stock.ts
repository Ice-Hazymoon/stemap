import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/client";
import { products } from "../db/schema";

export interface CartLine { productId: string; quantity: number }
export interface PricedLine extends CartLine { priceCents: number }
export type Reservation = { ok: true; lines: PricedLine[] } | { ok: false; productId: string };

/** Takes stock line by line, so a short product gives back what the earlier lines took. */
export async function reserveStock(lines: CartLine[]): Promise<Reservation> {
  const reserved: PricedLine[] = [];
  for (const line of lines) {
    const [product] = await db.update(products)
      .set({ stock: sql`${products.stock} - ${line.quantity}` })
      .where(and(eq(products.id, line.productId), gte(products.stock, line.quantity)))
      .returning();
    if (!product) {
      await releaseStock(reserved);
      return { ok: false, productId: line.productId };
    }
    reserved.push({ ...line, priceCents: product.priceCents });
  }
  return { ok: true, lines: reserved };
}

export async function releaseStock(lines: CartLine[]) {
  for (const line of lines) {
    await db.update(products)
      .set({ stock: sql`${products.stock} + ${line.quantity}` })
      .where(eq(products.id, line.productId));
  }
}
