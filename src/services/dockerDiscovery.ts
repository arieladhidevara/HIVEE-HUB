import http from "node:http";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import type { Env } from "../config/env.js";
import type { OpenClawConfig, OpenClawDockerCandidate, OpenClawDockerDiscovery } from "../types/domain.js";
import { errorToText } from "../utils/text.js";

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

export async function tryDockerDiscovery(env: Env, _config: OpenClawConfig): Promise<OpenClawDockerDiscovery> {
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

    const candidates = seeds.map((seed) => toMetadataCandidate(seed));
    const recommendedBaseUrl = candidates[0]?.baseUrl || null;
    const recommendedDiscoveryCandidates = candidates.map((item) => item.baseUrl);

    return {
      enabled: true,
      testedAt,
      socketPath,
      notes: candidates.length
        ? [
            `Found ${candidates.length} OpenClaw candidate(s) from Docker metadata (HTTP probe skipped by config).`
          ]
        : ["No OpenClaw candidates were derived from Docker metadata."],
      healthyCandidates: candidates,
      probes: candidates,
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

async function dockerRequest(socketPath: string, method: string, path: string, body?: unknown): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const request = http.request(
      {
        socketPath,
        path,
        method,
        headers: {
          Accept: "application/json",
          ...(bodyStr ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) } : {})
        }
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { raw += chunk; });
        response.on("end", () => {
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            const snippet = (raw || "").slice(0, 220).replace(/\s+/g, " ").trim();
            reject(new Error(`Docker API ${path} failed with ${status}${snippet ? `: ${snippet}` : ""}`));
            return;
          }
          resolve(raw);
        });
      }
    );
    request.on("error", (error) => reject(error));
    if (bodyStr) request.write(bodyStr);
    request.end();
  });
}

async function dockerGetJson<T>(socketPath: string, path: string): Promise<T> {
  const raw = await dockerRequest(socketPath, "GET", path);
  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    throw new Error(`Docker API ${path} returned invalid JSON`);
  }
}

async function getSelfContainerId(): Promise<string | null> {
  try {
    const cgroup = await readFile("/proc/self/cgroup", "utf8");
    const match = cgroup.match(/\/docker\/([a-f0-9]{12,64})/);
    if (match?.[1]) return match[1];
  } catch { /* not in docker or no cgroup v1 */ }
  const hostname = os.hostname();
  return /^[a-f0-9]{12}$/.test(hostname) ? hostname : null;
}

export async function tryJoinOpenClawNetworks(
  socketPath: string,
  networks: string[]
): Promise<{ joined: string[]; skipped: string[]; failed: string[] }> {
  const result = { joined: [] as string[], skipped: [] as string[], failed: [] as string[] };
  if (!networks.length) return result;

  const selfId = await getSelfContainerId();
  if (!selfId) return result;

  for (const network of networks) {
    if (!network) continue;
    try {
      await dockerRequest(socketPath, "POST", `/networks/${encodeURIComponent(network)}/connect`, { Container: selfId });
      result.joined.push(network);
    } catch (error) {
      const msg = errorToText(error).toLowerCase();
      if (msg.includes("already exists") || msg.includes("already connected") || msg.includes("endpoint with name")) {
        result.skipped.push(network);
      } else {
        result.failed.push(network);
      }
    }
  }

  return result;
}

function isLikelyOpenClawSummary(summary: DockerContainerSummary): boolean {
  const names = (summary.Names || []).map((name) => name.replace(/^\//, ""));
  const composeService = String(summary.Labels?.["com.docker.compose.service"] || "").trim();
  const proxyText = `${names.join(" ")} ${summary.Image || ""} ${composeService}`.toLowerCase();
  if (isProxyLikeText(proxyText)) return false;

  const labelText = Object.entries(summary.Labels || {})
    .map(([key, value]) => `${key}:${value}`)
    .join(" ");
  const haystack = `${names.join(" ")} ${summary.Image || ""} ${labelText}`.toLowerCase();
  if (haystack.includes("openclaw")) return true;

  return false;
}

function buildCandidateSeeds(containers: DockerContainerInspect[]): CandidateSeed[] {
  const byBaseUrl = new Map<string, CandidateSeed>();

  for (const container of containers) {
    if (isProxyContainer(container)) continue;

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

function toMetadataCandidate(seed: CandidateSeed): OpenClawDockerCandidate {
  return {
    baseUrl: seed.baseUrl,
    hostname: seed.hostname,
    port: seed.port,
    containerName: seed.containerName,
    image: seed.image,
    network: seed.network,
    ok: true,
    models: [],
    endpoint: "metadata",
    statusCode: null,
    contentType: null,
    error: null,
    score: seed.score
  };
}

function isProxyContainer(container: DockerContainerInspect): boolean {
  const name = normalizeContainerName(container.Name);
  const image = String(container.Config?.Image || "");
  const composeService = String(container.Config?.Labels?.["com.docker.compose.service"] || "");
  return isProxyLikeText(`${name} ${image} ${composeService}`.toLowerCase());
}

function isProxyLikeText(value: string): boolean {
  const lowered = String(value || "").toLowerCase();
  if (!lowered) return false;
  return lowered.includes("proxy");
}

function normalizeContainerName(raw: string | undefined): string {
  return String(raw || "")
    .trim()
    .replace(/^\/+/, "");
}

function isHostnameLike(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
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
