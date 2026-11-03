/**
 * Code & Blocks WordPress MCP – admin UI (/admin)
 * Author: Code & Blocks by Marijan
 *
 * Server-rendered pages: sites (one-click connect via WordPress application
 * password authorization), approvals, activity, updates, skills, settings.
 */
import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { APP_NAME, APP_VERSION, config } from './config.js';
import type { AuthProvider } from './oauth.js';
import { WPClient, getClient } from './wp.js';
import * as store from './store.js';
import * as activity from './activity.js';
import * as approvals from './approvals.js';
import { deleteSkill, loadSkills, saveSkill } from './extras.js';
import { USER_AGENT } from './net.js';

export const APP_PASSWORD_NAME = 'Code & Blocks MCP';
export const APP_PASSWORD_ID = '6f1c3c2e-6c2b-4e43-9d8f-2a9c0b5d7e11';

// ---------- helpers ----------

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmtDate = (iso?: string | number) => {
  if (!iso) return '–';
  const d = typeof iso === 'number' ? new Date(iso * 1000) : new Date(iso);
  return d.toLocaleString('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

function safeEqual(a: string, b: string) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

interface Session {
  expires: number;
  csrf: string;
}
const sessions = new Map<string, Session>();
const COOKIE = 'cbmcp_admin';
const SESSION_MS = 12 * 3600 * 1000;

interface ConnectState {
  url: string;
  name?: string;
  restBase?: string;
  returnUrl?: string;
  sid: string;
  expires: number;
}
const connectStates = new Map<string, ConnectState>();

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function session(req: Request): (Session & { id: string }) | undefined {
  const id = readCookie(req, COOKIE);
  if (!id) return undefined;
  const s = sessions.get(id);
  if (!s || s.expires < Date.now()) {
    sessions.delete(id);
    return undefined;
  }
  return { id, ...s };
}

const secureCookie = () => (config.publicUrl ?? '').startsWith('https://');

// ---------- layout ----------

const NAV: [string, string][] = [
  ['/admin', 'Übersicht'],
  ['/admin/sites', 'Seiten'],
  ['/admin/approvals', 'Freigaben'],
  ['/admin/activity', 'Aktivität'],
  ['/admin/updates', 'Updates'],
  ['/admin/skills', 'Skills'],
  ['/admin/settings', 'Einstellungen'],
];

const CSS = `
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--fg:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#2f5d50;--accent-fg:#fff;--soft:#e7efe9;--warn:#9a6700;--warn-bg:#fff4e5;--err:#b3261e;--err-bg:#fbeaea;--ok:#1a7f37;--ok-bg:#e6f4ea;--code:#f1efe9}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#ecebe7;--muted:#a3a29d;--line:#2f2e2b;--accent:#7cc0a8;--accent-fg:#10201a;--soft:#22332d;--warn:#f0c674;--warn-bg:#3a2f12;--err:#f2b8b5;--err-bg:#3d1d1b;--ok:#8fd19e;--ok-bg:#1c3324;--code:#262624}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}code,pre{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}code{background:var(--code);padding:1px 5px;border-radius:4px}
pre{background:var(--code);padding:12px;border-radius:8px;overflow:auto;max-height:420px;white-space:pre-wrap;word-break:break-word}
.shell{display:grid;grid-template-columns:220px 1fr;min-height:100vh}
aside{border-right:1px solid var(--line);padding:20px 14px;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:4px}
.brand{font-weight:700;font-size:15px;margin:0 8px 18px;line-height:1.3}.brand small{display:block;font-weight:500;color:var(--muted);font-size:12px}
aside a{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-radius:8px;color:var(--fg);text-decoration:none}
aside a:hover{background:var(--soft)}aside a.on{background:var(--accent);color:var(--accent-fg)}
aside form{margin-top:auto}aside button{width:100%}
main{padding:28px 32px 60px;max-width:1100px;width:100%}
h1{font-size:24px;margin:0 0 6px}h2{font-size:17px;margin:0 0 12px}.lead{color:var(--muted);margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:0 0 18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}.grid .card{margin:0}
.big{font-size:30px;font-weight:700;line-height:1.1}.muted{color:var(--muted)}.small{font-size:13px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:13px;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}.nowrap{white-space:nowrap}
.btn,button{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:8px 14px;border-radius:8px;font:inherit;font-size:14px;cursor:pointer;text-decoration:none}
.btn.primary,button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}
.btn.danger,button.danger{color:var(--err);border-color:var(--err)}.btn.sm,button.sm{padding:4px 10px;font-size:13px}
button:disabled{opacity:.55;cursor:wait}
input[type=text],input[type=url],input[type=password],textarea{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
textarea{min-height:320px;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace}
label{display:block;font-weight:600;margin:0 0 6px}.field{margin:0 0 14px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.check{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin:6px 0}.check input{margin-top:4px}
.pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;background:var(--code);color:var(--muted);white-space:nowrap}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.err{background:var(--err-bg);color:var(--err)}.pill.wait{background:var(--warn-bg);color:var(--warn)}
.badge{background:var(--err);color:#fff;border-radius:999px;font-size:11px;padding:0 7px;line-height:18px}
.flash{padding:12px 14px;border-radius:10px;margin:0 0 18px}.flash.ok{background:var(--ok-bg);color:var(--ok)}.flash.err{background:var(--err-bg);color:var(--err)}.flash.warn{background:var(--warn-bg);color:var(--warn)}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--muted);margin-right:6px}.dot.ok{background:var(--ok)}.dot.err{background:var(--err)}
.copy{display:flex;gap:8px}.copy code{flex:1;padding:9px 11px;overflow:auto}
.login{min-height:100vh;display:grid;place-items:center;padding:16px}.login .card{width:100%;max-width:400px}
footer{color:var(--muted);font-size:12px;margin-top:30px}
@media (max-width:760px){.shell{grid-template-columns:1fr}aside{position:static;height:auto;flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--line)}.brand{width:100%;margin-bottom:6px}aside form{margin:0}main{padding:20px 16px}}
`;

function layout(req: Request, title: string, body: string, opts: { refresh?: number } = {}) {
  const pending = approvals.list('pending').length;
  const s = session(req);
  const nav = NAV.map(([href, label]) => {
    const on = href === '/admin' ? req.path === '/' || req.path === '' : (req.baseUrl + req.path).startsWith(href);
    const badge = href === '/admin/approvals' && pending ? `<span class="badge">${pending}</span>` : '';
    return `<a href="${href}" class="${on ? 'on' : ''}">${esc(label)}${badge}</a>`;
  }).join('');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} – ${esc(APP_NAME)}</title>${opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : ''}<style>${CSS}</style></head>
<body><div class="shell"><aside><div class="brand">Code &amp; Blocks MCP<small>Version ${esc(APP_VERSION)}</small></div>${nav}
<form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${esc(s?.csrf)}"><button class="sm">Abmelden</button></form></aside>
<main>${flash(req)}${body}<footer>Code &amp; Blocks by Marijan</footer></main></div></body></html>`;
}

function flash(req: Request) {
  const m = typeof req.query.msg === 'string' ? req.query.msg : '';
  if (!m) return '';
  const t = req.query.t === 'err' ? 'err' : req.query.t === 'warn' ? 'warn' : 'ok';
  return `<div class="flash ${t}">${esc(m)}</div>`;
}

const back = (res: Response, path: string, msg: string, type: 'ok' | 'err' | 'warn' = 'ok') =>
  res.redirect(303, `${path}${path.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}&t=${type}`);

const csrfField = (req: Request) => `<input type="hidden" name="csrf" value="${esc(session(req)?.csrf)}">`;

// ---------- site helpers ----------

async function discover(rawUrl: string) {
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

async function siteStatus(id: string) {
  const started = Date.now();
  const wp = getClient(id);
  const [root, me, bridge] = await Promise.allSettled([
    wp.get('/', { _fields: 'name,url' }),
    wp.get('/wp/v2/users/me', { context: 'edit', _fields: 'id,name,roles' }),
    wp.get('/cbmcp/v1/info'),
  ]);
  const ok = root.status === 'fulfilled' && me.status === 'fulfilled';
  const err = [root, me].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  const b = bridge.status === 'fulfilled' ? (bridge.value.data as any) : undefined;
  return {
    ok,
    ms: Date.now() - started,
    name: root.status === 'fulfilled' ? (root.value.data as any).name : undefined,
    user: me.status === 'fulfilled' ? (me.value.data as any).name : undefined,
    roles: me.status === 'fulfilled' ? (me.value.data as any).roles : undefined,
    bridge: b?.bridge_version,
    wp: b?.wp_version,
    php: b?.php_version,
    error: err ? (err.reason as Error).message : undefined,
  };
}

// ---------- router ----------

export function adminRouter(provider: AuthProvider): Router {
  const r = Router();
  r.use(express.urlencoded({ extended: false, limit: '300kb' }));
  r.use(express.json({ limit: '100kb' }));
  r.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'",
    );
    next();
  });

  if (!config.adminPassword) {
    r.use((_req, res) => {
      res.status(503).type('text/plain').send('Admin UI disabled: set ADMIN_PASSWORD.');
    });
    return r;
  }

  // ----- login -----
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, skipSuccessfulRequests: true, requestWasSuccessful: (_q, s) => s.statusCode < 400 });

  const loginPage = (next: string, error?: string) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anmelden – ${esc(APP_NAME)}</title><style>${CSS}</style></head>
<body><div class="login"><form class="card" method="post" action="/admin/login"><h1>Code &amp; Blocks MCP</h1><p class="lead">Verwaltung deines WordPress-MCP-Servers</p>
${error ? `<div class="flash err">${esc(error)}</div>` : ''}<input type="hidden" name="next" value="${esc(next)}">
<div class="field"><label for="pw">Admin-Passwort</label><input id="pw" type="password" name="password" required autofocus autocomplete="current-password"></div>
<button class="primary">Anmelden</button><footer>Code &amp; Blocks by Marijan</footer></form></div></body></html>`;

  r.get('/login', (req, res) => {
    res.send(loginPage(typeof req.query.next === 'string' ? req.query.next : '/admin'));
  });

  r.post('/login', loginLimiter, (req, res) => {
    const next = typeof req.body.next === 'string' && req.body.next.startsWith('/admin') ? req.body.next : '/admin';
    if (!safeEqual(String(req.body.password ?? ''), config.adminPassword!)) {
      console.warn(`[admin] failed login from ${req.ip}`);
      res.status(401).send(loginPage(next, 'Falsches Passwort.'));
      return;
    }
    const id = crypto.randomBytes(32).toString('base64url');
    sessions.set(id, { expires: Date.now() + SESSION_MS, csrf: crypto.randomBytes(24).toString('base64url') });
    res.cookie(COOKIE, id, { httpOnly: true, secure: secureCookie(), sameSite: 'lax', path: '/admin', maxAge: SESSION_MS });
    res.redirect(303, next);
  });

  // ----- auth + csrf -----
  r.use((req: Request, res: Response, next: NextFunction) => {
    const s = session(req);
    if (!s) {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        res.redirect(303, `/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      } else {
        res.status(401).json({ error: 'not_logged_in' });
      }
      return;
    }
    if (req.method !== 'GET' && req.path !== '/sites/callback') {
      const token = (req.body && req.body.csrf) || req.get('x-csrf-token');
      if (!token || !safeEqual(String(token), s.csrf)) {
        res.status(403).send('Ungültiges Formular (CSRF). Bitte Seite neu laden.');
        return;
      }
    }
    next();
  });

  r.post('/logout', (req, res) => {
    const s = session(req);
    if (s) sessions.delete(s.id);
    res.clearCookie(COOKIE, { path: '/admin' });
    res.redirect(303, '/admin/login');
  });

  // ----- dashboard -----
  r.get('/', (req, res) => {
    const sites = store.listSites();
    const pending = approvals.list('pending');
    const recent = activity.recent(8);
    const mcpUrl = `${config.publicUrl ?? ''}/mcp`;
    res.send(
      layout(
        req,
        'Übersicht',
        `<h1>Übersicht</h1><p class="lead">Dein selbst gehosteter MCP-Server für WordPress.</p>
<div class="grid">
<div class="card"><h2>Seiten</h2><div class="big">${sites.length}</div><p class="muted small">verbunden</p><a class="btn sm" href="/admin/sites">Seiten verwalten</a></div>
<div class="card"><h2>Freigaben</h2><div class="big">${pending.length}</div><p class="muted small">warten auf dich</p><a class="btn sm" href="/admin/approvals">Öffnen</a></div>
<div class="card"><h2>Modus</h2><div class="big" style="font-size:20px">${config.readOnly ? 'Nur lesen' : 'Lesen &amp; schreiben'}</div><p class="muted small">Freigaben ${store.approvalSettings().enabled ? 'aktiv' : 'aus'}</p><a class="btn sm" href="/admin/settings">Einstellungen</a></div>
</div>
<div class="card" style="margin-top:18px"><h2>Connector für Claude</h2><p class="muted small">In Claude unter Einstellungen → Connectors einen eigenen Connector mit dieser Adresse hinzufügen. Bei der Anmeldung dein Admin-Passwort eingeben.</p>
<div class="copy"><code id="mcpurl">${esc(mcpUrl)}</code><button type="button" class="sm" onclick="navigator.clipboard.writeText(document.getElementById('mcpurl').textContent);this.textContent='Kopiert'">Kopieren</button></div></div>
<div class="card"><h2>Seitenstatus</h2>${sites.length ? `<table><tbody>${sites.map((s) => `<tr><td><span class="dot" data-status="${esc(s.id)}"></span><a href="/admin/sites/${esc(s.id)}">${esc(s.name)}</a> <span class="muted small">${esc(s.url)}</span></td><td class="small muted" data-info="${esc(s.id)}">prüfe…</td></tr>`).join('')}</tbody></table>` : `<p>Noch keine Seite verbunden. <a href="/admin/sites">Jetzt verbinden</a></p>`}</div>
<div class="card"><h2>Letzte Aktivität</h2>${activityTable(recent, false)}<p><a href="/admin/activity">Alle anzeigen</a></p></div>
<script>${STATUS_JS}</script>`,
      ),
    );
  });

  // ----- sites -----
  r.get('/sites', (req, res) => {
    const sites = store.listSites();
    res.send(
      layout(
        req,
        'Seiten',
        `<h1>Seiten</h1><p class="lead">WordPress-Seiten, auf die Claude zugreifen kann.</p>
<div class="card"><h2>Neue Seite verbinden</h2>
<form method="post" action="/admin/sites/connect">${csrfField(req)}
<div class="field"><label for="url">Adresse der WordPress-Seite</label><input id="url" type="url" name="url" placeholder="https://deine-seite.at" required></div>
<div class="field"><label for="name">Name (optional)</label><input id="name" type="text" name="name" placeholder="z. B. Mein Blog"></div>
<button class="primary">Weiter zu WordPress</button>
<p class="muted small">Du bestätigst die Verbindung in WordPress (dort angemeldet als Administrator). WordPress erstellt dabei ein Anwendungspasswort, das verschlüsselt auf diesem Server gespeichert wird. Tipp: Das Plugin „Code &amp; Blocks MCP Bridge“ hat dafür auch einen Knopf.</p></form></div>
<div class="card"><h2>Verbundene Seiten</h2>${
          sites.length
            ? `<table><thead><tr><th>Seite</th><th>Benutzer</th><th>Status</th><th></th></tr></thead><tbody>${sites
                .map(
                  (s) =>
                    `<tr><td><a href="/admin/sites/${esc(s.id)}"><strong>${esc(s.name)}</strong></a>${s.default ? ' <span class="pill">Standard</span>' : ''}<br><span class="muted small">${esc(s.url)} · ID <code>${esc(s.id)}</code></span></td><td>${esc(s.user)}</td><td><span class="dot" data-status="${esc(s.id)}"></span><span class="small muted" data-info="${esc(s.id)}">prüfe…</span></td><td class="nowrap"><a class="btn sm" href="/admin/sites/${esc(s.id)}">Details</a></td></tr>`,
                )
                .join('')}</tbody></table>`
            : '<p class="muted">Noch keine Seite verbunden.</p>'
        }</div><script>${STATUS_JS}</script>`,
      ),
    );
  });

  const startConnect = async (req: Request, res: Response, url: string, name?: string, returnUrl?: string) => {
    if (!config.publicUrl?.startsWith('https://') && !/localhost|127\.0\.0\.1/.test(config.publicUrl ?? '')) {
      return back(res, '/admin/sites', 'PUBLIC_URL muss mit https:// beginnen, damit WordPress zurückleiten kann.', 'err');
    }
    let d: Awaited<ReturnType<typeof discover>>;
    try {
      d = await discover(url);
    } catch (e) {
      return back(res, '/admin/sites', (e as Error).message, 'err');
    }
    if (returnUrl) {
      try {
        if (new URL(returnUrl).hostname !== new URL(d.url).hostname) returnUrl = undefined;
      } catch {
        returnUrl = undefined;
      }
    }
    const state = crypto.randomBytes(16).toString('hex');
    const s = session(req)!;
    connectStates.set(state, { url: d.url, name: name || d.name, restBase: d.restBase, returnUrl, sid: s.id, expires: Date.now() + 20 * 60 * 1000 });
    const cb = `${config.publicUrl}/admin/sites/callback?state=${state}`;
    const target = new URL(d.authUrl);
    target.searchParams.set('app_name', APP_PASSWORD_NAME);
    target.searchParams.set('app_id', APP_PASSWORD_ID);
    target.searchParams.set('success_url', cb);
    target.searchParams.set('reject_url', `${cb}&rejected=1`);
    res.redirect(303, target.href);
  };

  r.post('/sites/connect', async (req, res) => {
    await startConnect(req, res, String(req.body.url ?? ''), String(req.body.name ?? '').trim() || undefined, typeof req.body.return === 'string' ? req.body.return : undefined);
  });

  // Entry point from the WordPress plugin button: confirm first (no silent redirects).
  r.get('/connect', (req, res) => {
    const site = typeof req.query.site === 'string' ? req.query.site : '';
    const ret = typeof req.query.return === 'string' ? req.query.return : '';
    res.send(
      layout(
        req,
        'Seite verbinden',
        `<h1>Seite verbinden</h1><div class="card"><p>Soll diese WordPress-Seite mit deinem MCP-Server verbunden werden?</p><p><code>${esc(site)}</code></p>
<form method="post" action="/admin/sites/connect">${csrfField(req)}<input type="hidden" name="url" value="${esc(site)}"><input type="hidden" name="return" value="${esc(ret)}">
<div class="row"><button class="primary">Ja, weiter zu WordPress</button><a class="btn" href="/admin">Abbrechen</a></div></form>
<p class="muted small">Im nächsten Schritt bestätigst du in WordPress die Freigabe für „${esc(APP_PASSWORD_NAME)}“.</p></div>`,
      ),
    );
  });

  r.get('/sites/callback', async (req, res) => {
    const state = String(req.query.state ?? '');
    const st = connectStates.get(state);
    connectStates.delete(state);
    const s = session(req);
    if (!st || st.expires < Date.now() || !s || st.sid !== s.id) return back(res, '/admin/sites', 'Die Verbindungsanfrage ist abgelaufen oder ungültig. Bitte erneut starten.', 'err');
    if (req.query.rejected || req.query.success === 'false') return back(res, '/admin/sites', 'Die Verbindung wurde in WordPress abgelehnt.', 'warn');
    const user = String(req.query.user_login ?? '');
    const password = String(req.query.password ?? '');
    if (!user || !password) return back(res, '/admin/sites', 'WordPress hat keine Zugangsdaten zurückgegeben.', 'err');

    const probe = new WPClient({ id: 'probe', url: st.url, user, appPassword: password.replace(/\s+/g, ''), restBase: st.restBase ?? `${st.url}/wp-json` });
    let warn = '';
    try {
      const me = (await probe.get('/wp/v2/users/me', { context: 'edit', _fields: 'id,name,roles,capabilities' })).data as any;
      if (!me?.capabilities?.manage_options) warn = ' Hinweis: Dieser Benutzer ist kein Administrator. Plugins, Themes, Dateien und Einstellungen sind damit nicht möglich.';
    } catch (e) {
      return back(res, '/admin/sites', `Zugangsdaten erhalten, aber die Anmeldung an der REST API schlägt fehl: ${(e as Error).message}`, 'err');
    }
    const id = store.upsertSite({ url: st.url, user, appPassword: password, name: st.name, restBase: st.restBase });
    activity.record({ site: id, tool: 'connect_site', kind: 'change', status: 'ok', summary: `Seite verbunden (${user})`, source: 'ui' });
    if (st.returnUrl) {
      const u = new URL(st.returnUrl);
      u.searchParams.set('cbmcp_connected', '1');
      return res.redirect(303, u.href);
    }
    back(res, `/admin/sites/${id}`, `Verbunden.${warn}`, warn ? 'warn' : 'ok');
  });

  r.get('/sites/:id', (req, res) => {
    const s = store.getSite(req.params.id);
    if (!s) return back(res, '/admin/sites', 'Seite nicht gefunden.', 'err');
    const acts = activity.recent(20, s.id);
    res.send(
      layout(
        req,
        s.name,
        `<h1>${esc(s.name)}</h1><p class="lead"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a> · ID <code>${esc(s.id)}</code>${s.default ? ' · <span class="pill">Standard</span>' : ''}</p>
<div class="grid"><div class="card"><h2>Status</h2><p><span class="dot" data-status="${esc(s.id)}"></span><span data-info="${esc(s.id)}" class="small">prüfe…</span></p>
<p class="small muted">Benutzer: ${esc(s.user)} · verbunden ${esc(fmtDate(s.createdAt))}${s.source === 'env' ? ' · aus Umgebungsvariablen übernommen' : ''}</p></div>
<div class="card"><h2>Name</h2><form method="post" action="/admin/sites/${esc(s.id)}/rename">${csrfField(req)}<div class="row"><input type="text" name="name" value="${esc(s.name)}" style="flex:1"><button class="sm">Speichern</button></div></form>
${s.default ? '' : `<form method="post" action="/admin/sites/${esc(s.id)}/default" style="margin-top:10px">${csrfField(req)}<button class="sm">Als Standardseite festlegen</button></form>`}</div></div>
<div class="card" style="margin-top:18px"><h2>Aktivität</h2>${activityTable(acts, false)}</div>
<div class="card"><h2>Verbindung erneuern oder trennen</h2><div class="row">
<form method="post" action="/admin/sites/connect">${csrfField(req)}<input type="hidden" name="url" value="${esc(s.url)}"><input type="hidden" name="name" value="${esc(s.name)}"><button class="sm">Neu verbinden</button></form>
<form method="post" action="/admin/sites/${esc(s.id)}/delete" onsubmit="return confirm('Seite trennen? Claude hat danach keinen Zugriff mehr.')">${csrfField(req)}<label class="check"><input type="checkbox" name="revoke" value="1" checked> Anwendungspasswort in WordPress widerrufen</label><button class="sm danger">Seite trennen</button></form>
</div></div><script>${STATUS_JS}</script>`,
      ),
    );
  });

  r.post('/sites/:id/rename', (req, res) => {
    store.renameSite(req.params.id, String(req.body.name ?? '').trim());
    back(res, `/admin/sites/${req.params.id}`, 'Gespeichert.');
  });

  r.post('/sites/:id/default', (req, res) => {
    store.makeDefault(req.params.id);
    back(res, `/admin/sites/${req.params.id}`, 'Ist jetzt die Standardseite.');
  });

  r.post('/sites/:id/delete', async (req, res) => {
    const id = req.params.id;
    let note = '';
    if (req.body.revoke) {
      try {
        const wp = getClient(id);
        const list = (await wp.get('/wp/v2/users/me/application-passwords')).data as any[];
        const ours = list.filter((p) => p.app_id === APP_PASSWORD_ID || p.name === APP_PASSWORD_NAME);
        for (const p of ours) await wp.delete(`/wp/v2/users/me/application-passwords/${p.uuid}`);
        note = ` ${ours.length} Anwendungspasswort(e) in WordPress widerrufen.`;
      } catch (e) {
        note = ` Widerruf in WordPress fehlgeschlagen (${(e as Error).message}) – bitte dort unter Profil → Anwendungspasswörter löschen.`;
      }
    }
    activity.record({ site: id, tool: 'disconnect_site', kind: 'change', status: 'ok', summary: 'Seite getrennt', source: 'ui' });
    store.removeSite(id);
    back(res, '/admin/sites', `Seite getrennt.${note}`);
  });

  r.get('/api/sites/:id/status', async (req, res) => {
    try {
      res.json(await siteStatus(req.params.id));
    } catch (e) {
      res.json({ ok: false, error: (e as Error).message });
    }
  });

  // ----- approvals -----
  r.get('/approvals', (req, res) => {
    const pending = approvals.list('pending');
    const done = approvals.list().filter((a) => a.status !== 'pending').slice(0, 40);
    res.send(
      layout(
        req,
        'Freigaben',
        `<h1>Freigaben</h1><p class="lead">Riskante Aktionen von Claude warten hier auf deine Bestätigung. Welche Aktionen das sind, legst du in den <a href="/admin/settings">Einstellungen</a> fest.</p>
<div class="card"><h2>Offen</h2>${pending.length ? approvalTable(pending) : '<p class="muted">Keine offenen Freigaben.</p>'}</div>
<div class="card"><h2>Verlauf</h2>${done.length ? approvalTable(done) : '<p class="muted">Noch nichts.</p>'}</div>`,
        { refresh: pending.length ? 10 : 30 },
      ),
    );
  });

  r.get('/approvals/:id', (req, res) => {
    const a = approvals.get(req.params.id);
    if (!a) return back(res, '/admin/approvals', 'Freigabe nicht gefunden.', 'err');
    const site = a.site ? store.getSite(a.site) : undefined;
    res.send(
      layout(
        req,
        'Freigabe',
        `<h1>Freigabe</h1><p class="lead">${esc(a.summary)}</p>
<div class="card"><table><tbody>
<tr><th>Status</th><td>${statusPill(a.status)}</td></tr><tr><th>Aktion</th><td><code>${esc(a.tool)}</code></td></tr>
<tr><th>Seite</th><td>${site ? `${esc(site.name)} <span class="muted small">${esc(site.url)}</span>` : esc(a.site ?? '–')}</td></tr>
<tr><th>Angefragt</th><td>${esc(fmtDate(a.created))}</td></tr></tbody></table>
<h2 style="margin-top:16px">Details</h2><pre>${esc(JSON.stringify(a.args, null, 2))}</pre>
${a.status === 'pending' ? `<div class="row"><form method="post" action="/admin/approvals/${esc(a.id)}">${csrfField(req)}<input type="hidden" name="decision" value="approve"><button class="primary">Freigeben</button></form>
<form method="post" action="/admin/approvals/${esc(a.id)}">${csrfField(req)}<input type="hidden" name="decision" value="decline"><button class="danger">Ablehnen</button></form></div>
<p class="muted small">Nach der Freigabe führt Claude die Aktion aus. Falls Claude nicht mehr wartet, schreib im Chat „freigegeben“.</p>` : ''}</div>`,
      ),
    );
  });

  r.post('/approvals/:id', (req, res) => {
    const a = approvals.decide(req.params.id, req.body.decision === 'approve');
    if (!a) return back(res, '/admin/approvals', 'Freigabe nicht gefunden.', 'err');
    back(res, `/admin/approvals/${a.id}`, a.status === 'approved' ? 'Freigegeben.' : a.status === 'declined' ? 'Abgelehnt.' : `Status: ${a.status}`);
  });

  // ----- activity -----
  r.get('/activity', (req, res) => {
    const site = typeof req.query.site === 'string' && req.query.site ? req.query.site : undefined;
    const sites = store.listSites();
    res.send(
      layout(
        req,
        'Aktivität',
        `<h1>Aktivität</h1><p class="lead">Alle Änderungen über den MCP-Server und diese Oberfläche.</p>
<form class="row" method="get" action="/admin/activity" style="margin-bottom:14px"><select name="site" onchange="this.form.submit()" style="padding:8px;border-radius:8px"><option value="">Alle Seiten</option>${sites.map((s) => `<option value="${esc(s.id)}"${s.id === site ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></form>
<div class="card">${activityTable(activity.recent(300, site), true)}</div>`,
      ),
    );
  });

  // ----- updates -----
  r.get('/updates', (req, res) => {
    const sites = store.listSites();
    res.send(
      layout(
        req,
        'Updates',
        `<h1>Updates</h1><p class="lead">Plugin-, Theme- und WordPress-Updates aller Seiten. Benötigt das Bridge-Plugin ab Version 1.2. Vor Core-Updates ein Backup machen.</p>
<div class="row" style="margin-bottom:16px"><button class="primary" type="button" onclick="cbAll(true)">Alle Seiten neu prüfen</button></div>
${sites.map((s) => `<div class="card" data-upd="${esc(s.id)}"><h2>${esc(s.name)} <span class="muted small">${esc(s.url)}</span></h2><div class="body muted small">lädt…</div></div>`).join('') || '<p class="muted">Noch keine Seite verbunden.</p>'}
<script>window.CSRF=${JSON.stringify(session(req)?.csrf ?? '')};${UPDATES_JS}</script>`,
      ),
    );
  });

  r.get('/api/sites/:id/updates', async (req, res) => {
    try {
      const wp = getClient(req.params.id);
      res.json((await wp.get('/cbmcp/v1/updates/list', { refresh: req.query.refresh ? 1 : undefined })).data);
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  r.post('/api/sites/:id/updates', async (req, res) => {
    const type = String(req.body.type ?? '');
    const items = Array.isArray(req.body.items) ? req.body.items.map(String) : [];
    if (!['plugin', 'theme', 'core'].includes(type)) return void res.status(400).json({ error: 'type' });
    try {
      const wp = getClient(req.params.id);
      const out = (await wp.request('POST', '/cbmcp/v1/updates/run', { body: { type, items }, timeoutMs: 600_000 })).data as any;
      const okN = (out.results ?? []).filter((x: any) => x.ok).length;
      activity.record({ site: req.params.id, tool: 'manage_updates', kind: 'change', status: 'ok', summary: `Updates (${type}): ${okN}/${(out.results ?? []).length} erfolgreich`, source: 'ui' });
      res.json(out);
    } catch (e) {
      activity.record({ site: req.params.id, tool: 'manage_updates', kind: 'change', status: 'error', summary: `Updates (${type}) fehlgeschlagen: ${(e as Error).message}`, source: 'ui' });
      res.status(502).json({ error: (e as Error).message });
    }
  });

  // ----- skills -----
  r.get('/skills', (req, res) => {
    const skills = loadSkills();
    res.send(
      layout(
        req,
        'Skills',
        `<h1>Skills</h1><p class="lead">Arbeitsanleitungen, die Claude bei Bedarf lädt. Eigene Skills überschreiben mitgelieferte mit gleichem Namen.</p>
<div class="row" style="margin-bottom:16px"><a class="btn primary" href="/admin/skills/_new">Neuer Skill</a></div>
<div class="card"><table><thead><tr><th>Name</th><th>Beschreibung</th><th>Quelle</th></tr></thead><tbody>${skills
          .map((s) => `<tr><td><a href="/admin/skills/${esc(s.name)}"><strong>${esc(s.name)}</strong></a></td><td class="small">${esc(s.description)}</td><td><span class="pill${s.source === 'saved' ? ' ok' : ''}">${s.source === 'saved' ? 'eigener' : 'mitgeliefert'}</span></td></tr>`)
          .join('')}</tbody></table></div>`,
      ),
    );
  });

  r.get('/skills/:name', (req, res) => {
    const isNew = req.params.name === '_new';
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const s = loadSkills().find((x) => x.name === (isNew ? from : req.params.name));
    if (!isNew && !s) return back(res, '/admin/skills', 'Skill nicht gefunden.', 'err');
    const editable = isNew || s!.source === 'saved';
    const name = isNew ? (from ? `${from}` : '') : s!.name;
    res.send(
      layout(
        req,
        isNew ? 'Neuer Skill' : s!.name,
        `<h1>${isNew ? 'Neuer Skill' : esc(s!.name)}</h1>
${editable ? `<form class="card" method="post" action="/admin/skills">${csrfField(req)}
<div class="field"><label for="n">Name</label><input id="n" type="text" name="name" value="${esc(name)}" pattern="[a-z0-9][a-z0-9-]{1,60}" required ${isNew ? '' : 'readonly'}></div>
<div class="field"><label for="d">Beschreibung (wann soll Claude den Skill laden?)</label><input id="d" type="text" name="description" value="${esc(s?.description ?? '')}" required></div>
<div class="field"><label for="c">Inhalt (Markdown)</label><textarea id="c" name="content" required>${esc(s?.content ?? '')}</textarea></div>
<div class="row"><button class="primary">Speichern</button><a class="btn" href="/admin/skills">Zurück</a></div></form>
${!isNew ? `<form method="post" action="/admin/skills/${esc(s!.name)}/delete" onsubmit="return confirm('Skill löschen?')">${csrfField(req)}<button class="sm danger">Löschen</button></form>` : ''}`
  : `<div class="card"><p class="muted small">${esc(s!.description)}</p><pre>${esc(s!.content)}</pre><div class="row"><a class="btn primary" href="/admin/skills/_new?from=${esc(s!.name)}">Als eigenen Skill bearbeiten</a><a class="btn" href="/admin/skills">Zurück</a></div></div>`}`,
      ),
    );
  });

  r.post('/skills', (req, res) => {
    try {
      saveSkill(String(req.body.name ?? ''), String(req.body.description ?? ''), String(req.body.content ?? ''));
      activity.record({ tool: 'skill_save', kind: 'change', status: 'ok', summary: `Skill gespeichert: ${req.body.name}`, source: 'ui' });
      back(res, `/admin/skills/${encodeURIComponent(String(req.body.name))}`, 'Gespeichert.');
    } catch (e) {
      back(res, '/admin/skills', (e as Error).message, 'err');
    }
  });

  r.post('/skills/:name/delete', (req, res) => {
    deleteSkill(req.params.name);
    back(res, '/admin/skills', 'Skill gelöscht.');
  });

  // ----- settings -----
  const settingsPage = (req: Request, newToken?: string) => {
    const st = store.getSettings();
    const clients = provider.stats();
    return layout(
      req,
      'Einstellungen',
      `<h1>Einstellungen</h1>
${newToken ? `<div class="flash warn"><strong>Neuer Token – nur jetzt sichtbar:</strong><div class="copy" style="margin-top:8px"><code id="tok">${esc(newToken)}</code><button type="button" class="sm" onclick="navigator.clipboard.writeText(document.getElementById('tok').textContent);this.textContent='Kopiert'">Kopieren</button></div></div>` : ''}
<form class="card" method="post" action="/admin/settings">${csrfField(req)}<h2>Zugriff</h2>
<label class="check"><input type="checkbox" name="readOnly" value="1"${st.readOnly || st.envReadOnly ? ' checked' : ''}${st.envReadOnly ? ' disabled' : ''}> <span><strong>Nur lesen</strong><br><span class="muted small">Claude kann nichts verändern, nur lesen und prüfen.${st.envReadOnly ? ' (Durch READ_ONLY in Coolify festgelegt.)' : ''}</span></span></label>
<h2 style="margin-top:18px">Freigaben</h2>
<label class="check"><input type="checkbox" name="approvals" value="1"${st.approvals.enabled ? ' checked' : ''}> <span><strong>Riskante Aktionen erst nach Freigabe ausführen</strong><br><span class="muted small">Claude wartet kurz auf deine Bestätigung unter „Freigaben“ (auch als Hinweis in wp-admin).</span></span></label>
<div style="columns:2 260px;margin:8px 0 0 26px">${Object.entries(store.APPROVAL_TOOLS)
        .map(([k, label]) => `<label class="check"><input type="checkbox" name="tool_${esc(k)}" value="1"${st.approvals.tools.includes(k) ? ' checked' : ''}> <span>${esc(label)} <code class="small">${esc(k)}</code></span></label>`)
        .join('')}</div>
<p style="margin-top:14px"><button class="primary">Speichern</button></p></form>
<form class="card" method="post" action="/admin/settings/keys">${csrfField(req)}<h2>Stockbilder</h2>
<div class="field"><label for="px">Pexels API-Key ${st.pexelsSet ? `<span class="pill ok">gesetzt${st.pexelsFromEnv ? ' (Coolify)' : ''}</span>` : ''}</label><input id="px" type="password" name="pexels" placeholder="${st.pexelsSet ? 'unverändert lassen' : 'Key von pexels.com/api'}" autocomplete="off"></div>
<div class="field"><label for="us">Unsplash Access Key ${st.unsplashSet ? `<span class="pill ok">gesetzt${st.unsplashFromEnv ? ' (Coolify)' : ''}</span>` : ''}</label><input id="us" type="password" name="unsplash" placeholder="${st.unsplashSet ? 'unverändert lassen' : 'Access Key von unsplash.com/developers'}" autocomplete="off"></div>
<label class="check"><input type="checkbox" name="clear" value="1"> In der Oberfläche gespeicherte Keys löschen</label>
<p><button>Speichern</button></p></form>
<div class="card"><h2>Token für Claude Code</h2><p class="small muted">Für Claude Code, Skripte und andere Clients ohne Anmeldeseite: <code>Authorization: Bearer &lt;Token&gt;</code>. ${st.tokenHint ? `Aktueller Token: <code>${esc(st.tokenHint)}</code>.` : 'Noch kein Token in der Oberfläche erzeugt.'} ${config.mcpToken ? 'Zusätzlich gilt der MCP_TOKEN aus Coolify.' : ''}</p>
<div class="row"><form method="post" action="/admin/settings/token">${csrfField(req)}<button>${st.tokenHint ? 'Neuen Token erzeugen' : 'Token erzeugen'}</button></form>
${st.tokenHint ? `<form method="post" action="/admin/settings/token/clear" onsubmit="return confirm('Token löschen?')">${csrfField(req)}<button class="danger">Token löschen</button></form>` : ''}</div></div>
<div class="card"><h2>Verbundene Claude-Clients</h2>${clients.length ? `<table><thead><tr><th>Client</th><th>Registriert</th><th>Sitzungen</th></tr></thead><tbody>${clients.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(fmtDate(c.registered))}</td><td>${c.sessions}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Keine aktiven Sitzungen.</p>'}
<form method="post" action="/admin/settings/sessions/revoke" onsubmit="return confirm('Alle Claude-Verbindungen abmelden?')" style="margin-top:12px">${csrfField(req)}<button class="sm danger">Alle abmelden</button></form></div>
<div class="card"><h2>Server</h2><table><tbody><tr><th>Version</th><td>${esc(APP_VERSION)}</td></tr><tr><th>Öffentliche Adresse</th><td>${esc(config.publicUrl)}</td></tr><tr><th>Daten</th><td><code>${esc(config.dataDir)}</code> (verschlüsselt mit AES-256-GCM)</td></tr></tbody></table></div>`,
    );
  };

  r.get('/settings', (req, res) => {
    res.send(settingsPage(req));
  });

  r.post('/settings', (req, res) => {
    const tools = Object.keys(store.APPROVAL_TOOLS).filter((k) => req.body[`tool_${k}`]);
    store.updateSettings({ readOnly: Boolean(req.body.readOnly), approvals: { enabled: Boolean(req.body.approvals), tools } });
    activity.record({ tool: 'settings', kind: 'change', status: 'ok', summary: `Einstellungen geändert (nur lesen: ${req.body.readOnly ? 'ja' : 'nein'}, Freigaben: ${req.body.approvals ? 'an' : 'aus'})`, source: 'ui' });
    back(res, '/admin/settings', 'Gespeichert.');
  });

  r.post('/settings/keys', (req, res) => {
    if (req.body.clear) store.updateSettings({ pexels: null, unsplash: null });
    else {
      const px = String(req.body.pexels ?? '').trim();
      const us = String(req.body.unsplash ?? '').trim();
      store.updateSettings({ pexels: px || undefined, unsplash: us || undefined });
    }
    back(res, '/admin/settings', 'Gespeichert.');
  });

  r.post('/settings/token', (req, res) => {
    const token = store.rotateToken();
    activity.record({ tool: 'settings', kind: 'change', status: 'ok', summary: 'Neuer Token für Claude Code erzeugt', source: 'ui' });
    res.send(settingsPage(req, token));
  });

  r.post('/settings/token/clear', (req, res) => {
    store.clearToken();
    back(res, '/admin/settings', 'Token gelöscht.');
  });

  r.post('/settings/sessions/revoke', (req, res) => {
    provider.revokeAll();
    activity.record({ tool: 'settings', kind: 'change', status: 'ok', summary: 'Alle Claude-Sitzungen abgemeldet', source: 'ui' });
    back(res, '/admin/settings', 'Alle Claude-Clients wurden abgemeldet.');
  });

  setInterval(() => {
    const t = Date.now();
    for (const [k, s] of sessions) if (s.expires < t) sessions.delete(k);
    for (const [k, s] of connectStates) if (s.expires < t) connectStates.delete(k);
  }, 10 * 60 * 1000).unref();

  return r;
}

// ---------- fragments ----------

function statusPill(s: string) {
  const map: Record<string, [string, string]> = {
    ok: ['ok', 'OK'],
    error: ['err', 'Fehler'],
    pending: ['wait', 'wartet'],
    approved: ['ok', 'freigegeben'],
    declined: ['err', 'abgelehnt'],
    used: ['ok', 'ausgeführt'],
    expired: ['', 'abgelaufen'],
  };
  const [cls, label] = map[s] ?? ['', s];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}

function activityTable(list: activity.ActivityEvent[], withSite: boolean) {
  if (!list.length) return '<p class="muted">Noch keine Aktivität.</p>';
  const names = new Map(store.listSites().map((s) => [s.id, s.name]));
  return `<table><thead><tr><th>Zeit</th>${withSite ? '<th>Seite</th>' : ''}<th>Aktion</th><th>Status</th><th></th></tr></thead><tbody>${list
    .map(
      (e) =>
        `<tr><td class="nowrap small">${esc(fmtDate(e.ts))}</td>${withSite ? `<td class="small">${esc(e.site ? (names.get(e.site) ?? e.site) : '–')}</td>` : ''}<td><code class="small">${esc(e.tool)}</code> ${esc(e.summary)}${e.source === 'ui' ? ' <span class="pill">UI</span>' : ''}</td><td>${statusPill(e.status)}</td><td class="nowrap small">${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener">${e.kind === 'approval' ? 'Öffnen' : 'Ansehen'}</a>` : ''}${e.edit_link ? ` · <a href="${esc(e.edit_link)}" target="_blank" rel="noopener">Bearbeiten</a>` : ''}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function approvalTable(list: approvals.Approval[]) {
  const names = new Map(store.listSites().map((s) => [s.id, s.name]));
  return `<table><thead><tr><th>Zeit</th><th>Seite</th><th>Aktion</th><th>Status</th><th></th></tr></thead><tbody>${list
    .map(
      (a) =>
        `<tr><td class="nowrap small">${esc(fmtDate(a.created))}</td><td class="small">${esc(a.site ? (names.get(a.site) ?? a.site) : '–')}</td><td>${esc(a.summary)}</td><td>${statusPill(a.status)}</td><td><a class="btn sm${a.status === 'pending' ? ' primary' : ''}" href="/admin/approvals/${esc(a.id)}">${a.status === 'pending' ? 'Prüfen' : 'Details'}</a></td></tr>`,
    )
    .join('')}</tbody></table>`;
}

const STATUS_JS = `
document.querySelectorAll('[data-status]').forEach(function(dot){
  var id=dot.getAttribute('data-status');var info=document.querySelector('[data-info="'+id+'"]');
  fetch('/admin/api/sites/'+encodeURIComponent(id)+'/status').then(function(r){return r.json()}).then(function(s){
    dot.className='dot '+(s.ok?'ok':'err');
    if(info){info.textContent=s.ok?('Erreichbar · '+(s.bridge?('Bridge '+s.bridge):'ohne Bridge-Plugin')+(s.wp?(' · WP '+s.wp):'')+' · '+s.ms+' ms'):('Fehler: '+(s.error||'unbekannt'));}
  }).catch(function(){dot.className='dot err';if(info)info.textContent='Fehler';});
});`;

const UPDATES_JS = `
function h(t,a,c){var e=document.createElement(t);if(a)for(var k in a)e.setAttribute(k,a[k]);if(c!=null)e.textContent=c;return e;}
function run(id,type,items,btn){
  if(type==='core'&&!confirm('WordPress-Core jetzt aktualisieren? Vorher ein Backup machen.'))return;
  btn.disabled=true;btn.textContent='Aktualisiere…';
  fetch('/admin/api/sites/'+encodeURIComponent(id)+'/updates',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':window.CSRF},body:JSON.stringify({type:type,items:items})})
  .then(function(r){return r.json()}).then(function(res){
    if(res.error){alert('Fehler: '+res.error);}
    else{var ok=(res.results||[]).filter(function(x){return x.ok}).length;alert(ok+' von '+(res.results||[]).length+' erfolgreich'+(res.errors&&res.errors.length?'\\n'+res.errors:''));}
    load(id,false);
  }).catch(function(e){alert('Fehler: '+e);load(id,false);});
}
function section(id,title,list,type,key){
  var wrap=h('div');wrap.appendChild(h('h3',{style:'font-size:15px;margin:14px 0 6px'},title+' ('+list.length+')'));
  if(!list.length){wrap.appendChild(h('p',{class:'muted small'},'Alles aktuell.'));return wrap;}
  var t=h('table');var tb=h('tbody');list.forEach(function(it){
    var tr=h('tr');tr.appendChild(h('td',null,it.name));tr.appendChild(h('td',{class:'small muted nowrap'},it.version+' → '+it.new_version));
    var td=h('td',{class:'nowrap'});var b=h('button',{class:'sm',type:'button'},'Aktualisieren');b.onclick=function(){run(id,type,[it[key]],b)};td.appendChild(b);tr.appendChild(td);tb.appendChild(tr);
  });t.appendChild(tb);wrap.appendChild(t);
  var all=h('button',{class:'sm primary',type:'button',style:'margin-top:8px'},'Alle '+title+' aktualisieren');all.onclick=function(){run(id,type,[],all)};wrap.appendChild(all);
  return wrap;
}
function load(id,refresh){
  var card=document.querySelector('[data-upd="'+id+'"] .body');card.className='body muted small';card.textContent='lädt…';
  fetch('/admin/api/sites/'+encodeURIComponent(id)+'/updates'+(refresh?'?refresh=1':'')).then(function(r){return r.json()}).then(function(d){
    card.className='body';card.textContent='';
    if(d.error){card.appendChild(h('p',{class:'flash err'},d.error));return;}
    if(!d.can_update)card.appendChild(h('p',{class:'flash warn'},'WordPress kann hier keine Dateien direkt schreiben ('+d.fs_method+'). Updates bitte in wp-admin installieren.'));
    var core=h('p');core.textContent='WordPress '+d.core.version+(d.core.new_version?' → '+d.core.new_version+' verfügbar':' (aktuell)');card.appendChild(core);
    if(d.core.new_version){var cb=h('button',{class:'sm danger',type:'button'},'WordPress aktualisieren');cb.onclick=function(){run(id,'core',[],cb)};card.appendChild(cb);}
    card.appendChild(section(id,'Plugins',d.plugins,'plugin','plugin'));
    card.appendChild(section(id,'Themes',d.themes,'theme','theme'));
    card.appendChild(h('p',{class:'muted small'},'Geprüft: '+new Date(d.checked_utc).toLocaleString('de-AT')));
  }).catch(function(e){card.textContent='Fehler: '+e;});
}
function cbAll(refresh){document.querySelectorAll('[data-upd]').forEach(function(c){load(c.getAttribute('data-upd'),refresh)});}
cbAll(false);`;
