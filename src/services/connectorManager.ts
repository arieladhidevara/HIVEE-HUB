import type { DB } from "../store/db.js";
import {
  appendEvent,
  loadCursor,
  loadOpenClawConfig,
  loadOpenClawSnapshot,
  loadPairingState,
  recentEvents,
  saveCursor,
  saveOpenClawConfig,
  saveOpenClawSnapshot,
  savePairingState,
  upsertCommandHistory
} from "../store/repository.js";
import type {
  CloudCommand,
  CommandResult,
  ConnectorStatusPayload,
  OpenClawConfig,
  OpenClawDockerDiscovery,
  OpenClawSnapshot,
  PairingState
} from "../types/domain.js";
import type { Env } from "../config/env.js";
import { CloudApi } from "./cloudApi.js";
import { OpenClawClient } from "./openclawClient.js";
import { tryDockerDiscovery, tryJoinOpenClawNetworks } from "./dockerDiscovery.js";
import { ensureTrailingSlashless, errorToText, redactToken } from "../utils/text.js";
import { persistRuntimeEnvValues } from "../store/runtimeEnv.js";
import os from "node:os";

interface DockerDiscoverOptions {
  tokenOverride?: string;
  autoApply?: boolean;
}

const DOCKER_DISCOVERY_COOLDOWN_MS = 5 * 60 * 1000;

export class ConnectorManager {
  private lastDockerDiscovery: number = 0;

  constructor(
    private readonly connectionId: string,
    private readonly db: DB,
    private readonly env: Env,
    private readonly cloudApi: CloudApi,
    private readonly openclaw: OpenClawClient
  ) {
    const defaults = this.defaultOpenClawConfig();
    const restored = loadOpenClawConfig(this.db, this.connectionId, defaults);
    this.openclaw.setConfig({
      ...restored,
      // This repo now defaults to no request timeout for cloud/OpenClaw message flow.
      requestTimeoutMs: 0
    });
    saveOpenClawConfig(this.db, this.connectionId, this.openclaw.getConfig());
  }

  status(): ConnectorStatusPayload {
    return {
      connectionId: this.connectionId,
      connectorName: this.env.CONNECTOR_NAME,
      version: "0.1.0",
      host: {
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch
      },
      pairing: loadPairingState(this.db, this.connectionId),
      openclawConfig: this.openclaw.getConfig(),
      openclaw: loadOpenClawSnapshot(this.db, this.connectionId),
      recentEvents: recentEvents(this.db, this.connectionId, 50)
    };
  }

  getConnectionId(): string {
    return this.connectionId;
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
          ? Math.max(0, Math.round(Number(input.requestTimeoutMs)))
          : current.requestTimeoutMs
    };

    this.openclaw.setConfig(next);
    const saved = this.openclaw.getConfig();
    saveOpenClawConfig(this.db, this.connectionId, saved);
    if (this.connectionId === "default") {
      persistRuntimeEnvValues(this.env.DATA_DIR, {
        OPENCLAW_BASE_URL: saved.baseUrl,
        OPENCLAW_TOKEN: saved.token
      });
    }
    appendEvent(this.db, this.connectionId, "info", "openclaw.config.updated", "OpenClaw config updated from admin UI", {
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
    saveOpenClawConfig(this.db, this.connectionId, saved);
    if (this.connectionId === "default") {
      persistRuntimeEnvValues(this.env.DATA_DIR, {
        OPENCLAW_BASE_URL: saved.baseUrl,
        OPENCLAW_TOKEN: saved.token
      });
    }
    appendEvent(this.db, this.connectionId, "info", "openclaw.config.reset", "OpenClaw config reset to env defaults", {
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
    saveOpenClawSnapshot(this.db, this.connectionId, snapshot);
    appendEvent(
      this.db,
      this.connectionId,
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

    const now = Date.now();
    if (now - this.lastDockerDiscovery < DOCKER_DISCOVERY_COOLDOWN_MS) {
      return initial;
    }
    this.lastDockerDiscovery = now;
    await this.dockerDiscoverOpenClaw({ autoApply: true });
    return loadOpenClawSnapshot(this.db, this.connectionId);
  }

  async dockerDiscoverOpenClaw(options: DockerDiscoverOptions = {}): Promise<OpenClawDockerDiscovery> {
    const currentConfig = this.openclaw.getConfig();
    const overrideToken =
      options.tokenOverride !== undefined ? String(options.tokenOverride || "").trim() : undefined;
    const scanConfig: OpenClawConfig =
      overrideToken !== undefined
        ? { ...currentConfig, token: overrideToken }
        : currentConfig;

    const scan = await tryDockerDiscovery(this.env, scanConfig);

    appendEvent(
      this.db,
      this.connectionId,
      scan.healthyCandidates.length > 0 ? "info" : "warn",
      "openclaw.docker_discover",
      scan.healthyCandidates.length > 0
        ? `Docker discovery found ${scan.healthyCandidates.length} candidate(s)`
        : "Docker discovery found no candidates",
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
      const nextToken = overrideToken !== undefined ? overrideToken : currentConfig.token;

      this.updateOpenClawConfig({
        baseUrl: scan.recommendedBaseUrl,
        token: nextToken,
        discoveryCandidates: ""
      });

      let snapshot = await this.discoverOpenClaw();

      if (!snapshot.healthy) {
        const networks = [...new Set(
          scan.healthyCandidates.map((c) => c.network).filter((n): n is string => Boolean(n))
        )];
        const joinResult = await tryJoinOpenClawNetworks(
          this.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock",
          networks
        );
        if (joinResult.joined.length > 0) {
          appendEvent(this.db, this.connectionId, "info", "openclaw.network_join", `Joined Docker network(s): ${joinResult.joined.join(", ")}`, { joined: joinResult.joined, skipped: joinResult.skipped, failed: joinResult.failed });
          snapshot = await this.discoverOpenClaw();
        }
      }

      appendEvent(
        this.db,
        this.connectionId,
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
    const snapshot = loadOpenClawSnapshot(this.db, this.connectionId);
    savePairingState(this.db, this.connectionId, {
      ...loadPairingState(this.db, this.connectionId),
      cloudBaseUrl: normalizedCloudBaseUrl,
      pairingToken: normalizedPairingToken,
      status: "pairing",
      lastError: null,
      updatedAt: Date.now(),
      connectorId: null,
      connectorSecret: null
    });
    if (this.connectionId === "default") {
      persistRuntimeEnvValues(this.env.DATA_DIR, { PAIRING_TOKEN: normalizedPairingToken });
    }

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
      savePairingState(this.db, this.connectionId, state);
      appendEvent(this.db, this.connectionId, "info", "pairing.success", `Paired connector ${result.connectorId}`, { cloudBaseUrl: normalizedCloudBaseUrl });
      return state;
    } catch (error) {
      const state: PairingState = {
        ...loadPairingState(this.db, this.connectionId),
        status: "error",
        lastError: errorToText(error),
        updatedAt: Date.now()
      };
      savePairingState(this.db, this.connectionId, state);
      appendEvent(this.db, this.connectionId, "error", "pairing.error", state.lastError || "Pairing failed", { cloudBaseUrl: normalizedCloudBaseUrl });
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
    savePairingState(this.db, this.connectionId, state);
    if (this.connectionId === "default") {
      persistRuntimeEnvValues(this.env.DATA_DIR, { PAIRING_TOKEN: "" });
    }
    saveCursor(this.db, this.connectionId, null);
    appendEvent(this.db, this.connectionId, "info", "pairing.clear", "Pairing cleared");
    return state;
  }

  async heartbeat(): Promise<void> {
    const state = loadPairingState(this.db, this.connectionId);
    const openclaw = loadOpenClawSnapshot(this.db, this.connectionId);
    if (state.status !== "paired") return;
    try {
      await this.cloudApi.heartbeat(state, openclaw);
      appendEvent(this.db, this.connectionId, "info", "heartbeat.ok", "Heartbeat sent", {
        connectorId: state.connectorId,
        cloudBaseUrl: state.cloudBaseUrl
      });
    } catch (error) {
      appendEvent(this.db, this.connectionId, "error", "heartbeat.error", "OpenClaw -> cloud heartbeat failed", {
        connectorId: state.connectorId,
        cloudBaseUrl: state.cloudBaseUrl,
        error: errorToText(error)
      });
      throw error;
    }
  }

  async pollAndExecute(): Promise<void> {
    const state = loadPairingState(this.db, this.connectionId);
    if (state.status !== "paired") return;

    const cursor = loadCursor(this.db, this.connectionId);
    let response: { cursor: string | null; commands: CloudCommand[] };
    try {
      response = await this.cloudApi.pollCommands(state, cursor);
    } catch (error) {
      appendEvent(this.db, this.connectionId, "error", "cloud.command.poll_error", "Cloud -> OpenClaw poll failed", {
        connectorId: state.connectorId,
        cloudBaseUrl: state.cloudBaseUrl,
        error: errorToText(error)
      });
      throw error;
    }
    if (response.cursor !== cursor) {
      saveCursor(this.db, this.connectionId, response.cursor ?? null);
    }

    for (const command of response.commands) {
      this.appendInboundCommandEvent(command);
      await this.executeCloudCommand(command);
    }
  }

  async executeCloudCommand(command: CloudCommand): Promise<CommandResult> {
    const state = loadPairingState(this.db, this.connectionId);
    const snapshot = loadOpenClawSnapshot(this.db, this.connectionId);
    const startedAt = Date.now();

    upsertCommandHistory(this.db, this.connectionId, {
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

      upsertCommandHistory(this.db, this.connectionId, {
        cloudCommandId: command.id,
        type: command.type,
        status: "done",
        requestJson: command.payload,
        responseJson: result
      });

      await this.postCommandResultWithEvent(state, command, result);
      appendEvent(this.db, this.connectionId, "info", "command.done", `Executed ${command.type}`, { commandId: command.id });
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
      upsertCommandHistory(this.db, this.connectionId, {
        cloudCommandId: command.id,
        type: command.type,
        status: "error",
        requestJson: command.payload,
        responseJson: result,
        errorText: result.error
      });
      await this.postCommandResultWithEvent(state, command, result);
      appendEvent(this.db, this.connectionId, "error", "command.error", `Failed ${command.type}`, {
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

  private appendInboundCommandEvent(command: CloudCommand): void {
    appendEvent(this.db, this.connectionId, "info", "cloud.command.received", `Cloud -> OpenClaw: ${command.type}`, {
      commandId: command.id,
      ...this.summarizeCommand(command)
    });
  }

  private async postCommandResultWithEvent(
    state: PairingState,
    command: CloudCommand,
    result: CommandResult
  ): Promise<void> {
    try {
      await this.cloudApi.postCommandResult(state, command.id, result);
      appendEvent(
        this.db,
        this.connectionId,
        result.ok ? "info" : "warn",
        "cloud.command.result",
        `OpenClaw -> cloud: ${result.ok ? "Sent result" : "Sent error"} for ${command.type}`,
        {
          commandId: command.id,
          ok: result.ok,
          durationMs: Math.max(0, result.finishedAt - result.startedAt),
          error: result.error || null
        }
      );
    } catch (error) {
      appendEvent(this.db, this.connectionId, "error", "cloud.command.result_error", `OpenClaw -> cloud failed for ${command.type}`, {
        commandId: command.id,
        error: errorToText(error)
      });
      throw error;
    }
  }

  private summarizeCommand(command: CloudCommand): Record<string, unknown> {
    switch (command.type) {
      case "openclaw.chat":
        return {
          agentId: command.payload.agentId ?? null,
          sessionKey: command.payload.sessionKey ?? null,
          messagePreview: this.truncateText(command.payload.message)
        };
      case "openclaw.proxy_http":
        return {
          method: String(command.payload.method || "GET").toUpperCase(),
          path: String(command.payload.path || "")
        };
      default:
        return {};
    }
  }

  private truncateText(value: unknown, limit = 180): string | null {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return null;
    return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
  }
}
