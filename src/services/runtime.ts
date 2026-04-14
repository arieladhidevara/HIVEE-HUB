import type { Env } from "../config/env.js";
import type { ConnectorManager } from "./connectorManager.js";
import { errorToText } from "../utils/text.js";

export class RuntimeLoops {
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private discoveryInFlight = false;
  private heartbeatInFlight = false;
  private pollInFlight = false;

  constructor(private readonly env: Env, private readonly manager: ConnectorManager) {}

  start(): void {
    this.stop();

    this.discoveryTimer = setInterval(async () => {
      if (this.discoveryInFlight) return;
      this.discoveryInFlight = true;
      try {
        await this.manager.discoverOpenClawWithDockerFallback();
      } catch (error) {
        console.error("Discovery loop error", errorToText(error));
      } finally {
        this.discoveryInFlight = false;
      }
    }, this.env.CONNECTOR_DISCOVERY_INTERVAL_SEC * 1000);

    this.heartbeatTimer = setInterval(async () => {
      if (this.heartbeatInFlight) return;
      this.heartbeatInFlight = true;
      try {
        await this.manager.heartbeat();
      } catch (error) {
        console.error("Heartbeat loop error", errorToText(error));
      } finally {
        this.heartbeatInFlight = false;
      }
    }, this.env.CONNECTOR_HEARTBEAT_INTERVAL_SEC * 1000);

    this.pollTimer = setInterval(async () => {
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      try {
        await this.manager.pollAndExecute();
      } catch (error) {
        console.error("Command poll loop error", errorToText(error));
      } finally {
        this.pollInFlight = false;
      }
    }, this.env.CONNECTOR_COMMAND_POLL_INTERVAL_SEC * 1000);
  }

  stop(): void {
    for (const timer of [this.discoveryTimer, this.heartbeatTimer, this.pollTimer]) {
      if (timer) clearInterval(timer);
    }
    this.discoveryTimer = null;
    this.heartbeatTimer = null;
    this.pollTimer = null;
    this.discoveryInFlight = false;
    this.heartbeatInFlight = false;
    this.pollInFlight = false;
  }
}
