import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ConnectionRegistry } from "../services/connectionRegistry.js";
import type { ConnectorManager } from "../services/connectorManager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveManager(registry: ConnectionRegistry, id: string): ConnectorManager | null {
  return registry.get(id);
}

function configPayloadSchema() {
  return z.object({
    baseUrl: z.string().optional(),
    discoveryCandidates: z.string().optional(),
    token: z.string().optional(),
    transport: z.enum(["auto", "ws", "http"]).optional(),
    wsPath: z.string().optional(),
    requestTimeoutMs: z.coerce.number().int().min(1000).max(120000).optional()
  });
}

// ---------------------------------------------------------------------------
// Per-connection route handler (reusable for both legacy and new routes)
// ---------------------------------------------------------------------------

async function registerConnectionRoutes(
  app: FastifyInstance,
  prefix: string,
  getManager: (request: any) => ConnectorManager | null
): Promise<void> {
  app.get(`${prefix}/status`, async (request, reply) => {
    const manager = getManager(request);
    if (!manager) { reply.code(404); return { error: "Connection not found" }; }
    return manager.status();
  });

  app.get(`${prefix}/openclaw/config`, async (request, reply) => {
    const manager = getManager(request);
    if (!manager) { reply.code(404); return { error: "Connection not found" }; }
    return { ok: true, config: manager.getOpenClawConfig() };
  });

  app.post(`${prefix}/openclaw/config`, async (request, reply) => {
    const manager = getManager(request);
    if (!manager) { reply.code(404); return { error: "Connection not found" }; }
    const payload = configPayloadSchema().parse(request.body ?? {});
    try {
      const config = manager.updateOpenClawConfig(payload);
      const snapshot = await manager.discoverOpenClaw();
      return { ok: snapshot.healthy, config, snapshot };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post(`${prefix}/openclaw/config/reset`, async (request, reply) => {
    const manager = getManager(request);
    if (!manager) { reply.code(404); return { error: "Connection not found" }; }
    try {
      const config = manager.resetOpenClawConfig();
      const snapshot = await manager.discoverOpenClaw();
      return { ok: snapshot.healthy, config, snapshot };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post(`${prefix}/pairing/start`, async (request, reply) => {
    const manager = getManager(request);
    if (!manager) { reply.code(404); return { error: "Connection not found" }; }
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

  app.post(`${prefix}/pairing/clear`, async (request, reply) => {
    const manager = getManager(request);
    if (!manager) { reply.code(404); return { error: "Connection not found" }; }
    return { ok: true, state: manager.clearPairing() };
  });

  app.post(`${prefix}/openclaw/discover`, async (request, reply) => {
    const manager = getManager(request);
    if (!manager) { reply.code(404); return { error: "Connection not found" }; }
    const snapshot = await manager.discoverOpenClaw();
    return { ok: snapshot.healthy, snapshot };
  });

  app.post(`${prefix}/openclaw/discover/docker`, async (request, reply) => {
    const manager = getManager(request);
    if (!manager) { reply.code(404); return { error: "Connection not found" }; }
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

  app.post(`${prefix}/commands/execute`, async (request, reply) => {
    const manager = getManager(request);
    if (!manager) { reply.code(404); return { error: "Connection not found" }; }
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

// ---------------------------------------------------------------------------
// Main registration
// ---------------------------------------------------------------------------

export async function registerApiRoutes(app: FastifyInstance, registry: ConnectionRegistry): Promise<void> {
  app.get("/health", async () => ({ ok: true, service: "hivee-connector", version: "0.1.0", now: Date.now() }));

  // ---------------------------------------------------------------------------
  // Connections management
  // ---------------------------------------------------------------------------

  app.get("/api/connections", async () => {
    return { connections: registry.list() };
  });

  app.post("/api/connections", async (request, reply) => {
    const payload = z
      .object({ name: z.string().min(1).max(80).default("New Connection") })
      .parse(request.body ?? {});
    const id = await registry.create(payload.name);
    const manager = registry.get(id)!;
    reply.code(201);
    return { ok: true, id, status: manager.status() };
  });

  app.delete("/api/connections/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id === "default") {
      reply.code(400);
      return { ok: false, error: "Cannot delete the default connection" };
    }
    await registry.delete(id);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Connection-scoped routes: /api/connections/:id/*
  // ---------------------------------------------------------------------------

  await registerConnectionRoutes(
    app,
    "/api/connections/:id",
    (request) => resolveManager(registry, (request.params as { id: string }).id)
  );

  // ---------------------------------------------------------------------------
  // Legacy (backward-compat) routes — all proxy to 'default' connection
  // ---------------------------------------------------------------------------

  app.get("/api/status", async () => registry.getDefault().status());

  await registerConnectionRoutes(
    app,
    "/api",
    () => registry.getDefault()
  );
}
