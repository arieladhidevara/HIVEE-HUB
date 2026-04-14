import { WebSocket } from "ws";
import type { Env } from "../config/env.js";
import type { PairingState } from "../types/domain.js";

/**
 * Optional future outbound WS transport to Hivee Cloud.
 *
 * This is intentionally not wired into the MVP runtime loops yet.
 * The connector currently uses HTTP polling for simplicity and reliability.
 */
export class CloudSocket {
  constructor(private readonly env: Env) {}

  connect(state: PairingState): WebSocket | null {
    if (!this.env.CLOUD_WS_URL || !state.connectorId || !state.connectorSecret) {
      return null;
    }

    const ws = new WebSocket(
      `${this.env.CLOUD_WS_URL.replace(/\/+$/, "")}/api/connectors/${encodeURIComponent(state.connectorId)}/stream`,
      {
        headers: {
          Authorization: `Bearer ${state.connectorSecret}`
        }
      }
    );

    return ws;
  }
}
