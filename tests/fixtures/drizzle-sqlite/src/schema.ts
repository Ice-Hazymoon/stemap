import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", { id: integer("id").primaryKey(), name: text("name") });
export const entries = sqliteTable("entries", {
  id: integer("id").primaryKey(),
  accountId: integer("account_id").references(() => accounts.id),
});
