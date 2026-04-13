import type Database from "better-sqlite3";

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connector_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      meta_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS command_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cloud_command_id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      request_json TEXT,
      response_json TEXT,
      error_text TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);

  // v2 migration: add connection_id columns, prefix kv keys, insert default connection
  const versionRow = db
    .prepare(`SELECT value FROM kv_store WHERE key = '_schema_version'`)
    .get() as { value?: string } | undefined;
  const version = parseInt(versionRow?.value ?? "0", 10) || 0;

  if (version < 2) {
    const now = Date.now();

    // Add connection_id column to connector_events (no-op if already exists)
    try {
      db.exec(`ALTER TABLE connector_events ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'default'`);
    } catch {}

    // Add connection_id column to command_history (no-op if already exists)
    try {
      db.exec(`ALTER TABLE command_history ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'default'`);
    } catch {}

    // Prefix all existing kv keys that aren't already scoped or the version sentinel
    db.exec(`
      UPDATE kv_store
      SET key = 'default:' || key
      WHERE key NOT LIKE '%:%' AND key != '_schema_version'
    `);

    // Ensure the default connection record exists
    db.prepare(`INSERT OR IGNORE INTO connections (id, name, created_at) VALUES ('default', 'Default', ?)`)
      .run(now);

    // Bump schema version
    db.prepare(`
      INSERT INTO kv_store (key, value, updated_at) VALUES ('_schema_version', '2', ?)
      ON CONFLICT(key) DO UPDATE SET value = '2', updated_at = excluded.updated_at
    `).run(now);
  }
}
