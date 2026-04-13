export type JsonObject = Record<string, unknown>;

export interface HostSnapshot {
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  source?: "models" | "agents" | "manual";
}

export interface OpenClawSnapshot {
  baseUrl: string | null;
  tokenPresent: boolean;
  transport: "auto" | "ws" | "http";
  healthy: boolean;
  agents: AgentInfo[];
  models: string[];
  lastError: string | null;
  wsCandidates: string[];
  updatedAt: number | null;
}

export interface OpenClawConfig {
  baseUrl: string;
  token: string;
  transport: "auto" | "ws" | "http";
  wsPath: string;
  requestTimeoutMs: number;
  discoveryCandidates: string;
}

export interface OpenClawDockerCandidate {
  baseUrl: string;
  hostname: string;
  port: number;
  containerName: string;
  image: string;
  network: string | null;
  ok: boolean;
  models: string[];
  endpoint: string;
  statusCode: number | null;
  contentType: string | null;
  error: string | null;
  score: number;
}

export interface OpenClawDockerDiscovery {
  enabled: boolean;
  testedAt: number;
  socketPath: string;
  notes: string[];
  healthyCandidates: OpenClawDockerCandidate[];
  probes: OpenClawDockerCandidate[];
  recommendedBaseUrl: string | null;
  recommendedDiscoveryCandidates: string[];
}

export interface PairingState {
  connectorId: string | null;
  connectorSecret: string | null;
  cloudBaseUrl: string | null;
  pairingToken: string | null;
  status: "unpaired" | "pairing" | "paired" | "error";
  lastError: string | null;
  heartbeatIntervalSec: number;
  commandPollIntervalSec: number;
  updatedAt: number | null;
}

export interface ConnectorStatusPayload {
  connectionId: string;
  connectorName: string;
  version: string;
  host: HostSnapshot;
  pairing: PairingState;
  openclawConfig: OpenClawConfig;
  openclaw: OpenClawSnapshot;
  recentEvents: ConnectorEvent[];
}

export interface ConnectorEvent {
  id: number;
  level: "info" | "warn" | "error";
  kind: string;
  message: string;
  meta?: JsonObject | null;
  createdAt: number;
}

export interface CloudCommand {
  id: string;
  type:
    | "connector.ping"
    | "openclaw.discover"
    | "openclaw.list_agents"
    | "openclaw.chat"
    | "openclaw.proxy_http";
  payload: JsonObject;
  createdAt?: number;
}

export interface CommandResult {
  ok: boolean;
  commandId: string;
  type: string;
  output?: JsonObject;
  error?: string;
  startedAt: number;
  finishedAt: number;
}

export interface RegisterConnectorResponse {
  connectorId: string;
  connectorSecret: string;
  heartbeatIntervalSec?: number;
  commandPollIntervalSec?: number;
}

export interface Connection {
  id: string;
  name: string;
  createdAt: number;
}

export interface ConnectionWithStatus extends Connection {
  pairing: PairingState;
  openclaw: OpenClawSnapshot;
}
