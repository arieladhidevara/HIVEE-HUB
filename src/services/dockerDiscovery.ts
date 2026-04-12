import http from "node:http";
import { access } from "node:fs/promises";
import type { Env } from "../config/env.js";
import type { OpenClawConfig, OpenClawDockerCandidate, OpenClawDockerDiscovery } from "../types/domain.js";
import { ensureTrailingSlashless, errorToText } from "../utils/text.js";

const MODEL_ENDPOINTS = ["/v1/models", "/models", "/api/models", "/api/v1/models"];
const COMMON_PORTS = [18790, 43136, 18789];
const MAX_CANDIDATES = 12;

interface DockerContainerSummary {
  Id: string;
  Names?: string[];
  Image?: string;
  Labels?: Record<string, string>;
  Ports?: Array<{ PrivatePort?: number; Type?: string }>;
}

interface DockerContainerInspect {
  Id: string;
  Name?: string;
  Config?: {
    Image?: string;
    Labels?: Record<string, string>;
    ExposedPorts?: Record<string, unknown>;
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
    Networks?: Record<string, { Aliases?: string[] }>;
  };
}

interface HostEntry {
  hostname: string;
  network: string | null;
}

interface CandidateSeed {
  baseUrl: string;
  hostname: string;
  port: number;
  containerName: string;
  image: string;
  network: string | null;
  score: number;
}

export async function tryDockerDiscovery(env: Env, config: OpenClawConfig): Promise<OpenClawDockerDiscovery> {
  const testedAt = Date.now();
  const socketPath = env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";

  if (!env.ENABLE_DOCKER_DISCOVERY) {
    return {
      enabled: false,
      testedAt,
      socketPath,
      notes: [
        "Docker discovery is disabled. Set ENABLE_DOCKER_DISCOVERY=true and mount docker.sock to enable scanning."
      ],
      healthyCandidates: [],
      probes: [],
      recommendedBaseUrl: null,
      recommendedDiscoveryCandidates: []
    };
  }

  try {
    await access(socketPath);
  } catch {
    return {
      enabled: true,
      testedAt,
      socketPath,
      notes: [`Docker socket is not accessible at ${socketPath}.`],
      healthyCandidates: [],
      probes: [],
      recommendedBaseUrl: null,
      recommendedDiscoveryCandidates: []
    };
  }

  try {
    const summaries = await dockerGetJson<DockerContainerSummary[]>(socketPath, "/containers/json?all=0");
    const likely = summaries.filter(isLikelyOpenClawSummary);
    if (!likely.length) {
      return {
        enabled: true,
        testedAt,
        socketPath,
        notes: ["No likely OpenClaw containers found in Docker."],
        healthyCandidates: [],
        probes: [],
        recommendedBaseUrl: null,
        recommendedDiscoveryCandidates: []
      };
    }

    const inspected: DockerContainerInspect[] = [];
    for (const summary of likely) {
      try {
        const detail = await dockerGetJson<DockerContainerInspect>(
          socketPath,
          `/containers/${encodeURIComponent(summary.Id)}/json`
        );
        inspected.push(detail);
      } catch {
        continue;
      }
    }

    const seeds = buildCandidateSeeds(inspected);
    if (!seeds.length) {
      return {
        enabled: true,
        testedAt,
        socketPath,
        notes: ["OpenClaw-like containers were found, but no usable host/port candidates were derived."],
        healthyCandidates: [],
        probes: [],
        recommendedBaseUrl: null,
        recommendedDiscoveryCandidates: []
      };
    }

    const timeoutMs = clamp(Math.round(config.requestTimeoutMs / 2), 1500, 8000);
    const probes = await probeCandidates(seeds, config.token, timeoutMs);
    const healthyCandidates = probes
      .filter((item) => item.ok)
      .sort((a, b) => b.score - a.score || b.models.length - a.models.length);
    const recommendedBaseUrl = healthyCandidates[0]?.baseUrl || null;
    const recommendedDiscoveryCandidates = healthyCandidates.map((item) => item.baseUrl);

    return {
      enabled: true,
      testedAt,
      socketPath,
      notes: healthyCandidates.length
        ? [`Found ${healthyCandidates.length} healthy candidate(s).`]
        : ["No candidate returned JSON models. Check container network wiring and OpenClaw listener ports."],
      healthyCandidates,
      probes,
      recommendedBaseUrl,
      recommendedDiscoveryCandidates
    };
  } catch (error) {
    return {
      enabled: true,
      testedAt,
      socketPath,
      notes: [`Docker discovery failed: ${describeError(error)}`],
      healthyCandidates: [],
      probes: [],
      recommendedBaseUrl: null,
      recommendedDiscoveryCandidates: []
    };
  }
}

async function dockerGetJson<T>(socketPath: string, path: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path,
        method: "GET",
        headers: { Accept: "application/json" }
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            const snippet = (raw || "").slice(0, 220).replace(/\s+/g, " ").trim();
            reject(new Error(`Docker API ${path} failed with ${status}${snippet ? `: ${snippet}` : ""}`));
            return;
          }
          try {
            resolve((raw ? JSON.parse(raw) : {}) as T);
          } catch {
            reject(new Error(`Docker API ${path} returned invalid JSON`));
          }
        });
      }
    );

    request.on("error", (error) => reject(error));
    request.end();
  });
}

function isLikelyOpenClawSummary(summary: DockerContainerSummary): boolean {
  const names = (summary.Names || []).map((name) => name.replace(/^\//, ""));
  const labelText = Object.entries(summary.Labels || {})
    .map(([key, value]) => `${key}:${value}`)
    .join(" ");
  const haystack = `${names.join(" ")} ${summary.Image || ""} ${labelText}`.toLowerCase();
  if (haystack.includes("openclaw")) return true;

  const summaryPorts = (summary.Ports || [])
    .filter((item) => item.Type === "tcp")
    .map((item) => item.PrivatePort || 0);
  return summaryPorts.some((port) => COMMON_PORTS.includes(port));
}

function buildCandidateSeeds(containers: DockerContainerInspect[]): CandidateSeed[] {
  const byBaseUrl = new Map<string, CandidateSeed>();

  for (const container of containers) {
    const containerName = normalizeContainerName(container.Name);
    const image = String(container.Config?.Image || "");
    const hostEntries = collectHostEntries(container);
    const ports = collectPorts(container);

    for (const host of hostEntries) {
      for (const port of ports) {
        const baseUrl = `http://${host.hostname}:${port}`;
        const score = scoreCandidate(containerName, image, host.hostname, host.network, port);
        const seed: CandidateSeed = {
          baseUrl,
          hostname: host.hostname,
          port,
          containerName,
          image,
          network: host.network,
          score
        };
        const current = byBaseUrl.get(baseUrl);
        if (!current || seed.score > current.score) {
          byBaseUrl.set(baseUrl, seed);
        }
      }
    }
  }

  return Array.from(byBaseUrl.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}

function collectHostEntries(container: DockerContainerInspect): HostEntry[] {
  const out: HostEntry[] = [];
  const seen = new Set<string>();
  const networks = container.NetworkSettings?.Networks || {};
  const containerName = normalizeContainerName(container.Name);

  const add = (hostname: string, network: string | null) => {
    if (!hostname || !isHostnameLike(hostname)) return;
    const key = `${hostname}|${network || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ hostname, network });
  };

  for (const [networkName, networkInfo] of Object.entries(networks)) {
    if (containerName) add(containerName, networkName);
    for (const alias of networkInfo.Aliases || []) {
      add(String(alias || "").trim(), networkName);
    }
  }

  if (containerName) add(containerName, null);
  const composeService = String(container.Config?.Labels?.["com.docker.compose.service"] || "").trim();
  if (composeService) add(composeService, null);

  return out;
}

function collectPorts(container: DockerContainerInspect): number[] {
  const set = new Set<number>();
  for (const port of COMMON_PORTS) {
    set.add(port);
  }

  for (const key of Object.keys(container.Config?.ExposedPorts || {})) {
    const parsed = parsePortSpec(key);
    if (parsed) set.add(parsed);
  }

  for (const key of Object.keys(container.NetworkSettings?.Ports || {})) {
    const parsed = parsePortSpec(key);
    if (parsed) set.add(parsed);
  }

  return Array.from(set)
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535)
    .sort((a, b) => scorePort(b) - scorePort(a) || a - b);
}

function parsePortSpec(value: string): number | null {
  const raw = String(value || "").split("/")[0];
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return null;
  return parsed;
}

function scorePort(port: number): number {
  if (port === 18790) return 140;
  if (port === 43136) return 130;
  if (port === 18789) return 120;
  return 10;
}

function scoreCandidate(containerName: string, image: string, hostname: string, network: string | null, port: number): number {
  let score = 0;
  const loweredHost = hostname.toLowerCase();
  const loweredContainer = (containerName || "").toLowerCase();
  const loweredImage = (image || "").toLowerCase();
  const loweredNetwork = (network || "").toLowerCase();

  if (loweredHost.includes("openclaw")) score += 200;
  if (loweredHost.includes("loopback-proxy")) score += 120;
  if (loweredContainer.includes("openclaw")) score += 120;
  if (loweredImage.includes("openclaw")) score += 100;
  if (loweredNetwork.includes("proxy")) score += 35;

  score += scorePort(port);

  if (hostname.includes(".")) score -= 8;
  if (loweredHost === "localhost" || loweredHost === "127.0.0.1") score -= 100;

  return score;
}

async function probeCandidates(candidates: CandidateSeed[], token: string, timeoutMs: number): Promise<OpenClawDockerCandidate[]> {
  if (!candidates.length) return [];

  const output = new Array<OpenClawDockerCandidate>(candidates.length);
  const concurrency = Math.min(3, candidates.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= candidates.length) break;
        output[index] = await probeCandidate(candidates[index], token, timeoutMs);
      }
    })
  );

  return output;
}

async function probeCandidate(seed: CandidateSeed, token: string, timeoutMs: number): Promise<OpenClawDockerCandidate> {
  let lastError = "No model endpoint returned JSON models.";
  let lastStatusCode: number | null = null;
  let lastContentType: string | null = null;
  let lastEndpoint = MODEL_ENDPOINTS[0];

  for (const endpoint of MODEL_ENDPOINTS) {
    lastEndpoint = endpoint;
    const url = `${ensureTrailingSlashless(seed.baseUrl)}${endpoint}`;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: authHeaders(token),
        signal: AbortSignal.timeout(timeoutMs)
      });
      lastStatusCode = response.status;
      lastContentType = response.headers.get("content-type");

      if (!response.ok) {
        lastError = `HTTP ${response.status} from ${endpoint}`;
        continue;
      }

      if (!(response.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
        lastError = `Non-JSON response from ${endpoint}`;
        continue;
      }

      const payload = (await response.json()) as unknown;
      const models = extractModelIds(payload);
      if (models.length > 0) {
        return {
          baseUrl: seed.baseUrl,
          hostname: seed.hostname,
          port: seed.port,
          containerName: seed.containerName,
          image: seed.image,
          network: seed.network,
          ok: true,
          models,
          endpoint,
          statusCode: response.status,
          contentType: response.headers.get("content-type"),
          error: null,
          score: seed.score
        };
      }

      lastError = `JSON response had no models at ${endpoint}`;
    } catch (error) {
      lastError = `${describeError(error)} at ${endpoint}`;
    }
  }

  return {
    baseUrl: seed.baseUrl,
    hostname: seed.hostname,
    port: seed.port,
    containerName: seed.containerName,
    image: seed.image,
    network: seed.network,
    ok: false,
    models: [],
    endpoint: lastEndpoint,
    statusCode: lastStatusCode,
    contentType: lastContentType,
    error: lastError,
    score: seed.score
  };
}

function extractModelIds(payload: unknown): string[] {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const rawData = record.data;
  if (Array.isArray(rawData)) {
    return rawData
      .map((item) => {
        if (item && typeof item === "object" && "id" in item) {
          return String((item as { id?: unknown }).id || "").trim();
        }
        return "";
      })
      .filter(Boolean);
  }

  const rawModels = record.models;
  if (Array.isArray(rawModels)) {
    return rawModels
      .map((item) => {
        if (item && typeof item === "object" && "id" in item) {
          return String((item as { id?: unknown }).id || "").trim();
        }
        return String(item || "").trim();
      })
      .filter(Boolean);
  }

  return [];
}

function authHeaders(token: string): HeadersInit {
  return token ? { Authorization: `Bearer ${token}`, Accept: "application/json" } : { Accept: "application/json" };
}

function normalizeContainerName(raw: string | undefined): string {
  return String(raw || "")
    .trim()
    .replace(/^\/+/, "");
}

function isHostnameLike(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return errorToText(error);

  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeObj = cause as Partial<NodeJS.ErrnoException> & { address?: string; port?: number };
    const extras = [causeObj.code, causeObj.errno, causeObj.address, causeObj.port]
      .filter((item) => item !== undefined && item !== null && item !== "")
      .map((item) => String(item));
    if (extras.length) {
      return `${error.message} (${extras.join(" ")})`;
    }
  }

  return error.message;
}
