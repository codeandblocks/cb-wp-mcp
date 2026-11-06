/**
 * Code & Blocks WordPress MCP – authentication for AI clients
 * Author: Code & Blocks by Marijan
 *
 * OAuth 2.1 authorization server (dynamic client registration + PKCE) for
 * custom connectors in Claude and other MCP clients. Every token is bound to
 * exactly one workspace:
 *  - customers sign in with their WordPress login (SSO through the bridge plugin)
 *  - the operator signs in with ADMIN_PASSWORD (+ 2FA) and gets the "intern" workspace
 * Static bearer tokens (created in the portal, or MCP_TOKEN) are bound the same way.
 */
import type { Request, Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import crypto from 'node:crypto';
import { APP_NAME, type Config } from './config.js';
import { all, get, run } from './db.js';
import { randomToken, safeEqual, sha256 } from './crypto.js';
import { OWNER_WS, getWorkspace, siteByUrl } from './workspaces.js';
import { logAccess } from './activity.js';
import { ownerTotpEnabled, ownerTotpSecret, verifyTotp } from './totp.js';
import { startSso } from './sso.js';

export interface Grant {
  workspaceId: string;
  actor: string;
  role: 'owner' | 'customer';
}

interface CodeRecord extends Grant {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface PendingAuth {
  clientId: string;
  params: AuthorizationParams;
  expires: number;
}

const MAX_CLIENTS = 500;
const now = () => Math.floor(Date.now() / 1000);

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export class AuthProvider implements OAuthServerProvider {
  private codes = new Map<string, CodeRecord>();
  private pending = new Map<string, PendingAuth>();

  constructor(private cfg: Config) {
    setInterval(() => {
      const t = now();
      for (const [k, v] of this.codes) if (v.expiresAt < t) this.codes.delete(k);
      for (const [k, v] of this.pending) if (v.expires < Date.now()) this.pending.delete(k);
    }, 60_000).unref();
  }

  // ---------- clients ----------
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => {
        const r = get<{ data: string }>('SELECT data FROM oauth_clients WHERE client_id = :id', { id: clientId });
        return r ? (JSON.parse(r.data) as OAuthClientInformationFull) : undefined;
      },
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        if (!full.client_id) {
          full.client_id = crypto.randomUUID();
          full.client_id_issued_at = now();
        }
        const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM oauth_clients')?.n ?? 0;
        if (n >= MAX_CLIENTS) {
          run(
            `DELETE FROM oauth_clients WHERE client_id IN (
               SELECT c.client_id FROM oauth_clients c
               WHERE NOT EXISTS (SELECT 1 FROM tokens t WHERE t.client_id = c.client_id)
               ORDER BY c.issued_at LIMIT 50)`,
          );
        }
        run('INSERT OR REPLACE INTO oauth_clients (client_id, data, issued_at) VALUES (:id, :d, :i)', { id: full.client_id, d: JSON.stringify(full), i: full.client_id_issued_at ?? now() });
        return full;
      },
    };
  }

  private client(id: string) {
    return this.clientsStore.getClient(id) as OAuthClientInformationFull | undefined;
  }

  // ---------- authorization page ----------
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.status(200).send(this.loginPage(client, params));
  }

  private hidden(client: OAuthClientInformationFull, params: AuthorizationParams) {
    const h = {
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      state: params.state ?? '',
      code_challenge: params.codeChallenge,
      scope: (params.scopes ?? []).join(' '),
      resource: params.resource?.href ?? '',
    };
    return Object.entries(h)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
      .join('');
  }

  loginPage(client: OAuthClientInformationFull, params: AuthorizationParams, error?: string, ownerOpen = false): string {
    let redirectHost = '';
    try {
      redirectHost = new URL(params.redirectUri).host;
    } catch {
      /* ignore */
    }
    const totp = ownerTotpEnabled();
    return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anmelden – ${esc(APP_NAME)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--fg:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#2f5d50;--accent-fg:#fff;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#20201f;--fg:#ecebe7;--muted:#a3a29d;--line:#2f2e2b;--accent:#7cc0a8;--accent-fg:#10201a;--err:#f2b8b5}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
.card{background:var(--card);max-width:440px;width:100%;padding:28px;border-radius:14px;border:1px solid var(--line)}
h1{font-size:1.25rem;margin:0 0 4px}p{margin:0 0 16px;color:var(--muted);font-size:.95rem}
label{display:block;font-weight:600;margin:0 0 6px}input[type=password],input[type=url],input[type=text]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);font-size:1rem;margin-bottom:12px}
button{width:100%;padding:11px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-weight:600;font-size:1rem;cursor:pointer}
details{margin-top:22px;border-top:1px solid var(--line);padding-top:14px}summary{cursor:pointer;color:var(--muted);font-size:.9rem}
.err{color:var(--err);margin-bottom:12px}.meta{font-size:.85rem;margin-top:18px}
</style></head><body><main class="card">
<h1>${esc(APP_NAME)}</h1>
<p><strong>${esc(client.client_name || 'Ein KI-Client')}</strong> möchte auf deine WordPress-Seiten zugreifen.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/oauth/sso">${this.hidden(client, params)}
<label for="site">Adresse deiner WordPress-Seite</label>
<input id="site" type="url" name="site" placeholder="https://deine-seite.at" required autofocus>
<button type="submit">Mit WordPress anmelden</button>
</form>
<p class="meta">Du meldest dich in deinem WordPress als Administrator an. Die Seite muss mit dem Plugin „Code &amp; Blocks MCP Bridge“ verbunden sein.</p>
<details${ownerOpen ? ' open' : ''}><summary>Anmeldung für den Betreiber</summary>
<form method="post" action="/oauth/login" autocomplete="off" style="margin-top:12px">${this.hidden(client, params)}
<label for="pw">Admin-Passwort</label><input id="pw" type="password" name="password" required>
${totp ? '<label for="otp">Code aus der Authenticator-App</label><input id="otp" type="text" name="otp" inputmode="numeric" pattern="[0-9 ]{6,7}" required>' : ''}
<button type="submit">Anmelden</button></form></details>
<p class="meta">Weiterleitung an: ${esc(redirectHost)}<br>Code &amp; Blocks by Marijan</p>
</main></body></html>`;
  }

  private parseForm(req: Request): { client?: OAuthClientInformationFull; params?: AuthorizationParams; error?: string } {
    const b = (req.body ?? {}) as Record<string, string>;
    const client = this.client(b.client_id ?? '');
    if (!client) return { error: 'Unknown client' };
    if (!b.redirect_uri || !client.redirect_uris.map(String).includes(b.redirect_uri)) return { error: 'Invalid redirect_uri' };
    if (!b.code_challenge) return { error: 'Missing code_challenge' };
    return {
      client,
      params: {
        redirectUri: b.redirect_uri,
        codeChallenge: b.code_challenge,
        state: b.state || undefined,
        scopes: b.scope ? b.scope.split(' ').filter(Boolean) : [],
        resource: b.resource ? new URL(b.resource) : undefined,
      },
    };
  }

  /** POST /oauth/login – operator login (password + optional TOTP). */
  loginHandler = async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const { client, params, error } = this.parseForm(req);
    if (!client || !params) return void res.status(400).send(error);
    const b = req.body as Record<string, string>;
    const pwOk = Boolean(this.cfg.adminPassword) && safeEqual(b.password ?? '', this.cfg.adminPassword!);
    const secret = ownerTotpSecret();
    const otpOk = !secret || verifyTotp(secret, b.otp ?? '');
    if (!pwOk || !otpOk) {
      console.warn(`[auth] failed operator login from ${req.ip}`);
      logAccess({ actor: 'Betreiber', action: 'login_fehlgeschlagen', ip: req.ip, detail: 'KI-Client' });
      return void res.status(401).send(this.loginPage(client, params, pwOk ? 'Falscher Code.' : 'Falsches Passwort.', true));
    }
    this.complete(res, client, params, { workspaceId: OWNER_WS, actor: 'Betreiber', role: 'owner' }, req.ip);
  };

  /** POST /oauth/sso – customer login through their WordPress site. */
  ssoHandler = async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const { client, params, error } = this.parseForm(req);
    if (!client || !params) return void res.status(400).send(error);
    const site = siteByUrl(String(req.body.site ?? ''));
    if (!site) return void res.status(404).send(this.loginPage(client, params, 'Diese Seite ist nicht mit dem Server verbunden. Bitte zuerst im WordPress-Plugin unter „Code & Blocks MCP → Verbindung“ verbinden.'));
    const id = randomToken(16);
    this.pending.set(id, { clientId: client.client_id, params, expires: Date.now() + 10 * 60 * 1000 });
    startSso(res, site, { purpose: 'oauth', ref: id });
  };

  /** Called after a successful WordPress SSO for purpose "oauth". */
  completeFromSso(res: Response, ref: string, grant: Grant, ip?: string) {
    const p = this.pending.get(ref);
    this.pending.delete(ref);
    const client = p ? this.client(p.clientId) : undefined;
    if (!p || !client || p.expires < Date.now()) return void res.status(400).send('Die Anmeldung ist abgelaufen. Bitte im KI-Client erneut verbinden.');
    this.complete(res, client, p.params, grant, ip);
  }

  private complete(res: Response, client: OAuthClientInformationFull, params: AuthorizationParams, grant: Grant, ip?: string) {
    const code = randomToken();
    this.codes.set(code, { ...grant, clientId: client.client_id, codeChallenge: params.codeChallenge, redirectUri: params.redirectUri, scopes: params.scopes ?? [], resource: params.resource?.href, expiresAt: now() + 300 });
    logAccess({ workspaceId: grant.workspaceId, actor: grant.actor, action: 'ki_client_verbunden', ip, detail: client.client_name ?? client.client_id });
    const target = new URL(params.redirectUri);
    target.searchParams.set('code', code);
    if (params.state) target.searchParams.set('state', params.state);
    res.redirect(302, target.href);
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string): Promise<string> {
    const rec = this.codes.get(code);
    if (!rec) throw new InvalidGrantError('Invalid authorization code');
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const rec = this.codes.get(code);
    this.codes.delete(code);
    if (!rec || rec.expiresAt < now()) throw new InvalidGrantError('Invalid or expired authorization code');
    if (rec.clientId !== client.client_id) throw new InvalidGrantError('Code was issued to another client');
    if (redirectUri && redirectUri !== rec.redirectUri) throw new InvalidGrantError('redirect_uri mismatch');
    return this.issue(client.client_id, rec, rec.scopes, rec.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const h = sha256(refreshToken);
    const r = get<any>("SELECT * FROM tokens WHERE hash = :h AND kind = 'refresh'", { h });
    if (!r || r.expires_at < now()) throw new InvalidGrantError('Invalid or expired refresh token');
    if (r.client_id !== client.client_id) throw new InvalidGrantError('Refresh token was issued to another client');
    if (!getWorkspace(r.workspace_id)) throw new InvalidGrantError('Account no longer exists');
    run('DELETE FROM tokens WHERE hash = :h', { h }); // rotation
    return this.issue(client.client_id, { workspaceId: r.workspace_id, actor: r.actor, role: r.workspace_id === OWNER_WS ? 'owner' : 'customer' }, JSON.parse(r.scopes ?? '[]'), r.resource ?? undefined);
  }

  private issue(clientId: string, grant: Grant, scopes: string[], resource?: string): OAuthTokens {
    const access = randomToken();
    const refresh = randomToken();
    const ins = (token: string, kind: string, ttl: number) =>
      run('INSERT INTO tokens (hash, workspace_id, kind, client_id, actor, scopes, resource, expires_at, created_at) VALUES (:h, :ws, :k, :c, :a, :s, :r, :e, :t)', {
        h: sha256(token),
        ws: grant.workspaceId,
        k: kind,
        c: clientId,
        a: grant.actor,
        s: JSON.stringify(scopes),
        r: resource,
        e: now() + ttl,
        t: new Date().toISOString(),
      });
    ins(access, 'access', this.cfg.accessTokenTtl);
    ins(refresh, 'refresh', this.cfg.refreshTokenTtl);
    return { access_token: access, token_type: 'bearer', expires_in: this.cfg.accessTokenTtl, refresh_token: refresh, scope: scopes.join(' ') || undefined };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const extra = (g: Grant) => ({ workspaceId: g.workspaceId, actor: g.actor, role: g.role }) as Record<string, unknown>;
    if (this.cfg.mcpToken && safeEqual(token, this.cfg.mcpToken)) {
      return { token, clientId: 'static-token', scopes: ['mcp'], expiresAt: now() + 3600, extra: extra({ workspaceId: OWNER_WS, actor: 'Betreiber (MCP_TOKEN)', role: 'owner' }) };
    }
    const r = get<any>('SELECT * FROM tokens WHERE hash = :h', { h: sha256(token) });
    if (!r || r.kind === 'refresh') throw new InvalidTokenError('Invalid or expired access token');
    if (r.kind === 'access' && r.expires_at < now()) throw new InvalidTokenError('Invalid or expired access token');
    const role = r.workspace_id === OWNER_WS ? 'owner' : 'customer';
    if (r.kind === 'static') {
      return { token, clientId: 'static-token', scopes: ['mcp'], expiresAt: now() + 3600, extra: extra({ workspaceId: r.workspace_id, actor: `Token „${r.label}“`, role }) };
    }
    return {
      token,
      clientId: r.client_id,
      scopes: JSON.parse(r.scopes ?? '[]'),
      expiresAt: r.expires_at,
      resource: r.resource ? new URL(r.resource) : undefined,
      extra: extra({ workspaceId: r.workspace_id, actor: r.actor ?? 'unbekannt', role }),
    };
  }

  /** Connected AI clients of a workspace. */
  stats(wsId: string) {
    return all<{ client_id: string; actor: string; n: number }>(
      "SELECT client_id, actor, COUNT(*) AS n FROM tokens WHERE workspace_id = :ws AND kind = 'refresh' AND expires_at > :t GROUP BY client_id, actor",
      { ws: wsId, t: now() },
    ).map((r) => {
      const c = this.client(r.client_id);
      return { client_id: r.client_id, name: c?.client_name ?? r.client_id, actor: r.actor, registered: c?.client_id_issued_at, sessions: r.n };
    });
  }

  /** Sign out every AI client of a workspace. */
  revokeWorkspace(wsId: string) {
    run("DELETE FROM tokens WHERE workspace_id = :ws AND kind IN ('access','refresh')", { ws: wsId });
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    run("DELETE FROM tokens WHERE hash = :h AND kind IN ('access','refresh')", { h: sha256(request.token) });
  }
}
