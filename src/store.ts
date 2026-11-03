/**
 * Code & Blocks WordPress MCP – encrypted settings store
 * Author: Code & Blocks by Marijan
 *
 * Sites (with their Application Passwords), API keys and UI settings live in
 * DATA_DIR/store.json. Secrets are encrypted with AES-256-GCM. The key comes
 * from SECRET_KEY or is generated once into DATA_DIR/secret.key.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, type SiteConfig } from './config.js';

interface Enc {
  iv: string;
  tag: string;
  data: string;
}

export interface StoredSite {
  id: string;
  name: string;
  url: string;
  user: string;
  secret: Enc;
  restBase?: string;
  source: 'ui' | 'env';
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalSettings {
  enabled: boolean;
  tools: string[];
}

interface StoreData {
  version: 1;
  sites: StoredSite[];
  removedEnvSites: string[];
  settings: {
    readOnly: boolean;
    pexels?: Enc;
    unsplash?: Enc;
    tokenHash?: string;
    tokenHint?: string;
    approvals: ApprovalSettings;
  };
}

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
};

const DEFAULT_APPROVALS: ApprovalSettings = {
  enabled: true,
  tools: ['delete_content', 'manage_plugin', 'activate_theme', 'apply_copy', 'file_delete', 'db_query', 'manage_updates'],
};

const FILE = () => path.join(config.dataDir, 'store.json');
let key: Buffer;
let data: StoreData;
const listeners: (() => void)[] = [];

function loadKey(): Buffer {
  if (config.secretKey) return crypto.createHash('sha256').update(config.secretKey).digest();
  const f = path.join(config.dataDir, 'secret.key');
  try {
    if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
    fs.mkdirSync(config.dataDir, { recursive: true });
    const k = crypto.randomBytes(32);
    fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 });
    return k;
  } catch (e) {
    console.warn(`[store] cannot persist ${f} (${(e as Error).message}); using a temporary key – connected sites will be lost on restart`);
    return crypto.randomBytes(32);
  }
}

export function encrypt(plain: string): Enc {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: out.toString('base64') };
}

export function decrypt(e: Enc): string {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
}

function save() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${FILE()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE());
  } catch (e) {
    console.warn(`[store] cannot write ${FILE()}: ${(e as Error).message}`);
  }
}

/** Push store state into the runtime config used by the tools. */
function apply() {
  const sites: SiteConfig[] = [];
  for (const s of data.sites) {
    try {
      sites.push({
        id: s.id,
        url: s.url,
        user: s.user,
        appPassword: decrypt(s.secret).replace(/\s+/g, ''),
        restBase: (s.restBase ?? `${s.url}/wp-json`).replace(/\/+$/, ''),
      });
    } catch {
      console.warn(`[store] cannot decrypt site "${s.id}" – was SECRET_KEY or secret.key changed?`);
    }
  }
  config.sites.splice(0, config.sites.length, ...sites);
  config.readOnly = config.envReadOnly || data.settings.readOnly;
  const dec = (e?: Enc) => {
    try {
      return e ? decrypt(e) : undefined;
    } catch {
      return undefined;
    }
  };
  config.pexelsApiKey = dec(data.settings.pexels) ?? process.env.PEXELS_API_KEY?.trim() ?? undefined;
  config.unsplashAccessKey = dec(data.settings.unsplash) ?? process.env.UNSPLASH_ACCESS_KEY?.trim() ?? undefined;
  listeners.forEach((fn) => fn());
}

export function onChange(fn: () => void) {
  listeners.push(fn);
}

export function initStore() {
  key = loadKey();
  data = { version: 1, sites: [], removedEnvSites: [], settings: { readOnly: false, approvals: { ...DEFAULT_APPROVALS } } };
  try {
    if (fs.existsSync(FILE())) {
      const parsed = JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Partial<StoreData>;
      data = {
        version: 1,
        sites: parsed.sites ?? [],
        removedEnvSites: parsed.removedEnvSites ?? [],
        settings: { readOnly: false, approvals: { ...DEFAULT_APPROVALS }, ...(parsed.settings ?? {}) },
      };
    }
  } catch (e) {
    console.warn(`[store] cannot read ${FILE()}: ${(e as Error).message}`);
  }

  // Import sites configured through environment variables (once).
  let imported = 0;
  for (const s of config.envSites) {
    if (data.sites.some((x) => x.id === s.id) || data.removedEnvSites.includes(s.id)) continue;
    const now = new Date().toISOString();
    data.sites.push({ id: s.id, name: s.id, url: s.url, user: s.user, secret: encrypt(s.appPassword), restBase: s.restBase, source: 'env', createdAt: now, updatedAt: now });
    imported++;
  }
  if (imported) {
    console.log(`[store] imported ${imported} site(s) from environment variables`);
    save();
  }
  apply();
}

// ---------- sites ----------

export function listSites(): (Omit<StoredSite, 'secret'> & { default: boolean })[] {
  return data.sites.map(({ secret: _s, ...rest }, i) => ({ ...rest, default: i === 0 }));
}

export function getSite(id: string) {
  return listSites().find((s) => s.id === id);
}

export function slugForUrl(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, '');
  const base = host.split('.').slice(0, -1).join('-') || host;
  let id = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
  let n = 2;
  while (data.sites.some((s) => s.id === id && s.url !== url)) id = `${base}-${n++}`.slice(0, 40);
  return id;
}

export function upsertSite(input: { id?: string; name?: string; url: string; user: string; appPassword: string; restBase?: string }) {
  const url = input.url.replace(/\/+$/, '');
  const existing = data.sites.find((s) => (input.id ? s.id === input.id : s.url === url));
  const now = new Date().toISOString();
  if (existing) {
    existing.url = url;
    existing.user = input.user;
    existing.secret = encrypt(input.appPassword);
    existing.name = input.name ?? existing.name;
    existing.restBase = input.restBase ?? existing.restBase;
    existing.source = 'ui';
    existing.updatedAt = now;
  } else {
    const id = input.id && /^[a-z0-9][a-z0-9_-]{0,40}$/i.test(input.id) ? input.id : slugForUrl(url);
    data.sites.push({ id, name: input.name || new URL(url).hostname, url, user: input.user, secret: encrypt(input.appPassword), restBase: input.restBase, source: 'ui', createdAt: now, updatedAt: now });
  }
  save();
  apply();
  return (existing ?? data.sites[data.sites.length - 1]).id;
}

export function renameSite(id: string, name: string) {
  const s = data.sites.find((x) => x.id === id);
  if (!s) return false;
  s.name = name.slice(0, 80) || s.name;
  s.updatedAt = new Date().toISOString();
  save();
  return true;
}

export function makeDefault(id: string) {
  const i = data.sites.findIndex((x) => x.id === id);
  if (i <= 0) return;
  const [s] = data.sites.splice(i, 1);
  data.sites.unshift(s);
  save();
  apply();
}

export function removeSite(id: string) {
  const s = data.sites.find((x) => x.id === id);
  if (!s) return false;
  data.sites = data.sites.filter((x) => x.id !== id);
  if (config.envSites.some((e) => e.id === id) && !data.removedEnvSites.includes(id)) data.removedEnvSites.push(id);
  save();
  apply();
  return true;
}

// ---------- settings ----------

export function getSettings() {
  return {
    readOnly: data.settings.readOnly,
    envReadOnly: config.envReadOnly,
    pexelsSet: Boolean(data.settings.pexels || process.env.PEXELS_API_KEY),
    pexelsFromEnv: !data.settings.pexels && Boolean(process.env.PEXELS_API_KEY),
    unsplashSet: Boolean(data.settings.unsplash || process.env.UNSPLASH_ACCESS_KEY),
    unsplashFromEnv: !data.settings.unsplash && Boolean(process.env.UNSPLASH_ACCESS_KEY),
    tokenHint: data.settings.tokenHint,
    approvals: data.settings.approvals,
  };
}

export function updateSettings(patch: { readOnly?: boolean; pexels?: string | null; unsplash?: string | null; approvals?: ApprovalSettings }) {
  if (patch.readOnly !== undefined) data.settings.readOnly = patch.readOnly;
  if (patch.pexels !== undefined) data.settings.pexels = patch.pexels ? encrypt(patch.pexels) : undefined;
  if (patch.unsplash !== undefined) data.settings.unsplash = patch.unsplash ? encrypt(patch.unsplash) : undefined;
  if (patch.approvals) {
    data.settings.approvals = {
      enabled: patch.approvals.enabled,
      tools: patch.approvals.tools.filter((t) => t in APPROVAL_TOOLS),
    };
  }
  save();
  apply();
}

export function approvalSettings(): ApprovalSettings {
  return data.settings.approvals;
}

/** Create a new static MCP token (shown once). */
export function rotateToken(): string {
  const token = crypto.randomBytes(32).toString('hex');
  data.settings.tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  data.settings.tokenHint = `${token.slice(0, 4)}…${token.slice(-4)}`;
  save();
  return token;
}

export function clearToken() {
  delete data.settings.tokenHash;
  delete data.settings.tokenHint;
  save();
}

export function checkStoredToken(token: string): boolean {
  if (!data?.settings.tokenHash) return false;
  const a = Buffer.from(crypto.createHash('sha256').update(token).digest('hex'));
  const b = Buffer.from(data.settings.tokenHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
