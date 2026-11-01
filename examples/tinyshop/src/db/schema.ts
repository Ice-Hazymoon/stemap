import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  stock: integer("stock").notNull(),
});

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  status: text("status").$type<"pending" | "paid" | "review" | "cancelled" | "refunded">().notNull(),
  totalCents: integer("total_cents").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const orderLines = sqliteTable("order_lines", {
  orderId: text("order_id").notNull().references(() => orders.id),
  productId: text("product_id").notNull().references(() => products.id),
  quantity: integer("quantity").notNull(),
  priceCents: integer("price_cents").notNull(),
});

export const payments = sqliteTable("payments", {
  eventId: text("event_id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id),
  providerRef: text("provider_ref").notNull(),
  amountCents: integer("amount_cents").notNull(),
});

export const shipments = sqliteTable("shipments", {
  orderId: text("order_id").primaryKey().references(() => orders.id),
  status: text("status").$type<"waiting" | "sent">().notNull(),
});
