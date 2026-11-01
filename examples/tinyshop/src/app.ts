import { Hono } from "hono";
import { checkout } from "./routes/checkout";
import { orders } from "./routes/orders";
import { webhooks } from "./routes/webhooks";

export const app = new Hono();

app.route("/checkout", checkout);
app.route("/orders", orders);
app.route("/webhooks", webhooks);
