import type { DB } from "./db.js";
import { nowTs } from "../utils/time.js";
import type { Connection, ConnectorEvent, OpenClawConfig, OpenClawSnapshot, PairingState } from "../types/domain.js";

// ---------------------------------------------------------------------------
// KV helpers (scoped by connectionId)
// ---------------------------------------------------------------------------

function setJson(db: DB, connectionId: string, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(`${connectionId}:${key}`, JSON.stringify(value), nowTs());
}

function getJson<T>(db: DB, connectionId: string, key: string, fallback: T): T {
  const row = db
    .prepare(`SELECT value FROM kv_store WHERE key = ?`)
    .get(`${connectionId}:${key}`) as { value?: string } | undefined;
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

function deleteByPrefix(db: DB, connectionId: string): void {
  db.prepare(`DELETE FROM kv_store WHERE key LIKE ?`).run(`${connectionId}:%`);
}

// ---------------------------------------------------------------------------
// Pairing state
// ---------------------------------------------------------------------------

export function savePairingState(db: DB, connectionId: string, state: PairingState): void {
  setJson(db, connectionId, "pairing_state", state);
}

export function loadPairingState(db: DB, connectionId: string): PairingState {
  return getJson<PairingState>(db, connectionId, "pairing_state", {
    connectorId: null,
    connectorSecret: null,
    cloudBaseUrl: null,
    pairingToken: null,
    status: "unpaired",
    lastError: null,
    heartbeatIntervalSec: 15,
    commandPollIntervalSec: 5,
    updatedAt: null
  });
}

// ---------------------------------------------------------------------------
// OpenClaw config + snapshot
// ---------------------------------------------------------------------------

export function saveOpenClawSnapshot(db: DB, connectionId: string, snapshot: OpenClawSnapshot): void {
  setJson(db, connectionId, "openclaw_snapshot", snapshot);
}

export function saveOpenClawConfig(db: DB, connectionId: string, config: OpenClawConfig): void {
  setJson(db, connectionId, "openclaw_config", config);
}

export function loadOpenClawConfig(db: DB, connectionId: string, fallback: OpenClawConfig): OpenClawConfig {
  return getJson<OpenClawConfig>(db, connectionId, "openclaw_config", fallback);
}

export function loadOpenClawSnapshot(db: DB, connectionId: string): OpenClawSnapshot {
  return getJson<OpenClawSnapshot>(db, connectionId, "openclaw_snapshot", {
    baseUrl: null,
    tokenPresent: false,
    transport: "auto",
    healthy: false,
    agents: [],
    models: [],
    lastError: null,
    wsCandidates: [],
    updatedAt: null
  });
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export function saveCursor(db: DB, connectionId: string, cursor: string | null): void {
  setJson(db, connectionId, "cloud_cursor", { cursor, updatedAt: nowTs() });
}

export function loadCursor(db: DB, connectionId: string): string | null {
  const payload = getJson<{ cursor: string | null }>(db, connectionId, "cloud_cursor", { cursor: null });
  return payload.cursor;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function appendEvent(
  db: DB,
  connectionId: string,
  level: "info" | "warn" | "error",
  kind: string,
  message: string,
  meta?: unknown
): void {
  db.prepare(
    `INSERT INTO connector_events (connection_id, level, kind, message, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(connectionId, level, kind, message, meta ? JSON.stringify(meta) : null, nowTs());
}

export function recentEvents(db: DB, connectionId: string, limit = 50): ConnectorEvent[] {
  const rows = db
    .prepare(
      `SELECT id, level, kind, message, meta_json, created_at
       FROM connector_events
       WHERE connection_id = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(connectionId, limit) as Array<{
      id: number;
      level: "info" | "warn" | "error";
      kind: string;
      message: string;
      meta_json: string | null;
      created_at: number;
    }>;
  return rows.map((row) => ({
    id: row.id,
    level: row.level,
    kind: row.kind,
    message: row.message,
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
    createdAt: row.created_at
  }));
}

// ---------------------------------------------------------------------------
// Command history
// ---------------------------------------------------------------------------

export function upsertCommandHistory(
  db: DB,
  connectionId: string,
  input: {
    cloudCommandId: string;
    type: string;
    status: string;
    requestJson?: unknown;
    responseJson?: unknown;
    errorText?: string | null;
  }
): void {
  const now = nowTs();
  db.prepare(
    `INSERT INTO command_history (
        connection_id, cloud_command_id, type, status, request_json, response_json, error_text, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cloud_command_id) DO UPDATE SET
        type = excluded.type,
        status = excluded.status,
        request_json = excluded.request_json,
        response_json = excluded.response_json,
        error_text = excluded.error_text,
        updated_at = excluded.updated_at`
  ).run(
    connectionId,
    input.cloudCommandId,
    input.type,
    input.status,
    input.requestJson ? JSON.stringify(input.requestJson) : null,
    input.responseJson ? JSON.stringify(input.responseJson) : null,
    input.errorText ?? null,
    now,
    now
  );
}

// ---------------------------------------------------------------------------
// Connection CRUD
// ---------------------------------------------------------------------------

export function listConnections(db: DB): Connection[] {
  const rows = db
    .prepare(`SELECT id, name, created_at FROM connections ORDER BY created_at ASC`)
    .all() as Array<{ id: string; name: string; created_at: number }>;
  return rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at }));
}

export function getConnection(db: DB, id: string): Connection | null {
  const row = db
    .prepare(`SELECT id, name, created_at FROM connections WHERE id = ?`)
    .get(id) as { id: string; name: string; created_at: number } | undefined;
  if (!row) return null;
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

export function createConnection(db: DB, id: string, name: string): Connection {
  const now = nowTs();
  db.prepare(`INSERT OR IGNORE INTO connections (id, name, created_at) VALUES (?, ?, ?)`).run(id, name, now);
  return { id, name, createdAt: now };
}

export function connectionHasData(db: DB, id: string): boolean {
  const kvRow = db
    .prepare(`SELECT 1 AS ok FROM kv_store WHERE key LIKE ? LIMIT 1`)
    .get(`${id}:%`) as { ok: number } | undefined;
  if (kvRow) return true;

  const eventRow = db
    .prepare(`SELECT 1 AS ok FROM connector_events WHERE connection_id = ? LIMIT 1`)
    .get(id) as { ok: number } | undefined;
  if (eventRow) return true;

  const historyRow = db
    .prepare(`SELECT 1 AS ok FROM command_history WHERE connection_id = ? LIMIT 1`)
    .get(id) as { ok: number } | undefined;
  return Boolean(historyRow);
}

export function renameConnectionData(db: DB, fromId: string, toId: string, nextName: string): void {
  if (fromId === toId) {
    db.prepare(`UPDATE connections SET name = ? WHERE id = ?`).run(nextName, fromId);
    return;
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE connections SET id = ?, name = ? WHERE id = ?`).run(toId, nextName, fromId);
    db.prepare(
      `UPDATE kv_store
       SET key = ? || substr(key, length(?) + 1)
       WHERE key LIKE ?`
    ).run(toId, fromId, `${fromId}:%`);
    db.prepare(`UPDATE connector_events SET connection_id = ? WHERE connection_id = ?`).run(toId, fromId);
    db.prepare(`UPDATE command_history SET connection_id = ? WHERE connection_id = ?`).run(toId, fromId);
  });

  tx();
}

export function deleteConnectionData(db: DB, id: string): void {
  db.prepare(`DELETE FROM connections WHERE id = ?`).run(id);
  deleteByPrefix(db, id);
  db.prepare(`DELETE FROM connector_events WHERE connection_id = ?`).run(id);
  db.prepare(`DELETE FROM command_history WHERE connection_id = ?`).run(id);
}
