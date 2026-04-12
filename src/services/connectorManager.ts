import type { DB } from "../store/db.js";
import { appendEvent, loadCursor, loadOpenClawConfig, loadOpenClawSnapshot, loadPairingState, recentEvents, saveCursor, saveOpenClawConfig, saveOpenClawSnapshot, savePairingState, upsertCommandHistory } from "../store/repository.js";
import type { CloudCommand, CommandResult, ConnectorStatusPayload, OpenClawConfig, OpenClawDockerDiscovery, OpenClawSnapshot, PairingState } from "../types/domain.js";
import type { Env } from "../config/env.js";
import { CloudApi } from "./cloudApi.js";
import { OpenClawClient } from "./openclawClient.js";
import { tryDockerDiscovery } from "./dockerDiscovery.js";
import { ensureTrailingSlashless, errorToText, redactToken } from "../utils/text.js";
import { persistRuntimeEnvValues } from "../store/runtimeEnv.js";
import os from "node:os";

interface DockerDiscoverOptions {
  tokenOverride?: string;
  autoApply?: boolean;
}

export class ConnectorManager {
  constructor(
    private readonly db: DB,
    private readonly env: Env,
    private readonly cloudApi: CloudApi,
    private readonly openclaw: OpenClawClient
  ) {
    const restored = loadOpenClawConfig(this.db, this.defaultOpenClawConfig());
    this.openclaw.setConfig(restored);
    saveOpenClawConfig(this.db, this.openclaw.getConfig());
  }

  status(): ConnectorStatusPayload {
    return {
      connectorName: this.env.CONNECTOR_NAME,
      version: "0.1.0",
      host: {
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch
      },
      pairing: loadPairingState(this.db),
      openclawConfig: this.openclaw.getConfig(),
      openclaw: loadOpenClawSnapshot(this.db),
      recentEvents: recentEvents(this.db, 50)
    };
  }

  getOpenClawConfig(): OpenClawConfig {
    return this.openclaw.getConfig();
  }

  updateOpenClawConfig(input: Partial<OpenClawConfig>): OpenClawConfig {
    const current = this.openclaw.getConfig();
    const next: OpenClawConfig = {
      ...current,
      ...input,
      baseUrl:
        input.baseUrl !== undefined
          ? ensureTrailingSlashless(String(input.baseUrl || "").trim())
          : current.baseUrl,
      token: input.token !== undefined ? String(input.token || "").trim() : current.token,
      discoveryCandidates:
        input.discoveryCandidates !== undefined
          ? String(input.discoveryCandidates || "").trim()
          : current.discoveryCandidates,
      wsPath: input.wsPath !== undefined ? String(input.wsPath || "").trim() : current.wsPath,
      requestTimeoutMs:
        input.requestTimeoutMs !== undefined
          ? Math.max(1000, Math.round(Number(input.requestTimeoutMs)))
          : current.requestTimeoutMs
    };

    this.openclaw.setConfig(next);
    const saved = this.openclaw.getConfig();
    saveOpenClawConfig(this.db, saved);
    persistRuntimeEnvValues(this.env.DATA_DIR, {
      OPENCLAW_BASE_URL: saved.baseUrl,
      OPENCLAW_TOKEN: saved.token
    });
    appendEvent(this.db, "info", "openclaw.config.updated", "OpenClaw config updated from admin UI", {
      baseUrl: saved.baseUrl,
      transport: saved.transport,
      wsPath: saved.wsPath,
      requestTimeoutMs: saved.requestTimeoutMs,
      discoveryCandidates: saved.discoveryCandidates,
      token: redactToken(saved.token)
    });
    return saved;
  }

  resetOpenClawConfig(): OpenClawConfig {
    const defaults = this.defaultOpenClawConfig();
    this.openclaw.setConfig(defaults);
    const saved = this.openclaw.getConfig();
    saveOpenClawConfig(this.db, saved);
    persistRuntimeEnvValues(this.env.DATA_DIR, {
      OPENCLAW_BASE_URL: saved.baseUrl,
      OPENCLAW_TOKEN: saved.token
    });
    appendEvent(this.db, "info", "openclaw.config.reset", "OpenClaw config reset to env defaults", {
      baseUrl: saved.baseUrl,
      transport: saved.transport,
      wsPath: saved.wsPath,
      requestTimeoutMs: saved.requestTimeoutMs,
      discoveryCandidates: saved.discoveryCandidates,
      token: redactToken(saved.token)
    });
    return saved;
  }

  async discoverOpenClaw(): Promise<OpenClawSnapshot> {
    const snapshot = await this.openclaw.discover();
    saveOpenClawSnapshot(this.db, snapshot);
    appendEvent(
      this.db,
      snapshot.healthy ? "info" : "warn",
      "openclaw.discover",
      snapshot.healthy ? `OpenClaw healthy at ${snapshot.baseUrl}` : "OpenClaw discovery failed",
      {
        baseUrl: snapshot.baseUrl,
        agents: snapshot.agents.map((a) => a.id),
        models: snapshot.models,
        error: snapshot.lastError
      }
    );
    return snapshot;
  }

  async discoverOpenClawWithDockerFallback(): Promise<OpenClawSnapshot> {
    const initial = await this.discoverOpenClaw();
    if (initial.healthy) return initial;

    await this.dockerDiscoverOpenClaw({ autoApply: true });
    return loadOpenClawSnapshot(this.db);
  }

  async dockerDiscoverOpenClaw(options: DockerDiscoverOptions = {}): Promise<OpenClawDockerDiscovery> {
    const currentConfig = this.openclaw.getConfig();
    const overrideToken =
      options.tokenOverride !== undefined ? String(options.tokenOverride || "").trim() : undefined;
    const scanConfig: OpenClawConfig =
      overrideToken !== undefined
        ? {
            ...currentConfig,
            token: overrideToken
          }
        : currentConfig;

    const scan = await tryDockerDiscovery(this.env, scanConfig);

    appendEvent(
      this.db,
      scan.healthyCandidates.length > 0 ? "info" : "warn",
      "openclaw.docker_discover",
      scan.healthyCandidates.length > 0
        ? `Docker discovery found ${scan.healthyCandidates.length} healthy candidate(s)`
        : "Docker discovery found no healthy candidates",
      {
        enabled: scan.enabled,
        socketPath: scan.socketPath,
        recommendedBaseUrl: scan.recommendedBaseUrl,
        healthyCandidates: scan.healthyCandidates.map((item) => item.baseUrl),
        notes: scan.notes
      }
    );

    const autoApply = options.autoApply !== false;
    if (autoApply && scan.recommendedBaseUrl) {
      const nextDiscoveryCandidates = mergeDiscoveryCandidates(
        scan.recommendedDiscoveryCandidates,
        currentConfig.discoveryCandidates
      );
      const nextToken = overrideToken !== undefined ? overrideToken : currentConfig.token;

      this.updateOpenClawConfig({
        baseUrl: scan.recommendedBaseUrl,
        token: nextToken,
        discoveryCandidates: nextDiscoveryCandidates
      });

      const snapshot = await this.discoverOpenClaw();
      appendEvent(
        this.db,
        snapshot.healthy ? "info" : "warn",
        "openclaw.docker_apply",
        snapshot.healthy
          ? `Applied Docker candidate ${scan.recommendedBaseUrl}`
          : `Applied Docker candidate ${scan.recommendedBaseUrl}, but OpenClaw is still unhealthy`,
        {
          baseUrl: scan.recommendedBaseUrl,
          healthy: snapshot.healthy,
          error: snapshot.lastError
        }
      );
    }

    return scan;
  }

  async pair(cloudBaseUrl: string, pairingToken: string): Promise<PairingState> {
    const normalizedCloudBaseUrl = ensureTrailingSlashless(
      String(this.env.CLOUD_BASE_URL || cloudBaseUrl || "https://hivee.cloud").trim()
    );
    const normalizedPairingToken = String(pairingToken || "").trim();
    const snapshot = await this.discoverOpenClawWithDockerFallback();
    savePairingState(this.db, {
      ...loadPairingState(this.db),
      cloudBaseUrl: normalizedCloudBaseUrl,
      pairingToken: normalizedPairingToken,
      status: "pairing",
      lastError: null,
      updatedAt: Date.now(),
      connectorId: null,
      connectorSecret: null
    });
    persistRuntimeEnvValues(this.env.DATA_DIR, { PAIRING_TOKEN: normalizedPairingToken });

    try {
      const result = await this.cloudApi.register(normalizedPairingToken, normalizedCloudBaseUrl, snapshot);
      const state: PairingState = {
        connectorId: result.connectorId,
        connectorSecret: result.connectorSecret,
        cloudBaseUrl: normalizedCloudBaseUrl,
        pairingToken: normalizedPairingToken,
        status: "paired",
        lastError: null,
        heartbeatIntervalSec: result.heartbeatIntervalSec ?? this.env.CONNECTOR_HEARTBEAT_INTERVAL_SEC,
        commandPollIntervalSec: result.commandPollIntervalSec ?? this.env.CONNECTOR_COMMAND_POLL_INTERVAL_SEC,
        updatedAt: Date.now()
      };
      savePairingState(this.db, state);
      appendEvent(this.db, "info", "pairing.success", `Paired connector ${result.connectorId}`, { cloudBaseUrl: normalizedCloudBaseUrl });
      return state;
    } catch (error) {
      const state: PairingState = {
        ...loadPairingState(this.db),
        status: "error",
        lastError: errorToText(error),
        updatedAt: Date.now()
      };
      savePairingState(this.db, state);
      appendEvent(this.db, "error", "pairing.error", state.lastError || "Pairing failed", { cloudBaseUrl: normalizedCloudBaseUrl });
      throw error;
    }
  }

  clearPairing(): PairingState {
    const state: PairingState = {
      connectorId: null,
      connectorSecret: null,
      cloudBaseUrl: null,
      pairingToken: null,
      status: "unpaired",
      lastError: null,
      heartbeatIntervalSec: this.env.CONNECTOR_HEARTBEAT_INTERVAL_SEC,
      commandPollIntervalSec: this.env.CONNECTOR_COMMAND_POLL_INTERVAL_SEC,
      updatedAt: Date.now()
    };
    savePairingState(this.db, state);
    persistRuntimeEnvValues(this.env.DATA_DIR, {
      PAIRING_TOKEN: ""
    });
    saveCursor(this.db, null);
    appendEvent(this.db, "info", "pairing.clear", "Pairing cleared");
    return state;
  }

  async heartbeat(): Promise<void> {
    const state = loadPairingState(this.db);
    const openclaw = loadOpenClawSnapshot(this.db);
    if (state.status !== "paired") return;
    await this.cloudApi.heartbeat(state, openclaw);
    appendEvent(this.db, "info", "heartbeat.ok", "Heartbeat sent", {
      connectorId: state.connectorId,
      cloudBaseUrl: state.cloudBaseUrl
    });
  }

  async pollAndExecute(): Promise<void> {
    const state = loadPairingState(this.db);
    if (state.status !== "paired") return;

    const cursor = loadCursor(this.db);
    const response = await this.cloudApi.pollCommands(state, cursor);
    if (response.cursor !== cursor) {
      saveCursor(this.db, response.cursor ?? null);
    }

    for (const command of response.commands) {
      await this.executeCloudCommand(command);
    }
  }

  async executeCloudCommand(command: CloudCommand): Promise<CommandResult> {
    const state = loadPairingState(this.db);
    const snapshot = loadOpenClawSnapshot(this.db);
    const startedAt = Date.now();

    upsertCommandHistory(this.db, {
      cloudCommandId: command.id,
      type: command.type,
      status: "running",
      requestJson: command.payload
    });

    try {
      let output: Record<string, unknown> = {};

      switch (command.type) {
        case "connector.ping":
          output = { pong: true, observedAt: Date.now() };
          break;
        case "openclaw.discover": {
          const fresh = await this.discoverOpenClaw();
          output = { snapshot: fresh };
          break;
        }
        case "openclaw.list_agents":
          output = { agents: snapshot.agents, models: snapshot.models };
          break;
        case "openclaw.chat": {
          const message = String(command.payload.message || "").trim();
          const agentId = command.payload.agentId ? String(command.payload.agentId) : undefined;
          const sessionKey = command.payload.sessionKey ? String(command.payload.sessionKey) : undefined;
          const chat = await this.openclaw.chat({ message, agentId, sessionKey }, snapshot);
          if (!chat.ok) throw new Error(chat.error || "OpenClaw chat failed");
          output = chat as unknown as Record<string, unknown>;
          break;
        }
        case "openclaw.proxy_http": {
          const method = String(command.payload.method || "GET").toUpperCase();
          const path = String(command.payload.path || "");
          output = await this.openclaw.proxyHttp(snapshot, method, path, command.payload.body);
          break;
        }
        default:
          throw new Error(`Unsupported command type: ${command.type}`);
      }

      const result: CommandResult = {
        ok: true,
        commandId: command.id,
        type: command.type,
        output,
        startedAt,
        finishedAt: Date.now()
      };

      upsertCommandHistory(this.db, {
        cloudCommandId: command.id,
        type: command.type,
        status: "done",
        requestJson: command.payload,
        responseJson: result
      });

      await this.cloudApi.postCommandResult(state, command.id, result);
      appendEvent(this.db, "info", "command.done", `Executed ${command.type}`, { commandId: command.id });
      return result;
    } catch (error) {
      const result: CommandResult = {
        ok: false,
        commandId: command.id,
        type: command.type,
        error: errorToText(error),
        startedAt,
        finishedAt: Date.now()
      };
      upsertCommandHistory(this.db, {
        cloudCommandId: command.id,
        type: command.type,
        status: "error",
        requestJson: command.payload,
        responseJson: result,
        errorText: result.error
      });
      await this.cloudApi.postCommandResult(state, command.id, result);
      appendEvent(this.db, "error", "command.error", `Failed ${command.type}`, {
        commandId: command.id,
        error: result.error
      });
      return result;
    }
  }

  private defaultOpenClawConfig(): OpenClawConfig {
    return {
      baseUrl: ensureTrailingSlashless(this.env.OPENCLAW_BASE_URL || ""),
      token: this.env.OPENCLAW_TOKEN || "",
      transport: this.env.OPENCLAW_TRANSPORT,
      wsPath: this.env.OPENCLAW_WS_PATH || "",
      requestTimeoutMs: this.env.OPENCLAW_REQUEST_TIMEOUT_MS,
      discoveryCandidates: this.env.OPENCLAW_DISCOVERY_CANDIDATES || ""
    };
  }
}

function mergeDiscoveryCandidates(recommended: string[], existingCsv: string): string {
  const existing = String(existingCsv || "")
    .split(",")
    .map((item) => ensureTrailingSlashless(String(item || "").trim()))
    .filter(Boolean);

  const merged = new Set<string>();
  for (const item of recommended) {
    const normalized = ensureTrailingSlashless(String(item || "").trim());
    if (normalized) merged.add(normalized);
  }
  for (const item of existing) {
    if (item) merged.add(item);
  }

  return Array.from(merged).join(",");
}
