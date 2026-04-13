import { randomBytes } from "node:crypto";
import type { DB } from "../store/db.js";
import type { Env } from "../config/env.js";
import { CloudApi } from "./cloudApi.js";
import { OpenClawClient } from "./openclawClient.js";
import { ConnectorManager } from "./connectorManager.js";
import { RuntimeLoops } from "./runtime.js";
import { createConnection, deleteConnectionData, listConnections } from "../store/repository.js";
import type { ConnectionWithStatus } from "../types/domain.js";

interface RegistryEntry {
  manager: ConnectorManager;
  loops: RuntimeLoops;
}

export class ConnectionRegistry {
  private entries = new Map<string, RegistryEntry>();

  constructor(
    private readonly db: DB,
    private readonly env: Env
  ) {}

  async initialize(): Promise<void> {
    const connections = listConnections(this.db);

    // Ensure 'default' exists in DB
    if (!connections.find((c) => c.id === "default")) {
      createConnection(this.db, "default", "Default");
      connections.unshift({ id: "default", name: "Default", createdAt: Date.now() });
    }

    for (const conn of connections) {
      await this.startEntry(conn.id);
    }
  }

  private async startEntry(connectionId: string): Promise<ConnectorManager> {
    // Stop existing entry if any
    const existing = this.entries.get(connectionId);
    if (existing) {
      existing.loops.stop();
    }

    const cloudApi = new CloudApi(this.env);
    const openclaw = new OpenClawClient(this.env);
    const manager = new ConnectorManager(connectionId, this.db, this.env, cloudApi, openclaw);
    const loops = new RuntimeLoops(this.env, manager);
    loops.start();
    this.entries.set(connectionId, { manager, loops });
    return manager;
  }

  async create(name: string): Promise<string> {
    const id = `conn_${randomBytes(4).toString("hex")}`;
    createConnection(this.db, id, name);
    await this.startEntry(id);
    return id;
  }

  async delete(connectionId: string): Promise<void> {
    if (connectionId === "default") return; // never delete the default
    const entry = this.entries.get(connectionId);
    if (entry) {
      entry.loops.stop();
      this.entries.delete(connectionId);
    }
    deleteConnectionData(this.db, connectionId);
  }

  get(connectionId: string): ConnectorManager | null {
    return this.entries.get(connectionId)?.manager ?? null;
  }

  getDefault(): ConnectorManager {
    const entry = this.entries.get("default");
    if (!entry) throw new Error("Default connection not initialised");
    return entry.manager;
  }

  list(): ConnectionWithStatus[] {
    const connections = listConnections(this.db);
    return connections.map((conn) => {
      const entry = this.entries.get(conn.id);
      if (!entry) {
        return {
          ...conn,
          pairing: {
            connectorId: null,
            connectorSecret: null,
            cloudBaseUrl: null,
            pairingToken: null,
            status: "unpaired" as const,
            lastError: null,
            heartbeatIntervalSec: 15,
            commandPollIntervalSec: 5,
            updatedAt: null
          },
          openclaw: {
            baseUrl: null,
            tokenPresent: false,
            transport: "auto" as const,
            healthy: false,
            agents: [],
            models: [],
            lastError: null,
            wsCandidates: [],
            updatedAt: null
          }
        };
      }
      const status = entry.manager.status();
      return {
        ...conn,
        pairing: status.pairing,
        openclaw: status.openclaw
      };
    });
  }

  stopAll(): void {
    for (const { loops } of this.entries.values()) {
      loops.stop();
    }
  }
}
