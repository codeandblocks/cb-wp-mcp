/**
 * Code & Blocks WordPress MCP – workspaces (tenants)
 * Author: Code & Blocks by Marijan
 *
 * A workspace is one customer. It owns its sites, API keys, tokens, settings,
 * activity and approvals. The owner (operator) workspace is "intern".
 * Site credentials and API keys are stored encrypted (AES-256-GCM).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, type SiteConfig } from './config.js';
import { all, get, getMeta, run, setMeta, tx } from './db.js';
import { ctx, maybeCtx } from './context.js';
import { randomToken, seal, sha256, unseal, type Enc } from './crypto.js';

export const OWNER_WS = 'intern';

/** Tools that can require approval, with a description shown in the UI. */
export const APPROVAL_TOOLS: Record<string, string> = {
  delete_content: 'Inhalte endgültig löschen (force)',
  manage_plugin: 'Plugins installieren oder löschen',
  activate_theme: 'Theme wechseln',
  apply_copy: 'Entwurfskopie auf Live-Seite übertragen',
  file_delete: 'Dateien löschen',
  db_query: 'Datenbank schreiben',
  manage_updates: 'Updates installieren',
  manage_option: 'Optionen löschen',
  send_test_email: 'E-Mails senden',
  run_ability: 'Abilities mit Schreibzugriff ausführen',
  rest_request: 'Freie REST-Anfragen mit Schreibzugriff (POST, PUT, PATCH, DELETE)',
};

/** Tools the owner can block for a workspace. */
export const BLOCKABLE_TOOLS: Record<string, string> = {
  file_write: 'Dateien schreiben',
  file_edit: 'Dateien bearbeiten',
  file_delete: 'Dateien löschen',
  file_restore: 'Datei-Backups wiederherstellen',
  manage_snippet: 'PHP-Snippets',
  db_query: 'Datenbank-Abfragen',
  manage_option: 'WordPress-Optionen',
  manage_meta: 'Meta-Felder (Page-Builder, SEO)',
  manage_plugin: 'Plugins installieren/aktivieren',
  activate_theme: 'Theme wechseln',
  copy_theme: 'Theme kopieren',
  create_child_theme: 'Child-Theme anlegen',
  manage_updates: 'Updates',
  manage_cron: 'Cron-Jobs',
  send_test_email: 'Test-E-Mails',
  run_ability: 'Abilities ausführen',
  rest_request: 'Freie REST-Anfragen',
  site_settings: 'Seiteneinstellungen',
  delete_content: 'Inhalte löschen',
  apply_copy: 'Entwurfskopie live schalten',
  upload_media: 'Medien hochladen',
};

export interface WsSettings {
  readOnly: boolean;
  approvals: { enabled: boolean; tools: string[] };
  pii: { mask: boolean; allowPersonalData: boolean };
  retentionDays: number;
}

export interface WsCaps {
  forceReadOnly: boolean;
  blockedTools: string[];
}

const DEFAULT_SETTINGS: WsSettings = {
  readOnly: false,
  approvals: { enabled: true, tools: ['delete_content', 'manage_plugin', 'activate_theme', 'apply_copy', 'file_delete', 'db_query', 'manage_updates', 'rest_request'] },
  pii: { mask: true, allowPersonalData: false },
  retentionDays: 90,
};

const DEFAULT_CAPS: WsCaps = { forceReadOnly: false, blockedTools: [] };

export interface Workspace {
  id: string;
  name: string;
  isOwner: boolean;
  codeHint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SiteInfo {
  id: string;
  workspaceId: string;
  name: string;
  url: string;
  user: string;
  restBase?: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  default: boolean;
}

const nowIso = () => new Date().toISOString();

// ---------- runtime cache ----------
const siteCache = new Map<string, SiteConfig[]>();
const listeners: (() => void)[] = [];
function changed(wsId?: string) {
  if (wsId) siteCache.delete(wsId);
  else siteCache.clear();
  listeners.forEach((fn) => fn());
}
export function onChange(fn: () => void) {
  listeners.push(fn);
}

// ---------- workspaces ----------

function rowToWs(r: any): Workspace {
  return { id: r.id, name: r.name, isOwner: Boolean(r.is_owner), codeHint: r.code_hint ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listWorkspaces(): (Workspace & { sites: number; lastActivity?: string })[] {
  return all(
    `SELECT w.*, (SELECT COUNT(*) FROM sites s WHERE s.workspace_id = w.id) AS n,
            (SELECT MAX(ts) FROM activity a WHERE a.workspace_id = w.id) AS last
       FROM workspaces w ORDER BY w.is_owner DESC, w.name COLLATE NOCASE`,
  ).map((r: any) => ({ ...rowToWs(r), sites: r.n, lastActivity: r.last ?? undefined }));
}

export function getWorkspace(id: string): Workspace | undefined {
  const r = get('SELECT * FROM workspaces WHERE id = :id', { id });
  return r ? rowToWs(r) : undefined;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'kunde'
  );
}

function newCode(): string {
  // Readable code, e.g. CBX-7KQ2-M9PD-4TRW (~60 bits)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `CBX-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function createWorkspace(name: string): { workspace: Workspace; code: string } {
  let id = slug(name);
  let n = 2;
  while (get('SELECT 1 FROM workspaces WHERE id = :id', { id }) || id === OWNER_WS) id = `${slug(name)}-${n++}`;
  const code = newCode();
  const t = nowIso();
  run(
    `INSERT INTO workspaces (id, name, is_owner, code_hash, code_hint, settings, caps, created_at, updated_at)
     VALUES (:id, :name, 0, :hash, :hint, :settings, :caps, :t, :t)`,
    { id, name: name.slice(0, 80), hash: sha256(normCode(code)), hint: `…${code.slice(-4)}`, settings: JSON.stringify(DEFAULT_SETTINGS), caps: JSON.stringify(DEFAULT_CAPS), t },
  );
  return { workspace: getWorkspace(id)!, code };
}

export function renameWorkspace(id: string, name: string) {
  run('UPDATE workspaces SET name = :name, updated_at = :t WHERE id = :id', { id, name: name.slice(0, 80), t: nowIso() });
}

export function rotateConnectCode(id: string): string {
  const code = newCode();
  run('UPDATE workspaces SET code_hash = :hash, code_hint = :hint, updated_at = :t WHERE id = :id', { id, hash: sha256(normCode(code)), hint: `…${code.slice(-4)}`, t: nowIso() });
  return code;
}

export function disableConnectCode(id: string) {
  run('UPDATE workspaces SET code_hash = NULL, code_hint = NULL, updated_at = :t WHERE id = :id', { id, t: nowIso() });
}

export function workspaceByCode(code: string): Workspace | undefined {
  const n = normCode(code);
  if (n.length < 12) return undefined;
  const r = get('SELECT * FROM workspaces WHERE code_hash = :h', { h: sha256(n) });
  return r ? rowToWs(r) : undefined;
}

/** Remove a workspace and all its data. Returns the site list for revocation. */
export function deleteWorkspaceRows(id: string) {
  if (id === OWNER_WS) throw new Error('Der eigene Workspace kann nicht gelöscht werden.');
  tx(() => {
    for (const t of ['sites', 'secrets', 'tokens', 'activity', 'approvals', 'pii_tokens']) run(`DELETE FROM ${t} WHERE workspace_id = :id`, { id });
    run('DELETE FROM workspaces WHERE id = :id', { id });
  });
  changed(id);
}

// ---------- settings & caps ----------

function memo<T>(key: string, wsId: string, load: () => T): T {
  const c = maybeCtx();
  if (!c || c.workspaceId !== wsId) return load();
  c.memo ??= new Map();
  if (!c.memo.has(key)) c.memo.set(key, load());
  return c.memo.get(key) as T;
}

function forget(wsId: string) {
  const c = maybeCtx();
  if (c && c.workspaceId === wsId) c.memo?.clear();
}

export function getSettings(wsId = ctx().workspaceId): WsSettings {
  return memo('settings', wsId, () => loadSettings(wsId));
}

function loadSettings(wsId: string): WsSettings {
  const r = get<{ settings: string }>('SELECT settings FROM workspaces WHERE id = :id', { id: wsId });
  const s = r ? (JSON.parse(r.settings) as Partial<WsSettings>) : {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    approvals: { ...DEFAULT_SETTINGS.approvals, ...(s.approvals ?? {}) },
    pii: { ...DEFAULT_SETTINGS.pii, ...(s.pii ?? {}) },
  };
}

export function updateSettings(wsId: string, patch: Partial<WsSettings>) {
  const next = { ...getSettings(wsId), ...patch };
  next.approvals.tools = next.approvals.tools.filter((t) => t in APPROVAL_TOOLS);
  next.retentionDays = [30, 90, 180, 365].includes(next.retentionDays) ? next.retentionDays : 90;
  run('UPDATE workspaces SET settings = :s, updated_at = :t WHERE id = :id', { id: wsId, s: JSON.stringify(next), t: nowIso() });
  forget(wsId);
}

export function getCaps(wsId = ctx().workspaceId): WsCaps {
  return memo('caps', wsId, () => {
    const r = get<{ caps: string }>('SELECT caps FROM workspaces WHERE id = :id', { id: wsId });
    return { ...DEFAULT_CAPS, ...(r ? (JSON.parse(r.caps) as Partial<WsCaps>) : {}) };
  });
}

export function updateCaps(wsId: string, caps: WsCaps) {
  const clean: WsCaps = { forceReadOnly: Boolean(caps.forceReadOnly), blockedTools: caps.blockedTools.filter((t) => t in BLOCKABLE_TOOLS) };
  run('UPDATE workspaces SET caps = :c, updated_at = :t WHERE id = :id', { id: wsId, c: JSON.stringify(clean), t: nowIso() });
  forget(wsId);
}

export function isReadOnly(wsId = ctx().workspaceId): boolean {
  return config.envReadOnly || getCaps(wsId).forceReadOnly || getSettings(wsId).readOnly;
}

export function isBlocked(tool: string, wsId = ctx().workspaceId): boolean {
  return getCaps(wsId).blockedTools.includes(tool);
}

// ---------- API keys (per workspace, never shared) ----------

export type KeyName = 'pexels' | 'unsplash';

export function setKey(wsId: string, name: KeyName, value: string | null) {
  if (!value) run('DELETE FROM secrets WHERE workspace_id = :ws AND name = :name', { ws: wsId, name });
  else run('INSERT INTO secrets (workspace_id, name, value) VALUES (:ws, :name, :v) ON CONFLICT(workspace_id, name) DO UPDATE SET value = excluded.value', { ws: wsId, name, v: seal(value) });
}

export function getKey(name: KeyName, wsId = ctx().workspaceId): string | undefined {
  const r = get<{ value: string }>('SELECT value FROM secrets WHERE workspace_id = :ws AND name = :name', { ws: wsId, name });
  if (r) {
    try {
      return unseal(r.value);
    } catch {
      return undefined;
    }
  }
  // Keys from environment variables belong to the operator only.
  if (wsId === OWNER_WS) return (name === 'pexels' ? process.env.PEXELS_API_KEY : process.env.UNSPLASH_ACCESS_KEY)?.trim() || undefined;
  return undefined;
}

export function keyStatus(wsId: string) {
  const has = (n: KeyName) => Boolean(get('SELECT 1 FROM secrets WHERE workspace_id = :ws AND name = :n', { ws: wsId, n }));
  const env = (n: KeyName) => wsId === OWNER_WS && Boolean(n === 'pexels' ? process.env.PEXELS_API_KEY : process.env.UNSPLASH_ACCESS_KEY);
  return { pexels: has('pexels') || env('pexels'), pexelsEnv: !has('pexels') && env('pexels'), unsplash: has('unsplash') || env('unsplash'), unsplashEnv: !has('unsplash') && env('unsplash') };
}

// ---------- sites ----------

function rowToSite(r: any, first: boolean): SiteInfo {
  return { id: r.id, workspaceId: r.workspace_id, name: r.name, url: r.url, user: r.user, restBase: r.rest_base ?? undefined, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at, default: first };
}

export function listSites(wsId = ctx().workspaceId): SiteInfo[] {
  return all('SELECT * FROM sites WHERE workspace_id = :ws ORDER BY position, created_at', { ws: wsId }).map((r, i) => rowToSite(r, i === 0));
}

export function getSite(id: string, wsId = ctx().workspaceId): SiteInfo | undefined {
  return listSites(wsId).find((s) => s.id === id);
}

export const normUrl = (u: string) => u.trim().replace(/\/+$/, '').replace(/^http:\/\//i, 'https://').toLowerCase();

/** Look a site up by its URL across all workspaces (for SSO and connect). */
export function siteByUrl(url: string): SiteInfo | undefined {
  const target = normUrl(url);
  const rows = all('SELECT * FROM sites');
  const r = rows.find((x: any) => normUrl(x.url) === target || normUrl(x.url).replace('://www.', '://') === target.replace('://www.', '://'));
  return r ? rowToSite(r, false) : undefined;
}

/** Decrypted credentials for the tools (current workspace only). */
export function runtimeSites(wsId = ctx().workspaceId): SiteConfig[] {
  const cached = siteCache.get(wsId);
  if (cached) return cached;
  const out: SiteConfig[] = [];
  for (const r of all<any>('SELECT * FROM sites WHERE workspace_id = :ws ORDER BY position, created_at', { ws: wsId })) {
    try {
      out.push({ id: r.id, url: r.url, user: r.user, appPassword: unseal(r.secret).replace(/\s+/g, ''), restBase: (r.rest_base ?? `${r.url}/wp-json`).replace(/\/+$/, '') });
    } catch {
      console.warn(`[workspaces] cannot decrypt site "${r.id}" – was SECRET_KEY or secret.key changed?`);
    }
  }
  siteCache.set(wsId, out);
  return out;
}

function siteSlug(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, '');
  const base = (host.split('.').slice(0, -1).join('-') || host).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
  let id = base;
  let n = 2;
  while (get('SELECT 1 FROM sites WHERE id = :id', { id })) id = `${base}-${n++}`.slice(0, 44);
  return id;
}

export class SiteConflictError extends Error {}

export function upsertSite(wsId: string, input: { name?: string; url: string; user: string; appPassword: string; restBase?: string; source?: string }): string {
  const url = input.url.replace(/\/+$/, '');
  const existing = siteByUrl(url);
  const t = nowIso();
  if (existing && existing.workspaceId !== wsId) {
    throw new SiteConflictError('Diese Seite ist bereits mit einem anderen Kundenkonto verbunden. Bitte zuerst dort trennen.');
  }
  if (existing) {
    run('UPDATE sites SET url = :url, user = :user, secret = :secret, name = COALESCE(:name, name), rest_base = COALESCE(:rb, rest_base), source = :src, updated_at = :t WHERE id = :id', {
      id: existing.id,
      url,
      user: input.user,
      secret: seal(input.appPassword),
      name: input.name ?? null,
      rb: input.restBase ?? null,
      src: input.source ?? 'ui',
      t,
    });
    changed(wsId);
    return existing.id;
  }
  const id = siteSlug(url);
  const pos = (get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM sites WHERE workspace_id = :ws', { ws: wsId })?.p ?? 0) as number;
  run(
    `INSERT INTO sites (id, workspace_id, name, url, user, secret, rest_base, position, source, created_at, updated_at)
     VALUES (:id, :ws, :name, :url, :user, :secret, :rb, :pos, :src, :t, :t)`,
    { id, ws: wsId, name: input.name || new URL(url).hostname, url, user: input.user, secret: seal(input.appPassword), rb: input.restBase, pos, src: input.source ?? 'ui', t },
  );
  changed(wsId);
  return id;
}

export function renameSite(wsId: string, id: string, name: string) {
  run('UPDATE sites SET name = :name, updated_at = :t WHERE id = :id AND workspace_id = :ws', { id, ws: wsId, name: name.slice(0, 80), t: nowIso() });
  changed(wsId);
}

export function makeDefault(wsId: string, id: string) {
  const ids = listSites(wsId).map((s) => s.id);
  if (!ids.includes(id)) return;
  const order = [id, ...ids.filter((x) => x !== id)];
  tx(() => order.forEach((sid, i) => run('UPDATE sites SET position = :p WHERE id = :id AND workspace_id = :ws', { p: i, id: sid, ws: wsId })));
  changed(wsId);
}

export function removeSite(wsId: string, id: string): boolean {
  const r = run('DELETE FROM sites WHERE id = :id AND workspace_id = :ws', { id, ws: wsId });
  if (r.changes) {
    const removed = JSON.parse(getMeta('env_removed') ?? '[]') as string[];
    if (config.envSites.some((e) => e.id === id) && !removed.includes(id)) setMeta('env_removed', JSON.stringify([...removed, id]));
  }
  changed(wsId);
  return Boolean(r.changes);
}

// ---------- static tokens (Claude Code, scripts) ----------

export const TOKEN_DAYS = [30, 90, 180, 365];

export function createStaticToken(wsId: string, label: string, actor: string, days = 365): string {
  const token = `cbx_${randomToken(32)}`;
  const d = TOKEN_DAYS.includes(days) ? days : 365;
  run('INSERT INTO tokens (hash, workspace_id, kind, actor, label, hint, expires_at, created_at) VALUES (:h, :ws, \'static\', :actor, :label, :hint, :exp, :t)', {
    h: sha256(token),
    ws: wsId,
    actor,
    label: label.slice(0, 60) || 'Token',
    hint: `${token.slice(0, 8)}…${token.slice(-4)}`,
    exp: Math.floor(Date.now() / 1000) + d * 86400,
    t: nowIso(),
  });
  return token;
}

export function listStaticTokens(wsId: string) {
  return all<{ hash: string; label: string; hint: string; created_at: string; actor: string; expires_at: number | null; last_used_at: number | null }>(
    "SELECT hash, label, hint, created_at, actor, expires_at, last_used_at FROM tokens WHERE workspace_id = :ws AND kind = 'static' ORDER BY created_at DESC",
    { ws: wsId },
  ).map((t) => ({ id: t.hash.slice(0, 16), label: t.label, hint: t.hint, created: t.created_at, actor: t.actor, expires: t.expires_at ?? undefined, lastUsed: t.last_used_at ?? undefined }));
}

export function deleteStaticToken(wsId: string, id: string) {
  run("DELETE FROM tokens WHERE workspace_id = :ws AND kind = 'static' AND substr(hash, 1, 16) = :id", { ws: wsId, id });
}

// ---------- start-up: create owner workspace, migrate 1.2 data ----------

export function initWorkspaces() {
  if (!getWorkspace(OWNER_WS)) {
    const t = nowIso();
    run(`INSERT INTO workspaces (id, name, is_owner, settings, caps, created_at, updated_at) VALUES (:id, 'Code & Blocks (intern)', 1, :s, :c, :t, :t)`, {
      id: OWNER_WS,
      s: JSON.stringify(DEFAULT_SETTINGS),
      c: JSON.stringify(DEFAULT_CAPS),
      t,
    });
  }
  migrateFromV12();
  importEnvSites();
  // 1.3.1: free REST requests with write access need approval (closes a bypass of the other approvals).
  if (!getMeta('v131_rest_approval')) {
    for (const w of all<{ id: string }>('SELECT id FROM workspaces')) {
      const st = getSettings(w.id);
      if (!st.approvals.tools.includes('rest_request')) updateSettings(w.id, { approvals: { ...st.approvals, tools: [...st.approvals.tools, 'rest_request'] } });
    }
    setMeta('v131_rest_approval', nowIso());
  }
}

function importEnvSites() {
  const removed = JSON.parse(getMeta('env_removed') ?? '[]') as string[];
  let n = 0;
  for (const s of config.envSites) {
    if (removed.includes(s.id) || siteByUrl(s.url)) continue;
    const t = nowIso();
    let id = s.id;
    if (get('SELECT 1 FROM sites WHERE id = :id', { id })) id = siteSlug(s.url);
    run(
      `INSERT INTO sites (id, workspace_id, name, url, user, secret, rest_base, position, source, created_at, updated_at)
       VALUES (:id, :ws, :name, :url, :user, :secret, :rb, 99, 'env', :t, :t)`,
      { id, ws: OWNER_WS, name: s.id, url: s.url, user: s.user, secret: seal(s.appPassword), rb: s.restBase === `${s.url}/wp-json` ? null : s.restBase, t },
    );
    n++;
  }
  if (n) console.log(`[workspaces] imported ${n} site(s) from environment variables into the owner workspace`);
}

/** One-time import of the JSON files written by version 1.2 into the owner workspace. */
function migrateFromV12() {
  if (getMeta('migrated_v12')) return;
  const dir = config.dataDir;
  const read = (f: string) => {
    const p = path.join(dir, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
  };
  const summary: string[] = [];
  try {
    tx(() => {
      const storeRaw = read('store.json');
      if (storeRaw) {
        const st = JSON.parse(storeRaw) as any;
        for (const s of st.sites ?? []) {
          if (siteByUrl(s.url)) continue;
          run(
            `INSERT INTO sites (id, workspace_id, name, url, user, secret, rest_base, position, source, created_at, updated_at)
             VALUES (:id, :ws, :name, :url, :user, :secret, :rb, :pos, :src, :c, :u)`,
            { id: s.id, ws: OWNER_WS, name: s.name ?? s.id, url: s.url, user: s.user, secret: JSON.stringify(s.secret as Enc), rb: s.restBase, pos: summary.length, src: s.source ?? 'ui', c: s.createdAt ?? nowIso(), u: s.updatedAt ?? nowIso() },
          );
        }
        if (st.removedEnvSites?.length) setMeta('env_removed', JSON.stringify(st.removedEnvSites));
        const set = st.settings ?? {};
        updateSettings(OWNER_WS, { readOnly: Boolean(set.readOnly), approvals: set.approvals ?? DEFAULT_SETTINGS.approvals });
        if (set.pexels) run("INSERT OR REPLACE INTO secrets (workspace_id, name, value) VALUES (:ws, 'pexels', :v)", { ws: OWNER_WS, v: JSON.stringify(set.pexels) });
        if (set.unsplash) run("INSERT OR REPLACE INTO secrets (workspace_id, name, value) VALUES (:ws, 'unsplash', :v)", { ws: OWNER_WS, v: JSON.stringify(set.unsplash) });
        if (set.tokenHash) run("INSERT OR IGNORE INTO tokens (hash, workspace_id, kind, actor, label, hint, created_at) VALUES (:h, :ws, 'static', 'owner', 'Token (1.2)', :hint, :t)", { h: set.tokenHash, ws: OWNER_WS, hint: set.tokenHint ?? '', t: nowIso() });
        summary.push(`${(st.sites ?? []).length} site(s), settings, keys`);
      }
      const oauthRaw = read('oauth.json');
      if (oauthRaw) {
        const o = JSON.parse(oauthRaw) as any;
        for (const c of Object.values(o.clients ?? {}) as any[]) run('INSERT OR IGNORE INTO oauth_clients (client_id, data, issued_at) VALUES (:id, :d, :i)', { id: c.client_id, d: JSON.stringify(c), i: c.client_id_issued_at ?? null });
        for (const [kind, store] of [['access', o.access ?? {}], ['refresh', o.refresh ?? {}]] as const) {
          for (const [hash, r] of Object.entries(store as Record<string, any>)) {
            run('INSERT OR IGNORE INTO tokens (hash, workspace_id, kind, client_id, actor, scopes, resource, expires_at, created_at) VALUES (:h, :ws, :k, :cid, \'owner\', :sc, :res, :exp, :t)', {
              h: hash,
              ws: OWNER_WS,
              k: kind,
              cid: r.clientId,
              sc: JSON.stringify(r.scopes ?? []),
              res: r.resource ?? null,
              exp: r.expiresAt,
              t: nowIso(),
            });
          }
        }
        summary.push('OAuth sessions');
      }
      const actRaw = read('activity.jsonl');
      if (actRaw) {
        let n = 0;
        for (const line of actRaw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            run(
              `INSERT INTO activity (workspace_id, ts, site, tool, kind, status, summary, source, actor, link, edit_link, object_type, object_id, ms)
               VALUES (:ws, :ts, :site, :tool, :kind, :status, :summary, :source, 'owner', :link, :edit, :ot, :oid, :ms)`,
              { ws: OWNER_WS, ts: e.ts, site: e.site, tool: e.tool, kind: e.kind, status: e.status, summary: e.summary, source: e.source, link: e.link, edit: e.edit_link, ot: e.object_type, oid: e.object_id, ms: e.ms },
            );
            n++;
          } catch {
            /* skip broken line */
          }
        }
        summary.push(`${n} activity entries`);
      }
      setMeta('migrated_v12', nowIso());
    });
    for (const f of ['store.json', 'oauth.json', 'activity.jsonl', 'approvals.json']) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) fs.renameSync(p, `${p}.migrated`);
    }
    if (summary.length) console.log(`[workspaces] migrated data from 1.2: ${summary.join(', ')}`);
  } catch (e) {
    console.error('[workspaces] migration from 1.2 failed – old files left untouched:', e);
  }
}
