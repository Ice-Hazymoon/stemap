import { db } from "./db";
import { accounts as acc, entries } from "./schema";

export function addEntry() {
  return db.insert(entries).values({});
}

export function rename() {
  return db.update(acc).set({ name: "x" });
}

export function all() {
  return db.select().from(entries);
}

export function drop() {
  return db.delete(entries);
}
