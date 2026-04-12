import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "./config/env.js";
import type { ConnectorManager } from "./services/connectorManager.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerWsBridge } from "./routes/wsBridge.js";
import type { DB } from "./store/db.js";

export async function buildServer(_env: Env, db: DB, manager: ConnectorManager) {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true, credentials: true });

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.join(currentDir, "..", "public");

  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/"
  });

  await registerApiRoutes(app, manager);
  registerWsBridge(app, db, manager);

  app.get("/", async (_request, reply) => {
    return reply.sendFile("index.html");
  });

  return app;
}
