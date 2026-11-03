/**
 * Code & Blocks WordPress MCP – HTTP entry point
 * Author: Code & Blocks by Marijan
 *
 * Streamable HTTP MCP endpoint at /mcp (stateless), protected by OAuth
 * (ADMIN_PASSWORD login, for claude.ai connectors) and/or a static bearer
 * token (MCP_TOKEN, for Claude Code / Desktop / scripts).
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
import { initStore, onChange } from './store.js';
import { initActivity } from './activity.js';
import { initApprovals } from './approvals.js';
import { adminRouter } from './admin.js';
import { resetClients } from './wp.js';

initStore();
initActivity();
initApprovals();
onChange(resetClients);

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
  res.json({ ok: true, name: APP_NAME, version: APP_VERSION, sites: config.sites.length });
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
}

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

async function handleMcp(req: Request, res: Response) {
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
}

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
};

app.post('/mcp', authFailLimiter, bearer, jsonBody, handleMcp);
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
  app.post('/mcp/:token', authFailLimiter, tokenInPath, jsonBody, handleMcp);
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
  console.log(`  auth       : ${[config.oauthEnabled && 'OAuth (password login)', config.mcpToken && 'static bearer token', config.allowTokenInUrl && config.mcpToken && 'token in URL'].filter(Boolean).join(', ')}`);
  console.log(`  sites      : ${config.sites.map((s) => `${s.id} (${s.url})`).join(', ') || 'none yet – connect one at /admin'}`);
  console.log(`  admin UI   : ${config.adminPassword ? `${config.publicUrl ?? ''}/admin` : 'disabled (set ADMIN_PASSWORD)'}`);
  console.log(`  read-only  : ${config.readOnly}`);
});
