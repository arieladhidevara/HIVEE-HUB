import type { Env } from "../config/env.js";
import type { ConnectorManager } from "./connectorManager.js";
import { errorToText } from "../utils/text.js";

export class RuntimeLoops {
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly env: Env, private readonly manager: ConnectorManager) {}

  start(): void {
    this.stop();

    this.discoveryTimer = setInterval(async () => {
      try {
        await this.manager.discoverOpenClawWithDockerFallback();
      } catch (error) {
        console.error("Discovery loop error", errorToText(error));
      }
    }, this.env.CONNECTOR_DISCOVERY_INTERVAL_SEC * 1000);

    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.manager.heartbeat();
      } catch (error) {
        console.error("Heartbeat loop error", errorToText(error));
      }
    }, this.env.CONNECTOR_HEARTBEAT_INTERVAL_SEC * 1000);

    this.pollTimer = setInterval(async () => {
      try {
        await this.manager.pollAndExecute();
      } catch (error) {
        console.error("Command poll loop error", errorToText(error));
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
  }
}
