import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export const db = drizzle(new Database("tinyshop.db"), { schema });
