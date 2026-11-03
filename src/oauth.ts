/**
 * Code & Blocks WordPress MCP – authentication
 * Author: Code & Blocks by Marijan
 *
 * Minimal single-user OAuth 2.1 authorization server (dynamic client
 * registration + PKCE) so the server can be added as a custom connector in
 * claude.ai. The "login" is a password form (ADMIN_PASSWORD).
 * A static MCP_TOKEN is accepted as bearer token as well (Claude Code, scripts).
 *
 * State (registered clients, hashed tokens) is persisted to DATA_DIR/oauth.json.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { APP_NAME, type Config } from './config.js';

interface TokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number; // unix seconds
  resource?: string;
}

interface CodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface PersistedState {
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, TokenRecord>;
  refresh: Record<string, TokenRecord>;
}

const MAX_CLIENTS = 100;
const now = () => Math.floor(Date.now() / 1000);
const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export class AuthProvider implements OAuthServerProvider {
  private state: PersistedState = { clients: {}, access: {}, refresh: {} };
  private codes = new Map<string, CodeRecord>();
  private file: string;
  private persist = true;

  constructor(private cfg: Config) {
    this.file = path.join(cfg.dataDir, 'oauth.json');
    this.load();
    setInterval(() => this.prune(), 3600_000).unref();
  }

  // ---------- persistence ----------
  private load() {
    try {
      fs.mkdirSync(this.cfg.dataDir, { recursive: true });
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PersistedState>;
        this.state = { clients: parsed.clients ?? {}, access: parsed.access ?? {}, refresh: parsed.refresh ?? {} };
      }
      this.prune();
    } catch (e) {
      console.warn(`[auth] cannot use ${this.file} (${(e as Error).message}); OAuth state is kept in memory only`);
      this.persist = false;
    }
  }

  private save() {
    if (!this.persist) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.warn(`[auth] cannot write ${this.file}: ${(e as Error).message}; keeping state in memory`);
      this.persist = false;
    }
  }

  private prune() {
    const t = now();
    for (const store of [this.state.access, this.state.refresh]) {
      for (const [k, v] of Object.entries(store)) if (v.expiresAt < t) delete store[k];
    }
    for (const [k, v] of this.codes) if (v.expiresAt < t) this.codes.delete(k);
    this.save();
  }

  // ---------- clients ----------
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.state.clients[clientId],
      registerClient: (client) => {
        const full = client as OAuthClientInformationFull;
        if (!full.client_id) {
          full.client_id = crypto.randomUUID();
          full.client_id_issued_at = now();
        }
        const ids = Object.keys(this.state.clients);
        if (ids.length >= MAX_CLIENTS) {
          ids
            .sort((a, b) => (this.state.clients[a].client_id_issued_at ?? 0) - (this.state.clients[b].client_id_issued_at ?? 0))
            .slice(0, ids.length - MAX_CLIENTS + 1)
            .forEach((id) => delete this.state.clients[id]);
        }
        this.state.clients[full.client_id] = full;
        this.save();
        return full;
      },
    };
  }

  // ---------- authorization ----------
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.status(200).send(this.loginPage(client, params));
  }

  private loginPage(client: OAuthClientInformationFull, params: AuthorizationParams, error?: string): string {
    let redirectHost = '';
    try {
      redirectHost = new URL(params.redirectUri).host;
    } catch {
      /* ignore */
    }
    const hidden = {
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      state: params.state ?? '',
      code_challenge: params.codeChallenge,
      scope: (params.scopes ?? []).join(' '),
      resource: params.resource?.href ?? '',
    };
    return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anmelden – ${esc(APP_NAME)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--fg:#1d1d1b;--muted:#6b6a66;--accent:#2f5d50;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#20201f;--fg:#ecebe7;--muted:#a3a29d;--accent:#7cc0a8;--err:#f2b8b5}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:16px}
.card{background:var(--card);max-width:420px;width:100%;padding:28px;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:1.25rem;margin:0 0 4px}p{margin:0 0 16px;color:var(--muted);font-size:.95rem}
label{display:block;font-weight:600;margin-bottom:6px}input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--muted);border-radius:8px;background:transparent;color:var(--fg);font-size:1rem}
button{margin-top:16px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;font-size:1rem;cursor:pointer}
.err{color:var(--err);margin-bottom:12px}.meta{font-size:.85rem;margin-top:18px}
</style></head><body><main class="card">
<h1>${esc(APP_NAME)}</h1>
<p><strong>${esc(client.client_name || 'Ein MCP-Client')}</strong> möchte Zugriff auf deine WordPress-Seiten.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/oauth/login" autocomplete="off">
${Object.entries(hidden)
  .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
  .join('\n')}
<label for="pw">Admin-Passwort</label>
<input id="pw" type="password" name="password" required autofocus>
<button type="submit">Zugriff erlauben</button>
</form>
<p class="meta">Weiterleitung an: ${esc(redirectHost)}<br>Code &amp; Blocks by Marijan</p>
</main></body></html>`;
  }

  /** POST /oauth/login – checks the admin password and issues an authorization code. */
  loginHandler = async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const b = (req.body ?? {}) as Record<string, string>;
    const client = this.state.clients[b.client_id ?? ''];
    if (!client) {
      res.status(400).send('Unknown client');
      return;
    }
    if (!b.redirect_uri || !client.redirect_uris.map(String).includes(b.redirect_uri)) {
      res.status(400).send('Invalid redirect_uri');
      return;
    }
    if (!b.code_challenge) {
      res.status(400).send('Missing code_challenge');
      return;
    }
    const params: AuthorizationParams = {
      redirectUri: b.redirect_uri,
      codeChallenge: b.code_challenge,
      state: b.state || undefined,
      scopes: b.scope ? b.scope.split(' ').filter(Boolean) : [],
      resource: b.resource ? new URL(b.resource) : undefined,
    };

    if (!this.cfg.adminPassword || !safeEqual(b.password ?? '', this.cfg.adminPassword)) {
      console.warn(`[auth] failed login from ${req.ip}`);
      res.status(401).send(this.loginPage(client, params, 'Falsches Passwort.'));
      return;
    }

    const code = randomToken();
    this.codes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      expiresAt: now() + 300,
    });
    const target = new URL(params.redirectUri);
    target.searchParams.set('code', code);
    if (params.state) target.searchParams.set('state', params.state);
    console.log(`[auth] login ok for client "${client.client_name ?? client.client_id}"`);
    res.redirect(302, target.href);
  };

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string): Promise<string> {
    const rec = this.codes.get(code);
    if (!rec) throw new InvalidGrantError('Invalid authorization code');
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const rec = this.codes.get(code);
    this.codes.delete(code); // single use
    if (!rec || rec.expiresAt < now()) throw new InvalidGrantError('Invalid or expired authorization code');
    if (rec.clientId !== client.client_id) throw new InvalidGrantError('Code was issued to another client');
    if (redirectUri && redirectUri !== rec.redirectUri) throw new InvalidGrantError('redirect_uri mismatch');
    return this.issue(client.client_id, rec.scopes, rec.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const key = sha256(refreshToken);
    const rec = this.state.refresh[key];
    if (!rec || rec.expiresAt < now()) throw new InvalidGrantError('Invalid or expired refresh token');
    if (rec.clientId !== client.client_id) throw new InvalidGrantError('Refresh token was issued to another client');
    delete this.state.refresh[key]; // rotation
    return this.issue(client.client_id, rec.scopes, rec.resource);
  }

  private issue(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const access = randomToken();
    const refresh = randomToken();
    this.state.access[sha256(access)] = { clientId, scopes, resource, expiresAt: now() + this.cfg.accessTokenTtl };
    this.state.refresh[sha256(refresh)] = { clientId, scopes, resource, expiresAt: now() + this.cfg.refreshTokenTtl };
    this.save();
    return {
      access_token: access,
      token_type: 'bearer',
      expires_in: this.cfg.accessTokenTtl,
      refresh_token: refresh,
      scope: scopes.join(' ') || undefined,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.cfg.mcpToken && safeEqual(token, this.cfg.mcpToken)) {
      return { token, clientId: 'static-token', scopes: ['mcp'], expiresAt: now() + 3600 };
    }
    const rec = this.state.access[sha256(token)];
    if (!rec || rec.expiresAt < now()) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: rec.expiresAt,
      resource: rec.resource ? new URL(rec.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = sha256(request.token);
    delete this.state.access[key];
    delete this.state.refresh[key];
    this.save();
  }
}
