import Fastify from "fastify";
import { audit } from "./audit";

const fastify = Fastify();
const server = fastify;

server.get("/items/:id", async (request) => {
  audit(request);
  return { id: 1 };
});
server.put("/items/:id", { schema: {} }, async () => ({ ok: true }));
