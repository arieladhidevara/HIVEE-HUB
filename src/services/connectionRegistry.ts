import { randomBytes } from "node:crypto";
import type { DB } from "../store/db.js";
import type { Env } from "../config/env.js";
import { CloudApi } from "./cloudApi.js";
import { OpenClawClient } from "./openclawClient.js";
import { ConnectorManager } from "./connectorManager.js";
import { RuntimeLoops } from "./runtime.js";
import {
  connectionHasData,
  createConnection,
  deleteConnectionData,
  getConnection,
  listConnections,
  renameConnectionData
} from "../store/repository.js";
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
    this.normalizeLegacyDefaultConnection();
    const connections = listConnections(this.db);

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
    const id = this.generateConnectionId();
    createConnection(this.db, id, name);
    await this.startEntry(id);
    return id;
  }

  async delete(connectionId: string): Promise<void> {
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

  getPrimary(): ConnectorManager | null {
    const first = listConnections(this.db)[0];
    if (!first) return null;
    return this.entries.get(first.id)?.manager ?? null;
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

  private normalizeLegacyDefaultConnection(): void {
    const legacy = getConnection(this.db, "default");
    if (!legacy) return;

    if (!connectionHasData(this.db, legacy.id)) {
      deleteConnectionData(this.db, legacy.id);
      return;
    }

    const nextId = this.generateConnectionId();
    const nextName = this.normalizeConnectionName(legacy.name, legacy.id);
    renameConnectionData(this.db, legacy.id, nextId, nextName);
  }

  private generateConnectionId(): string {
    let id = `conn_${randomBytes(4).toString("hex")}`;
    while (getConnection(this.db, id)) {
      id = `conn_${randomBytes(4).toString("hex")}`;
    }
    return id;
  }

  private normalizeConnectionName(currentName: string, currentId?: string): string {
    const trimmed = String(currentName || "").trim();
    if (trimmed && trimmed.toLowerCase() !== "default") {
      return trimmed;
    }

    const used = new Set(
      listConnections(this.db)
        .filter((conn) => conn.id !== currentId)
        .map((conn) => String(conn.name || "").trim())
        .filter(Boolean)
    );

    let index = 1;
    while (used.has(`Connection ${index}`)) {
      index += 1;
    }
    return `Connection ${index}`;
  }
}
