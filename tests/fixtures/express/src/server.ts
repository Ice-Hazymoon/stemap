import express from "express";
import { listOrders } from "./orders";

const app = express();
const router = express.Router();

router.get("/", listOrders);
router.delete("/:id", (req, res) => res.sendStatus(204));
app.use("/orders", router);
app.get("/ping", (_req, res) => res.send("pong"));
app.listen(3000);
