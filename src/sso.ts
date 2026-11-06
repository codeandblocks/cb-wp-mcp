/**
 * Code & Blocks WordPress MCP – login with WordPress (SSO)
 * Author: Code & Blocks by Marijan
 *
 * Flow:
 * 1. Browser → server /sso/start (or /oauth/sso): server remembers a state,
 *    binds it to the browser with a cookie and redirects to the WordPress site:
 *    /wp-admin/admin-post.php?action=cbmcp_sso&state=…
 * 2. WordPress (bridge plugin): the user must be logged in as administrator.
 *    The plugin creates a one-time code (60 s) and redirects back – only to the
 *    server URL saved in the plugin.
 * 3. Server /sso/callback: checks state + cookie and redeems the code over the
 *    authenticated REST connection (POST cbmcp/v1/sso/verify, application
 *    password). Only then the user is signed in to that site's workspace.
 */
import type { Request, Response } from 'express';
import { randomToken, safeEqual } from './crypto.js';
import { runWith } from './context.js';
import { getClient, WPError } from './wp.js';
import { config } from './config.js';
import type { SiteInfo } from './workspaces.js';

export interface SsoState {
  id: string;
  siteId: string;
  workspaceId: string;
  siteUrl: string;
  purpose: 'portal' | 'oauth';
  ref?: string;
  expires: number;
}

export interface SsoUser {
  login: string;
  name: string;
  host: string;
}

const states = new Map<string, SsoState>();
export const SSO_COOKIE = 'cbmcp_sso';

setInterval(() => {
  const t = Date.now();
  for (const [k, v] of states) if (v.expires < t) states.delete(k);
}, 60_000).unref();

const secure = () => (config.publicUrl ?? '').startsWith('https://');

export function startSso(res: Response, site: SiteInfo, opts: { purpose: SsoState['purpose']; ref?: string }) {
  const id = randomToken(24);
  states.set(id, { id, siteId: site.id, workspaceId: site.workspaceId, siteUrl: site.url, purpose: opts.purpose, ref: opts.ref, expires: Date.now() + 10 * 60 * 1000 });
  res.cookie(SSO_COOKIE, id, { httpOnly: true, secure: secure(), sameSite: 'lax', path: '/sso', maxAge: 10 * 60 * 1000 });
  const target = new URL(`${site.url.replace(/\/+$/, '')}/wp-admin/admin-post.php`);
  target.searchParams.set('action', 'cbmcp_sso');
  target.searchParams.set('state', id);
  res.redirect(303, target.href);
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export class SsoError extends Error {}

export async function finishSso(req: Request, res: Response): Promise<{ state: SsoState; user: SsoUser }> {
  const id = String(req.query.state ?? '');
  const code = String(req.query.code ?? '');
  const cookie = readCookie(req, SSO_COOKIE);
  res.clearCookie(SSO_COOKIE, { path: '/sso' });
  const st = states.get(id);
  states.delete(id);
  if (!st || st.expires < Date.now()) throw new SsoError('Die Anmeldung ist abgelaufen. Bitte erneut starten.');
  if (!cookie || !safeEqual(cookie, id)) throw new SsoError('Die Anmeldung wurde in einem anderen Browser gestartet. Bitte erneut starten.');
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(code)) throw new SsoError('Ungültige Antwort von WordPress.');

  const data = await runWith({ workspaceId: st.workspaceId, role: 'customer', actor: 'sso', via: 'ui' }, async () => {
    try {
      return (await getClient(st.siteId).post('/cbmcp/v1/sso/verify', { code })).data as { user_login?: string; display_name?: string; state?: string; manage_options?: boolean };
    } catch (e) {
      if (e instanceof WPError && e.code === 'rest_no_route') throw new SsoError('Auf der Seite ist eine zu alte Version des Plugins „Code & Blocks MCP Bridge“ installiert. Bitte auf Version 1.3 oder neuer aktualisieren.');
      throw new SsoError(`Die Anmeldung konnte nicht bestätigt werden: ${(e as Error).message}`);
    }
  });
  if (!data?.user_login || data.state !== id || data.manage_options !== true) throw new SsoError('Die Anmeldung wurde von WordPress nicht bestätigt.');
  return { state: st, user: { login: data.user_login, name: data.display_name || data.user_login, host: new URL(st.siteUrl).hostname } };
}
