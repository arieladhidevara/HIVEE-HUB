import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/config/env.js";
import { ConnectionRegistry } from "../src/services/connectionRegistry.js";
import { runMigrations } from "../src/store/migrations.js";
import { listConnections, loadPairingState, savePairingState } from "../src/store/repository.js";

const env: Env = {
  NODE_ENV: "test",
  PORT: 43137,
  HOST: "127.0.0.1",
  LOG_LEVEL: "silent",
  DATA_DIR: "./data-test",
  CONNECTOR_NAME: "Hivee Connector",
  CONNECTOR_BIND_PUBLIC: false,
  CLOUD_BASE_URL: "https://hivee.cloud",
  CLOUD_WS_URL: "",
  PAIRING_TOKEN: "",
  CONNECTOR_HEARTBEAT_INTERVAL_SEC: 15,
  CONNECTOR_COMMAND_POLL_INTERVAL_SEC: 5,
  CONNECTOR_DISCOVERY_INTERVAL_SEC: 15,
  OPENCLAW_BASE_URL: "",
  OPENCLAW_TOKEN: "",
  OPENCLAW_TRANSPORT: "auto",
  OPENCLAW_WS_PATH: "",
  OPENCLAW_REQUEST_TIMEOUT_MS: 0,
  OPENCLAW_DISCOVERY_CANDIDATES: "http://127.0.0.1:18789",
  ENABLE_DOCKER_DISCOVERY: false,
  DOCKER_SOCKET_PATH: "/var/run/docker.sock"
};

const openDbs: Database.Database[] = [];
const registries: ConnectionRegistry[] = [];

function createDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const registry of registries.splice(0)) {
    registry.stopAll();
  }
  for (const db of openDbs.splice(0)) {
    db.close();
  }
});

describe("ConnectionRegistry", () => {
  it("drops the legacy blank default connection on fresh startup", async () => {
    const db = createDb();
    const registry = new ConnectionRegistry(db, env);
    registries.push(registry);

    await registry.initialize();

    expect(listConnections(db)).toEqual([]);
  });

  it("renames a legacy default connection into a normal saved connection", async () => {
    const db = createDb();
    const registry = new ConnectionRegistry(db, env);
    registries.push(registry);

    savePairingState(db, "default", {
      connectorId: "conn-live",
      connectorSecret: "secret",
      cloudBaseUrl: "https://hivee.cloud",
      pairingToken: "pair_live_123",
      status: "paired",
      lastError: null,
      heartbeatIntervalSec: 15,
      commandPollIntervalSec: 5,
      updatedAt: Date.now()
    });

    await registry.initialize();

    const connections = listConnections(db);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.id).not.toBe("default");
    expect(connections[0]?.name).toBe("Connection 1");

    const state = loadPairingState(db, connections[0]!.id);
    expect(state.connectorId).toBe("conn-live");
    expect(state.pairingToken).toBe("pair_live_123");
    expect(loadPairingState(db, "default").connectorId).toBeNull();
  });
});
