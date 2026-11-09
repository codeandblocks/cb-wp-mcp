/**
 * Code & Blocks WordPress MCP – HTTP entry point
 * Author: Code & Blocks by Marijan
 *
 * Streamable HTTP MCP endpoint at /mcp (stateless). Every request runs in the
 * workspace its token belongs to (customer via WordPress login, or operator).
 * /admin is the operator UI and customer portal, /sso and /connect are the
 * WordPress login and site connection flows.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import crypto from 'node:crypto';
import { APP_NAME, APP_VERSION, config } from './config.js';
import { AuthProvider } from './oauth.js';
import { buildServer } from './tools.js';
import { initDb } from './db.js';
import { initWorkspaces, onChange, siteByUrl, upsertSite, workspaceByCode, OWNER_WS, SiteConflictError } from './workspaces.js';
import { logAccess, purgeExpired, record } from './activity.js';
import { adminRouter, createSession } from './admin.js';
import { resetClients } from './wp.js';
import { runWith, type Ctx } from './context.js';
import { finishSso, SsoError, startSso } from './sso.js';
import { authorizeUrl, discover, newConnectState, peekConnectState, publicHttps, safeReturn, takeConnectState, verifyCredentials } from './connect.js';

initDb();
initWorkspaces();
purgeExpired();
setInterval(purgeExpired, 24 * 3600 * 1000).unref();
onChange(resetClients);

const page = (title: string, body: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:light dark}body{word-break:break-word;margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f6f5f2;color:#1d1d1b;padding:16px}@media (prefers-color-scheme:dark){body{background:#141413;color:#ecebe7}}.c{max-width:480px}a{color:#2f5d50}</style></head><body><div class="c"><h1 style="font-size:22px">${title}</h1>${body}<p style="font-size:12px;opacity:.6">Code &amp; Blocks by Marijan</p></div></body></html>`;
const escHtml = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const app = express();
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, name: APP_NAME, version: APP_VERSION });
});

app.get('/', (_req, res) => {
  res.redirect(302, '/admin');
});

const provider = new AuthProvider(config);
app.use('/admin', adminRouter(provider));
const mcpUrl = config.publicUrl ? new URL('/mcp', config.publicUrl) : undefined;

if (config.oauthEnabled && config.publicUrl && mcpUrl) {
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.publicUrl),
      resourceServerUrl: mcpUrl,
      scopesSupported: ['mcp'],
      resourceName: APP_NAME,
    }),
  );

  // Some clients probe the root variant of the protected resource metadata.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: mcpUrl.href,
      authorization_servers: [new URL(config.publicUrl!).href],
      scopes_supported: ['mcp'],
      resource_name: APP_NAME,
    });
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.',
  });
  app.post('/oauth/login', loginLimiter, express.urlencoded({ extended: false, limit: '20kb' }), provider.loginHandler);
  app.post('/oauth/sso', loginLimiter, express.urlencoded({ extended: false, limit: '20kb' }), provider.ssoHandler);
}

// ---------- login with WordPress ----------
const ssoLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false });

app.get('/sso/start', ssoLimiter, (req, res) => {
  const site = siteByUrl(String(req.query.site ?? ''));
  if (!site) return void res.redirect(303, `/admin/login?err=${encodeURIComponent('Diese Seite ist nicht mit dem Server verbunden. Bitte zuerst im WordPress-Plugin verbinden.')}`);
  startSso(res, site, { purpose: 'portal' });
});

app.get('/sso/callback', ssoLimiter, async (req, res) => {
  try {
    const { state, user } = await finishSso(req, res);
    const actor = `${user.login}@${user.host} (WordPress)`;
    if (state.purpose === 'oauth') {
      return provider.completeFromSso(res, state.ref ?? '', { workspaceId: state.workspaceId, actor, role: state.workspaceId === OWNER_WS ? 'owner' : 'customer' }, req.ip);
    }
    createSession(res, { role: 'customer', workspaceId: state.workspaceId, homeWs: state.workspaceId, actor });
    logAccess({ workspaceId: state.workspaceId, actor, action: 'login', ip: req.ip, detail: 'über WordPress' });
    res.redirect(303, '/admin');
  } catch (e) {
    const msg = e instanceof SsoError ? e.message : 'Die Anmeldung ist fehlgeschlagen.';
    if (!(e instanceof SsoError)) console.error('[sso]', e);
    res.status(400).send(page('Anmeldung fehlgeschlagen', `<p>${escHtml(msg)}</p><p><a href="/admin/login">Zur Anmeldung</a></p>`));
  }
});

// ---------- connect a site with a customer's connection code (from the plugin) ----------
const connectLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: 'Zu viele Versuche. Bitte in 15 Minuten erneut.' });
const CONNECT_COOKIE = 'cbmcp_connect';
const readCookie = (req: Request, name: string) => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
};

app.post('/connect/start', connectLimiter, express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
  const site = String(req.body.site ?? '');
  const code = String(req.body.code ?? '');
  const fail = (msg: string, status = 400) => res.status(status).send(page('Verbinden nicht möglich', `<p>${escHtml(msg)}</p><p><a href="javascript:history.back()">Zurück</a></p>`));
  if (!publicHttps()) return void fail('Der Server hat keine HTTPS-Adresse (PUBLIC_URL).');
  const w = workspaceByCode(code);
  if (!w) {
    logAccess({ actor: 'unbekannt', action: 'login_fehlgeschlagen', ip: req.ip, detail: 'falscher Verbindungscode' });
    return void fail('Der Verbindungscode ist ungültig. Bitte beim Betreiber einen aktuellen Code anfragen.', 401);
  }
  let d;
  try {
    d = await discover(site);
  } catch (e) {
    return void fail((e as Error).message);
  }
  const existing = siteByUrl(d.url);
  if (existing && existing.workspaceId !== w.id) return void fail('Diese Seite ist bereits mit einem anderen Konto verbunden.', 409);
  const binding = crypto.randomBytes(16).toString('hex');
  const state = newConnectState({ workspaceId: w.id, workspaceName: w.name, url: d.url, name: d.name, restBase: d.restBase, returnUrl: safeReturn(String(req.body.return ?? ''), d.url), binding, authUrl: d.authUrl });
  res.cookie(CONNECT_COOKIE, binding, { httpOnly: true, secure: (config.publicUrl ?? '').startsWith('https://'), sameSite: 'lax', path: '/connect', maxAge: 20 * 60 * 1000 });
  // Confirmation step: the user must see which account the site is connected to.
  // A third party cannot complete it: it needs this browser's cookie and the state id.
  res.send(
    page(
      'Seite verbinden',
      `<p>Die WordPress-Seite</p><p><strong>${escHtml(d.url)}</strong></p><p>wird mit dem Konto</p><p><strong>${escHtml(w.name)}</strong></p><p>auf ${escHtml(config.publicUrl)} verbunden. Dieses Konto kann danach mit einer KI auf die Seite zugreifen.</p>
<p>Stimmt das Konto nicht oder hast du die Verbindung nicht selbst gestartet, brich hier ab.</p>
<form method="post" action="/connect/confirm" style="display:flex;gap:10px;flex-wrap:wrap"><input type="hidden" name="state" value="${escHtml(state)}">
<button style="padding:10px 16px;border:0;border-radius:8px;background:#2f5d50;color:#fff;font-weight:600;cursor:pointer">Ja, weiter zu WordPress</button>
<a href="${escHtml(safeReturn(String(req.body.return ?? ''), d.url) ?? d.url)}" style="padding:10px 16px">Abbrechen</a></form>`,
    ),
  );
});

app.post('/connect/confirm', connectLimiter, express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  const id = String(req.body.state ?? '');
  const st = peekConnectState(id);
  const binding = readCookie(req, CONNECT_COOKIE);
  if (!st || !st.authUrl || !binding || binding !== st.binding) {
    return void res.status(400).send(page('Verbinden nicht möglich', '<p>Die Verbindungsanfrage ist abgelaufen oder wurde in einem anderen Browser gestartet. Bitte im Plugin erneut auf „Verbinden“ klicken.</p>'));
  }
  res.redirect(303, authorizeUrl({ url: st.url, authUrl: st.authUrl, restBase: st.restBase }, `${config.publicUrl}/connect/callback?state=${id}`));
});

app.get('/connect/callback', connectLimiter, async (req, res) => {
  const st = takeConnectState(String(req.query.state ?? ''));
  const binding = readCookie(req, CONNECT_COOKIE);
  res.clearCookie(CONNECT_COOKIE, { path: '/connect' });
  const done = (ok: boolean, msg: string) => {
    if (st?.returnUrl) {
      const u = new URL(st.returnUrl);
      u.searchParams.set(ok ? 'cbmcp_connected' : 'cbmcp_error', ok ? '1' : msg);
      return res.redirect(303, u.href);
    }
    res.status(ok ? 200 : 400).send(page(ok ? 'Verbunden' : 'Verbinden nicht möglich', `<p>${escHtml(msg)}</p>`));
  };
  if (!st || !binding || binding !== st.binding) return void done(false, 'Die Verbindungsanfrage ist abgelaufen oder wurde in einem anderen Browser gestartet. Bitte erneut verbinden.');
  if (req.query.rejected || req.query.success === 'false') return void done(false, 'Die Verbindung wurde in WordPress abgelehnt.');
  const user = String(req.query.user_login ?? '');
  const password = String(req.query.password ?? '');
  if (!user || !password) return void done(false, 'WordPress hat keine Zugangsdaten zurückgegeben.');
  try {
    await verifyCredentials(st.url, user, password, st.restBase);
    const actor = `${user}@${new URL(st.url).hostname} (WordPress)`;
    const id = upsertSite(st.workspaceId, { url: st.url, user, appPassword: password, name: st.name, restBase: st.restBase });
    runWith({ workspaceId: st.workspaceId, role: 'customer', actor, via: 'ui' }, () => record({ site: id, tool: 'connect_site', kind: 'change', status: 'ok', summary: `Seite verbunden (${user})`, source: 'ui' }));
    logAccess({ workspaceId: st.workspaceId, actor, action: 'seite_verbunden', ip: req.ip, detail: st.url });
    done(true, 'Die Seite ist jetzt mit dem MCP-Server verbunden.');
  } catch (e) {
    done(false, e instanceof SiteConflictError ? e.message : (e as Error).message);
  }
});

const bearer = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: config.oauthEnabled && mcpUrl ? getOAuthProtectedResourceMetadataUrl(mcpUrl) : undefined,
});

// Brute-force protection for the MCP endpoint itself (counts only failed auth).
const authFailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
});

const jsonBody = express.json({ limit: `${Math.ceil(config.maxUploadBytes / 1024 / 1024) * 2 + 1}mb` });

async function handleMcp(req: Request, res: Response, ctxOverride?: Ctx) {
  const extra = ((req as any).auth?.extra ?? {}) as { workspaceId?: string; actor?: string; role?: 'owner' | 'customer' };
  const c: Ctx | undefined = ctxOverride ?? (extra.workspaceId ? { workspaceId: extra.workspaceId, role: extra.role ?? 'customer', actor: extra.actor ?? 'unbekannt', via: 'mcp' } : undefined);
  if (!c) return void res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'No account bound to this token' }, id: null });
  await runWith(c, async () => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: every request is self-contained
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp] request failed', e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });
}

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
};

app.post('/mcp', authFailLimiter, bearer, jsonBody, (req: Request, res: Response) => handleMcp(req, res));
app.get('/mcp', authFailLimiter, bearer, methodNotAllowed);
app.delete('/mcp', authFailLimiter, bearer, methodNotAllowed);

// Fallback for clients that cannot send headers or do OAuth: token in the URL.
if (config.allowTokenInUrl && config.mcpToken) {
  const expected = crypto.createHash('sha256').update(config.mcpToken).digest();
  const tokenInPath = (req: Request, res: Response, next: NextFunction) => {
    const given = crypto.createHash('sha256').update(String(req.params.token ?? '')).digest();
    if (!crypto.timingSafeEqual(given, expected)) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    next();
  };
  app.post('/mcp/:token', authFailLimiter, tokenInPath, jsonBody, (req: Request, res: Response) => handleMcp(req, res, { workspaceId: OWNER_WS, role: 'owner', actor: 'Betreiber (Token-URL)', via: 'mcp' }));
  app.get('/mcp/:token', authFailLimiter, tokenInPath, methodNotAllowed);
}

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = typeof err?.status === 'number' ? err.status : 500;
  if (status >= 500) console.error('[http] error', err);
  if (!res.headersSent) res.status(status).json({ error: status >= 500 ? 'internal_error' : err.message });
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`${APP_NAME} ${APP_VERSION} listening on :${config.port}`);
  console.log(`  public URL : ${config.publicUrl ?? '(not set)'}`);
  console.log(`  auth       : ${['OAuth (WordPress login for customers, password for operator)', config.mcpToken && 'MCP_TOKEN', config.allowTokenInUrl && config.mcpToken && 'token in URL'].filter(Boolean).join(', ')}`);
  console.log(`  portal     : ${config.publicUrl ?? ''}/admin`);
  console.log(`  read-only  : ${config.envReadOnly ? 'forced by READ_ONLY' : 'per account'}`);
});
