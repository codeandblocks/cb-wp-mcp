/**
 * Code & Blocks WordPress MCP – SQLite database (node:sqlite)
 * Author: Code & Blocks by Marijan
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

let db: DatabaseSync;

type Params = Record<string, unknown> | unknown[];

function norm(v: unknown): any {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function bind(p?: Params): any[] {
  if (!p) return [];
  if (Array.isArray(p)) return p.map(norm);
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) o[k] = norm(v);
  return [o];
}

export function run(sql: string, p?: Params) {
  return db.prepare(sql).run(...bind(p));
}

export function get<T = Record<string, any>>(sql: string, p?: Params): T | undefined {
  return db.prepare(sql).get(...bind(p)) as T | undefined;
}

export function all<T = Record<string, any>>(sql: string, p?: Params): T[] {
  return db.prepare(sql).all(...bind(p)) as T[];
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const MIGRATIONS: string[] = [
  // 1 – workspaces (tenants) and everything that belongs to them
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_owner INTEGER NOT NULL DEFAULT 0,
    code_hash TEXT,
    code_hint TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    caps TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE sites (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    user TEXT NOT NULL,
    secret TEXT NOT NULL,
    rest_base TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'ui',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX sites_ws ON sites(workspace_id);
  CREATE TABLE secrets (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (workspace_id, name)
  );
  CREATE TABLE tokens (
    hash TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    client_id TEXT,
    actor TEXT,
    label TEXT,
    hint TEXT,
    scopes TEXT,
    resource TEXT,
    expires_at INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX tokens_ws ON tokens(workspace_id);
  CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, data TEXT NOT NULL, issued_at INTEGER);
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    site TEXT,
    tool TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    source TEXT NOT NULL,
    actor TEXT,
    link TEXT,
    edit_link TEXT,
    object_type TEXT,
    object_id INTEGER,
    ms INTEGER
  );
  CREATE INDEX activity_ws ON activity(workspace_id, id);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    site TEXT,
    summary TEXT NOT NULL,
    args TEXT NOT NULL,
    hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created TEXT NOT NULL,
    decided TEXT,
    decided_by TEXT
  );
  CREATE INDEX approvals_ws ON approvals(workspace_id, created);
  CREATE TABLE access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    workspace_id TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    ip TEXT,
    detail TEXT
  );
  CREATE INDEX access_ws ON access_log(workspace_id, id);
  CREATE TABLE deletion_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    actor TEXT NOT NULL,
    detail TEXT
  );
  CREATE TABLE pii_tokens (
    workspace_id TEXT NOT NULL,
    token TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, token)
  );
  `,
];

function migrate() {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
    console.log(`[db] migrated to schema ${v + 1}`);
  }
}

export function initDb(file = path.join(config.dataDir, 'cbmcp.sqlite')) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate();
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}

export function getMeta(key: string): string | undefined {
  return get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { key })?.value;
}

export function setMeta(key: string, value: string | null) {
  if (value === null) run('DELETE FROM meta WHERE key = :key', { key });
  else run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { key, value });
}
