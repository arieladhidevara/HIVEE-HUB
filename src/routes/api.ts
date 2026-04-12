import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ConnectorManager } from "../services/connectorManager.js";

export async function registerApiRoutes(app: FastifyInstance, manager: ConnectorManager): Promise<void> {
  app.get("/health", async () => ({ ok: true, service: "hivee-connector", version: "0.1.0", now: Date.now() }));

  app.get("/api/status", async () => manager.status());
  app.get("/api/openclaw/config", async () => ({ ok: true, config: manager.getOpenClawConfig() }));

  app.post("/api/openclaw/config", async (request, reply) => {
    const payload = z
      .object({
        baseUrl: z.string().optional(),
        discoveryCandidates: z.string().optional(),
        token: z.string().optional(),
        transport: z.enum(["auto", "ws", "http"]).optional(),
        wsPath: z.string().optional(),
        requestTimeoutMs: z.coerce.number().int().min(1000).max(120000).optional()
      })
      .parse(request.body ?? {});

    try {
      const config = manager.updateOpenClawConfig(payload);
      const snapshot = await manager.discoverOpenClaw();
      return { ok: snapshot.healthy, config, snapshot };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/openclaw/config/reset", async (_request, reply) => {
    try {
      const config = manager.resetOpenClawConfig();
      const snapshot = await manager.discoverOpenClaw();
      return { ok: snapshot.healthy, config, snapshot };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/pairing/start", async (request, reply) => {
    const payload = z
      .object({
        cloudBaseUrl: z.string().optional(),
        pairingToken: z.string().min(1)
      })
      .parse(request.body ?? {});

    try {
      const state = await manager.pair(payload.cloudBaseUrl || "", payload.pairingToken);
      return { ok: true, state };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/pairing/clear", async () => ({ ok: true, state: manager.clearPairing() }));

  app.post("/api/openclaw/discover", async () => {
    const snapshot = await manager.discoverOpenClaw();
    return { ok: snapshot.healthy, snapshot };
  });

  app.post("/api/openclaw/discover/docker", async (request, reply) => {
    try {
      const payload = z
        .object({
          token: z.string().optional(),
          autoApply: z.coerce.boolean().optional().default(true)
        })
        .parse(request.body ?? {});

      const scan = await manager.dockerDiscoverOpenClaw({
        tokenOverride: payload.token,
        autoApply: payload.autoApply
      });
      return { ok: scan.healthyCandidates.length > 0, scan, status: manager.status() };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/api/commands/execute", async (request, reply) => {
    const payload = z
      .object({
        id: z.string().min(1),
        type: z.string().min(1),
        payload: z.record(z.unknown()).default({})
      })
      .parse(request.body ?? {});

    const result = await manager.executeCloudCommand({
      id: payload.id,
      type: payload.type as any,
      payload: payload.payload
    });

    reply.code(result.ok ? 200 : 400);
    return result;
  });
}
