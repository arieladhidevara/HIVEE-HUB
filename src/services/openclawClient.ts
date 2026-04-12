import { WebSocket } from "ws";
import type { Env } from "../config/env.js";
import type { AgentInfo, OpenClawConfig, OpenClawSnapshot } from "../types/domain.js";
import { buildWsCandidates, inferAgentsFromModels } from "../utils/openclaw.js";
import { ensureTrailingSlashless, errorToText } from "../utils/text.js";
import { nowTs } from "../utils/time.js";

export interface OpenClawChatInput {
  agentId?: string;
  message: string;
  sessionKey?: string;
  timeoutMs?: number;
}

export interface OpenClawChatOutput {
  ok: boolean;
  transport: "ws" | "http";
  text?: string;
  raw?: unknown;
  error?: string;
}

export class OpenClawClient {
  private config: OpenClawConfig;

  constructor(env: Env) {
    this.config = this.normalizeConfig({
      baseUrl: env.OPENCLAW_BASE_URL || "",
      token: env.OPENCLAW_TOKEN || "",
      transport: env.OPENCLAW_TRANSPORT,
      wsPath: env.OPENCLAW_WS_PATH || "",
      requestTimeoutMs: env.OPENCLAW_REQUEST_TIMEOUT_MS,
      discoveryCandidates: env.OPENCLAW_DISCOVERY_CANDIDATES || ""
    });
  }

  getConfig(): OpenClawConfig {
    return { ...this.config };
  }

  setConfig(input: OpenClawConfig): void {
    this.config = this.normalizeConfig(input);
  }

  getCandidates(): string[] {
    const seeded = (this.config.discoveryCandidates || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (this.config.baseUrl) {
      return [this.config.baseUrl, ...seeded.filter((x) => x !== this.config.baseUrl)];
    }
    return seeded.map(ensureTrailingSlashless);
  }

  async discover(): Promise<OpenClawSnapshot> {
    const token = this.config.token;
    const transport = this.config.transport;
    const candidates = this.getCandidates();
    const discoveryTimeoutMs = Math.min(this.config.requestTimeoutMs, 5_000);

    const results = await Promise.allSettled(
      candidates.map(async (baseUrl) => {
        const modelsRes = await this.fetchModels(baseUrl, token, discoveryTimeoutMs);
        if (!modelsRes.ok) throw new Error(modelsRes.error || "no models");
        return { baseUrl, models: modelsRes.models };
      })
    );

    const ordered = candidates
      .map((baseUrl, i) => ({ baseUrl, result: results[i] }))
      .filter((item): item is { baseUrl: string; result: PromiseFulfilledResult<{ baseUrl: string; models: string[] }> } =>
        item.result.status === "fulfilled"
      );

    if (ordered.length > 0) {
      const { baseUrl, models } = ordered[0].result.value;
      const agents = await this.fetchAgents(baseUrl, token, models);
      return {
        baseUrl,
        tokenPresent: Boolean(token),
        transport,
        healthy: true,
        agents,
        models,
        lastError: null,
        wsCandidates: buildWsCandidates(baseUrl, this.config.wsPath || undefined),
        updatedAt: nowTs()
      };
    }

    return {
      baseUrl: this.config.baseUrl || null,
      tokenPresent: Boolean(token),
      transport,
      healthy: false,
      agents: [],
      models: [],
      lastError: "Could not discover a healthy local OpenClaw endpoint",
      wsCandidates: this.config.baseUrl
        ? buildWsCandidates(this.config.baseUrl, this.config.wsPath || undefined)
        : [],
      updatedAt: nowTs()
    };
  }

  async fetchModels(baseUrl: string, token: string, timeoutMs?: number): Promise<{ ok: boolean; models: string[]; error?: string }> {
    const endpoints = ["/v1/models", "/models", "/api/models", "/api/v1/models"];
    for (const path of endpoints) {
      try {
        const res = await fetch(`${ensureTrailingSlashless(baseUrl)}${path}`, {
          method: "GET",
          headers: this.authHeaders(token),
          signal: AbortSignal.timeout(timeoutMs ?? this.config.requestTimeoutMs)
        });
        const contentType = res.headers.get("content-type") || "";
        if (!res.ok) continue;
        if (!contentType.includes("application/json")) continue;
        const data = (await res.json()) as any;
        const list = Array.isArray(data?.data)
          ? data.data.map((item: any) => String(item?.id || "").trim()).filter(Boolean)
          : Array.isArray(data?.models)
            ? data.models.map((item: any) => String(item?.id || item || "").trim()).filter(Boolean)
            : [];
        if (list.length > 0) {
          return { ok: true, models: list };
        }
      } catch (error) {
        continue;
      }
    }
    return { ok: false, models: [], error: "No model endpoint returned JSON models" };
  }

  async fetchAgents(baseUrl: string, token: string, models: string[]): Promise<AgentInfo[]> {
    const endpoints = ["/api/agents", "/v1/agents", "/agents"];
    for (const path of endpoints) {
      try {
        const res = await fetch(`${ensureTrailingSlashless(baseUrl)}${path}`, {
          method: "GET",
          headers: this.authHeaders(token),
          signal: AbortSignal.timeout(this.config.requestTimeoutMs)
        });
        const contentType = res.headers.get("content-type") || "";
        if (!res.ok || !contentType.includes("application/json")) continue;
        const data = (await res.json()) as any;
        const raw = Array.isArray(data?.agents) ? data.agents : Array.isArray(data) ? data : [];
        const agents = raw
          .map((item: any) => ({
            id: String(item?.id || item?.name || "").trim(),
            name: String(item?.name || item?.id || "").trim(),
            description: item?.description ? String(item.description) : undefined,
            source: "agents" as const
          }))
          .filter((x: AgentInfo) => x.id);
        if (agents.length > 0) return agents;
      } catch {
        continue;
      }
    }

    return inferAgentsFromModels(models).map((item) => ({ ...item, source: "models" as const }));
  }

  async chat(input: OpenClawChatInput, snapshot: OpenClawSnapshot): Promise<OpenClawChatOutput> {
    if (!snapshot.baseUrl) {
      return { ok: false, transport: "http", error: "OpenClaw base URL is not configured" };
    }

    const transport = snapshot.transport;
    if (transport === "ws") {
      return this.chatWs(input, snapshot);
    }
    if (transport === "http") {
      return this.chatHttp(input, snapshot);
    }

    const wsRes = await this.chatWs(input, snapshot);
    if (wsRes.ok) return wsRes;

    const httpRes = await this.chatHttp(input, snapshot);
    if (httpRes.ok) return httpRes;

    return {
      ok: false,
      transport: "http",
      error: `WS failed: ${wsRes.error || "unknown"}; HTTP failed: ${httpRes.error || "unknown"}`
    };
  }

  async chatHttp(input: OpenClawChatInput, snapshot: OpenClawSnapshot): Promise<OpenClawChatOutput> {
    const baseUrl = snapshot.baseUrl;
    if (!baseUrl) return { ok: false, transport: "http", error: "Missing base URL" };
    const token = this.config.token;
    const endpoints = ["/v1/chat/completions", "/chat/completions", "/api/chat/completions", "/v1/responses", "/responses", "/api/responses"];

    for (const path of endpoints) {
      const body = path.includes("responses")
        ? {
          model: input.agentId || "openclaw/default",
          input: input.message
        }
        : {
          model: input.agentId || "openclaw/default",
          messages: [{ role: "user", content: input.message }]
        };

      try {
        const res = await fetch(`${ensureTrailingSlashless(baseUrl)}${path}`, {
          method: "POST",
          headers: {
            ...this.authHeaders(token),
            "content-type": "application/json"
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(input.timeoutMs || this.config.requestTimeoutMs)
        });
        const ct = res.headers.get("content-type") || "";
        if (!res.ok || !ct.includes("application/json")) continue;
        const data = await res.json();
        const text = this.extractText(data);
        return { ok: true, transport: "http", text, raw: data };
      } catch (error) {
        continue;
      }
    }

    return { ok: false, transport: "http", error: "No HTTP chat endpoint responded with JSON" };
  }

  async chatWs(input: OpenClawChatInput, snapshot: OpenClawSnapshot): Promise<OpenClawChatOutput> {
    const baseUrl = snapshot.baseUrl;
    if (!baseUrl) return { ok: false, transport: "ws", error: "Missing base URL" };
    const token = this.config.token;
    const candidates = snapshot.wsCandidates.length ? snapshot.wsCandidates : buildWsCandidates(baseUrl, this.config.wsPath || undefined);

    let lastError = "unknown";
    for (const candidate of candidates) {
      try {
        const result = await this.tryWsCandidate(candidate, token, input);
        if (result.ok) {
          return result;
        }
        lastError = result.error || lastError;
      } catch (error) {
        lastError = errorToText(error);
      }
    }

    return { ok: false, transport: "ws", error: `WS chat failed across all candidate WS paths. Last error: ${lastError}` };
  }

  async proxyHttp(snapshot: OpenClawSnapshot, method: string, path: string, body?: unknown): Promise<any> {
    if (!snapshot.baseUrl) throw new Error("Missing OpenClaw base URL");
    const safePath = path.startsWith("/") ? path : `/${path}`;
    if (!safePath.startsWith("/v1/") && !safePath.startsWith("/api/") && !safePath.startsWith("/models")) {
      throw new Error("Unsafe proxy path");
    }
    const res = await fetch(`${ensureTrailingSlashless(snapshot.baseUrl)}${safePath}`, {
      method,
      headers: {
        ...this.authHeaders(this.config.token),
        "content-type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs)
    });
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return res.json();
    return { ok: res.ok, status: res.status, text: await res.text() };
  }

  private async tryWsCandidate(candidate: string, token: string, input: OpenClawChatInput): Promise<OpenClawChatOutput> {
    return await new Promise<OpenClawChatOutput>((resolve) => {
      let settled = false;
      let chunks: string[] = [];
      let sawChallenge = false;
      let sawMeaningfulText = false;
      const socket = new WebSocket(candidate, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        handshakeTimeout: input.timeoutMs || this.config.requestTimeoutMs
      });

      const finish = (payload: OpenClawChatOutput) => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch { }
        resolve(payload);
      };

      const timer = setTimeout(() => {
        finish({ ok: false, transport: "ws", error: `Timeout while waiting for WS response from ${candidate}` });
      }, input.timeoutMs || this.config.requestTimeoutMs);

      socket.on("open", () => {
        const messages = [
          { type: "chat", agent_id: input.agentId, message: input.message, session_key: input.sessionKey },
          { op: "chat", agent_id: input.agentId, input: input.message, session_key: input.sessionKey },
          { event: "chat", data: { agent_id: input.agentId, message: input.message, session_key: input.sessionKey } }
        ];
        socket.send(JSON.stringify(messages[0]));
      });

      socket.on("message", (data) => {
        const raw = data.toString();
        chunks.push(raw);

        try {
          const parsed = JSON.parse(raw);

          const eventName = String(parsed?.event || parsed?.type || "").toLowerCase();

          if (eventName.includes("connect_challenge") || eventName.includes("challenge")) {
            sawChallenge = true;
            return;
          }

          const maybeText = this.extractText(parsed);
          if (maybeText) {
            sawMeaningfulText = true;
            clearTimeout(timer);
            finish({ ok: true, transport: "ws", text: maybeText, raw: parsed });
            return;
          }

          if (parsed?.type === "error" || parsed?.error) {
            clearTimeout(timer);
            finish({
              ok: false,
              transport: "ws",
              error: parsed?.error || parsed?.message || raw,
              raw: parsed
            });
            return;
          }
        } catch {
          const trimmed = raw.trim();
          if (trimmed) {
            sawMeaningfulText = true;
            clearTimeout(timer);
            finish({ ok: true, transport: "ws", text: trimmed, raw });
            return;
          }
        }
      });

      socket.on("error", (error) => {
        clearTimeout(timer);
        finish({ ok: false, transport: "ws", error: errorToText(error) });
      });

      socket.on("close", (_code, reason) => {
        clearTimeout(timer);
        if (!settled) {
          if (sawChallenge && !sawMeaningfulText) {
            finish({
              ok: false,
              transport: "ws",
              error: "WS returned connect_challenge only; falling back to HTTP"
            });
            return;
          }

          const text = chunks.join("\n").trim();

          finish(
            sawMeaningfulText && text
              ? { ok: true, transport: "ws", text, raw: text }
              : { ok: false, transport: "ws", error: reason.toString() || "Socket closed before response" }
          );
        }
      });
    });
  }

  private authHeaders(token: string): HeadersInit {
    return token ? { Authorization: `Bearer ${token}`, Accept: "application/json" } : { Accept: "application/json" };
  }

  private normalizeConfig(input: OpenClawConfig): OpenClawConfig {
    const timeout = Number.isFinite(input.requestTimeoutMs) ? Math.round(input.requestTimeoutMs) : 20_000;
    return {
      baseUrl: ensureTrailingSlashless((input.baseUrl || "").trim()),
      token: (input.token || "").trim(),
      transport: input.transport,
      wsPath: (input.wsPath || "").trim(),
      requestTimeoutMs: timeout > 0 ? timeout : 20_000,
      discoveryCandidates: (input.discoveryCandidates || "").trim()
    };
  }

  private extractText(payload: any): string {
    return (
      payload?.output_text ||
      payload?.text ||
      payload?.message ||
      payload?.choices?.[0]?.message?.content ||
      payload?.choices?.[0]?.delta?.content ||
      payload?.response?.output_text ||
      ""
    );
  }
}
