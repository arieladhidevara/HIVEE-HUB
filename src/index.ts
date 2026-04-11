import { loadEnv } from "./config/env.js";
import { openDb } from "./store/db.js";
import { CloudApi } from "./services/cloudApi.js";
import { OpenClawClient } from "./services/openclawClient.js";
import { ConnectorManager } from "./services/connectorManager.js";
import { buildServer } from "./server.js";
import { RuntimeLoops } from "./services/runtime.js";

const env = loadEnv();
const db = openDb(env);
const cloudApi = new CloudApi(env);
const openclaw = new OpenClawClient(env);
const manager = new ConnectorManager(db, env, cloudApi, openclaw);

await manager.discoverOpenClaw();

const app = await buildServer(env, db, manager);
const loops = new RuntimeLoops(env, manager);
loops.start();

const shutdown = async () => {
  loops.stop();
  await app.close();
  db.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: env.HOST, port: env.PORT });
console.log(`Hivee Connector UI: http://127.0.0.1:${env.PORT}`);
if (env.HOST === "0.0.0.0" || env.HOST === "::") {
  console.log(`If this is a VPS, open: http://<server-ip>:${env.PORT}`);
}
