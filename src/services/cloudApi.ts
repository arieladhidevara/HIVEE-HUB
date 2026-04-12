import os from "node:os";
import type { Env } from "../config/env.js";
import type { CloudCommand, OpenClawSnapshot, PairingState, RegisterConnectorResponse } from "../types/domain.js";
import { ensureTrailingSlashless, errorToText } from "../utils/text.js";

export class CloudApi {
  constructor(private readonly env: Env) {}

  async register(pairingToken: string, cloudBaseUrl: string, openclaw: OpenClawSnapshot): Promise<RegisterConnectorResponse> {
    const url = `${ensureTrailingSlashless(cloudBaseUrl)}/api/connectors/register`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          pairingToken,
          connectorName: this.env.CONNECTOR_NAME,
          version: "0.1.0",
          host: {
            hostname: os.hostname(),
            platform: process.platform,
            arch: process.arch
          },
          openclaw: {
            baseUrl: openclaw.baseUrl,
            transport: openclaw.transport,
            agents: openclaw.agents,
            models: openclaw.models
          }
        }),
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      throw new Error(`Cloud register request failed (${url}): ${describeFetchError(error)}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cloud register failed: ${res.status} ${text}`);
    }
    return (await res.json()) as RegisterConnectorResponse;
  }

  async heartbeat(state: PairingState, openclaw: OpenClawSnapshot): Promise<void> {
    if (!state.connectorId || !state.connectorSecret || !state.cloudBaseUrl) return;
    const url = `${ensureTrailingSlashless(state.cloudBaseUrl)}/api/connectors/${encodeURIComponent(state.connectorId)}/heartbeat`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${state.connectorSecret}`
        },
        body: JSON.stringify({
          status: "online",
          openclaw,
          connectorName: this.env.CONNECTOR_NAME,
          version: "0.1.0",
          observedAt: Date.now()
        }),
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      throw new Error(`Heartbeat request failed (${url}): ${describeFetchError(error)}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Heartbeat failed: ${res.status} ${text}`);
    }
  }

  async pollCommands(state: PairingState, cursor: string | null): Promise<{ cursor: string | null; commands: CloudCommand[] }> {
    if (!state.connectorId || !state.connectorSecret || !state.cloudBaseUrl) {
      return { cursor, commands: [] };
    }

    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const url = `${ensureTrailingSlashless(state.cloudBaseUrl)}/api/connectors/${encodeURIComponent(state.connectorId)}/commands${query}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${state.connectorSecret}`
        },
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      throw new Error(`Command poll request failed (${url}): ${describeFetchError(error)}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Command poll failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { cursor?: string | null; commands?: CloudCommand[] };
    return {
      cursor: data.cursor ?? cursor,
      commands: Array.isArray(data.commands) ? data.commands : []
    };
  }

  async postCommandResult(state: PairingState, commandId: string, payload: unknown): Promise<void> {
    if (!state.connectorId || !state.connectorSecret || !state.cloudBaseUrl) return;

    const url = `${ensureTrailingSlashless(state.cloudBaseUrl)}/api/connectors/${encodeURIComponent(state.connectorId)}/commands/${encodeURIComponent(commandId)}/result`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "content-type": "application/json",
          Authorization: `Bearer ${state.connectorSecret}`
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      throw new Error(`Post command result request failed (${url}): ${describeFetchError(error)}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Post command result failed: ${res.status} ${text}`);
    }
  }

  static describeConnectionError(error: unknown): string {
    return errorToText(error);
  }
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return errorToText(error);

  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const details = cause as Partial<NodeJS.ErrnoException> & { address?: string; port?: number };
    const extras = [details.code, details.errno, details.address, details.port]
      .filter((item) => item !== undefined && item !== null && item !== "")
      .map((item) => String(item))
      .join(" ");
    if (extras) return `${error.message} (${extras})`;
  }

  return error.message;
}
