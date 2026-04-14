import "dotenv/config";
import { loadEnv } from "./config/env.js";
import { openDb } from "./store/db.js";
import { buildServer } from "./server.js";
import { ConnectionRegistry } from "./services/connectionRegistry.js";
import os from "node:os";

const env = loadEnv();
const db = openDb(env);

const registry = new ConnectionRegistry(db, env);
await registry.initialize();

let bootstrapManager = registry.getPrimary();

const hasBootstrapSeed = Boolean(
  env.OPENCLAW_BASE_URL || (env.PAIRING_TOKEN && env.CLOUD_BASE_URL)
);

if (!bootstrapManager && hasBootstrapSeed) {
  const id = await registry.create("Connection 1");
  bootstrapManager = registry.get(id);
}

if (bootstrapManager) {
  await bootstrapManager.discoverOpenClawWithDockerFallback();
}

// Auto-pair on startup only when a real connection already exists or was created from env.
if (bootstrapManager && env.PAIRING_TOKEN && env.CLOUD_BASE_URL) {
  const status = bootstrapManager.status();
  if (status.pairing.status !== "paired") {
    console.log(`Auto-pairing with ${env.CLOUD_BASE_URL} ...`);
    try {
      const result = await bootstrapManager.pair(env.CLOUD_BASE_URL, env.PAIRING_TOKEN);
      console.log(`Auto-pair ${result.status === "paired" ? "SUCCESS" : "FAILED"}: ${result.status}`);
      if (result.lastError) console.log(`Auto-pair error: ${result.lastError}`);
    } catch (e: any) {
      console.error(`Auto-pair failed: ${e.message || e}`);
    }
  } else {
    console.log(`Already paired (${status.pairing.connectorId}), skipping auto-pair.`);
  }
}

const app = await buildServer(env, db, registry);

const shutdown = async () => {
  registry.stopAll();
  await app.close();
  db.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: env.HOST, port: env.PORT });

const urls = new Set<string>([`http://127.0.0.1:${env.PORT}`]);
if (env.HOST && env.HOST !== "0.0.0.0" && env.HOST !== "::") {
  urls.add(`http://${env.HOST}:${env.PORT}`);
} else {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.add(`http://${entry.address}:${env.PORT}`);
      }
    }
  }
}

console.log("Hivee Connector successfully running.");
for (const url of urls) {
  console.log(`Open this link -> ${url}`);
}
