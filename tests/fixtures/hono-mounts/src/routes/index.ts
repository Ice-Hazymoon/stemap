import { Hono } from "hono";
import items from "./items";

export const api = new Hono();
api.route("/v1/items", items);
