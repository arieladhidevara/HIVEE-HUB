import type { DB } from "./db.js";
import { nowTs } from "../utils/time.js";
import type { ConnectorEvent, OpenClawConfig, OpenClawSnapshot, PairingState } from "../types/domain.js";

function setJson(db: DB, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), nowTs());
}

function getJson<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare(`SELECT value FROM kv_store WHERE key = ?`).get(key) as { value?: string } | undefined;
  if (!row?.value) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function savePairingState(db: DB, state: PairingState): void {
  setJson(db, "pairing_state", state);
}

export function loadPairingState(db: DB): PairingState {
  return getJson<PairingState>(db, "pairing_state", {
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

export function saveOpenClawSnapshot(db: DB, snapshot: OpenClawSnapshot): void {
  setJson(db, "openclaw_snapshot", snapshot);
}

export function saveOpenClawConfig(db: DB, config: OpenClawConfig): void {
  setJson(db, "openclaw_config", config);
}

export function loadOpenClawConfig(db: DB, fallback: OpenClawConfig): OpenClawConfig {
  return getJson<OpenClawConfig>(db, "openclaw_config", fallback);
}

export function loadOpenClawSnapshot(db: DB): OpenClawSnapshot {
  return getJson<OpenClawSnapshot>(db, "openclaw_snapshot", {
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

export function saveCursor(db: DB, cursor: string | null): void {
  setJson(db, "cloud_cursor", { cursor, updatedAt: nowTs() });
}

export function loadCursor(db: DB): string | null {
  const payload = getJson<{ cursor: string | null }>(db, "cloud_cursor", { cursor: null });
  return payload.cursor;
}

export function appendEvent(db: DB, level: "info" | "warn" | "error", kind: string, message: string, meta?: unknown): void {
  db.prepare(
    `INSERT INTO connector_events (level, kind, message, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(level, kind, message, meta ? JSON.stringify(meta) : null, nowTs());
}

export function recentEvents(db: DB, limit = 50): ConnectorEvent[] {
  const rows = db
    .prepare(`SELECT id, level, kind, message, meta_json, created_at FROM connector_events ORDER BY id DESC LIMIT ?`)
    .all(limit) as Array<{
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

export function upsertCommandHistory(
  db: DB,
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
        cloud_command_id, type, status, request_json, response_json, error_text, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cloud_command_id) DO UPDATE SET
        type = excluded.type,
        status = excluded.status,
        request_json = excluded.request_json,
        response_json = excluded.response_json,
        error_text = excluded.error_text,
        updated_at = excluded.updated_at`
  ).run(
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
