/**
 * Code & Blocks WordPress MCP – connecting a WordPress site
 * Author: Code & Blocks by Marijan
 *
 * Uses the WordPress "Authorize Application" screen: the site's administrator
 * approves, WordPress creates an application password and sends it back to
 * the server, where it is stored encrypted in the customer's workspace.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import { USER_AGENT } from './net.js';
import { WPClient } from './wp.js';

export const APP_PASSWORD_NAME = 'Code & Blocks MCP';
export const APP_PASSWORD_ID = '6f1c3c2e-6c2b-4e43-9d8f-2a9c0b5d7e11';

export interface Discovered {
  url: string;
  restBase?: string;
  authUrl: string;
  name?: string;
}

export async function discover(rawUrl: string): Promise<Discovered> {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    throw new Error('Ungültige Adresse.');
  }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new Error('Die Seite muss über HTTPS erreichbar sein (Anwendungspasswörter verlangen HTTPS).');
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  const tryIndex = async (url: string) => {
    const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as any;
  };
  let index: any;
  let restBase = `${base}/wp-json`;
  try {
    index = await tryIndex(`${base}/wp-json/`);
  } catch {
    try {
      index = await tryIndex(`${base}/?rest_route=/`);
      restBase = `${base}/?rest_route=`;
    } catch (e) {
      throw new Error(`Die WordPress REST API ist unter ${base} nicht erreichbar (${(e as Error).message}). Firewall oder Sicherheits-Plugin prüfen.`);
    }
  }
  const auth = index?.authentication?.['application-passwords']?.endpoints?.authorization as string | undefined;
  if (!auth) throw new Error('Anwendungspasswörter sind auf dieser Seite deaktiviert (z. B. durch ein Sicherheits-Plugin). Bitte dort erlauben.');
  const home = String(index.home ?? index.url ?? base).replace(/\/+$/, '');
  return { url: home, restBase: restBase === `${home}/wp-json` ? undefined : restBase, authUrl: auth, name: index.name as string | undefined };
}

export function authorizeUrl(d: Discovered, callback: string): string {
  const target = new URL(d.authUrl);
  target.searchParams.set('app_name', APP_PASSWORD_NAME);
  target.searchParams.set('app_id', APP_PASSWORD_ID);
  target.searchParams.set('success_url', callback);
  target.searchParams.set('reject_url', `${callback}${callback.includes('?') ? '&' : '?'}rejected=1`);
  return target.href;
}

/** Checks the credentials WordPress sent back. Returns a warning (or '') or throws. */
export async function verifyCredentials(url: string, user: string, password: string, restBase?: string): Promise<string> {
  const probe = new WPClient({ id: 'probe', url, user, appPassword: password.replace(/\s+/g, ''), restBase: restBase ?? `${url}/wp-json` });
  try {
    const me = (await probe.get('/wp/v2/users/me', { context: 'edit', _fields: 'id,capabilities' })).data as any;
    if (!me?.capabilities?.manage_options) return 'Hinweis: Dieser Benutzer ist kein Administrator. Plugins, Themes, Dateien und Einstellungen sind damit nicht möglich.';
    return '';
  } catch (e) {
    throw new Error(`Zugangsdaten erhalten, aber die Anmeldung an der REST API schlägt fehl: ${(e as Error).message}`);
  }
}

/** Return URL must point to the connected site itself. */
export function safeReturn(returnUrl: string | undefined, siteUrl: string): string | undefined {
  if (!returnUrl) return undefined;
  try {
    return new URL(returnUrl).hostname === new URL(siteUrl).hostname ? returnUrl : undefined;
  } catch {
    return undefined;
  }
}

export interface ConnectState {
  workspaceId: string;
  url: string;
  name?: string;
  restBase?: string;
  returnUrl?: string;
  /** Session id (logged-in flow) or browser cookie value (code flow). */
  binding: string;
  expires: number;
}

export const connectStates = new Map<string, ConnectState>();

export function newConnectState(s: Omit<ConnectState, 'expires'>): string {
  const id = crypto.randomBytes(16).toString('hex');
  connectStates.set(id, { ...s, expires: Date.now() + 20 * 60 * 1000 });
  return id;
}

export function takeConnectState(id: string): ConnectState | undefined {
  const s = connectStates.get(id);
  connectStates.delete(id);
  return s && s.expires > Date.now() ? s : undefined;
}

setInterval(() => {
  const t = Date.now();
  for (const [k, v] of connectStates) if (v.expires < t) connectStates.delete(k);
}, 10 * 60 * 1000).unref();

export const publicHttps = () => (config.publicUrl ?? '').startsWith('https://') || /localhost|127\.0\.0\.1/.test(config.publicUrl ?? '');
