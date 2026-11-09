/**
 * Code & Blocks WordPress MCP – operator UI and customer portal (/admin)
 * Author: Code & Blocks by Marijan
 *
 * Operator: password (+ 2FA). Manages customers (workspaces), limits, skills,
 * and can open a customer's view (logged in the access log).
 * Customer: signs in with WordPress (SSO). Sees and manages only their own
 * workspace: sites, approvals, activity, updates, keys, privacy settings,
 * tokens, export and deletion.
 */
import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { APP_NAME, APP_VERSION, config } from './config.js';
import type { AuthProvider } from './oauth.js';
import { getClient } from './wp.js';
import { runWith } from './context.js';
import { all, run } from './db.js';
import * as ws from './workspaces.js';
import * as activity from './activity.js';
import * as approvals from './approvals.js';
import { deleteSkill, loadSkills, saveSkill } from './extras.js';
import { APP_PASSWORD_ID, APP_PASSWORD_NAME, authorizeUrl, discover, newConnectState, publicHttps, safeReturn, takeConnectState, verifyCredentials } from './connect.js';
import { disableOwnerTotp, enableOwnerTotp, newTotpSecret, ownerTotpEnabled, ownerTotpSecret, totpQrSvg, verifyTotp } from './totp.js';
import { maskText } from './pii.js';
import { keyInDataVolume, safeEqual } from './crypto.js';

// ---------- helpers ----------

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmtDate = (iso?: string | number) => {
  if (!iso) return '–';
  const d = typeof iso === 'number' ? new Date(iso * 1000) : new Date(iso);
  return d.toLocaleString('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export interface Session {
  id: string;
  role: 'owner' | 'customer';
  /** Workspace currently shown */
  workspaceId: string;
  /** Customer: own workspace. Operator: "intern". */
  homeWs: string;
  actor: string;
  csrf: string;
  expires: number;
}

const sessions = new Map<string, Session>();
const COOKIE = 'cbmcp_admin';
const SESSION_MS = 12 * 3600 * 1000;
const PENDING_2FA = new Map<string, { expires: number; next: string }>();

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function session(req: Request): Session | undefined {
  const id = readCookie(req, COOKIE);
  if (!id) return undefined;
  const s = sessions.get(id);
  if (!s || s.expires < Date.now()) {
    sessions.delete(id);
    return undefined;
  }
  return s;
}

const secureCookie = () => (config.publicUrl ?? '').startsWith('https://');

/** Start a UI session (used by the password login and by WordPress SSO). */
export function createSession(res: Response, s: Omit<Session, 'id' | 'csrf' | 'expires'>) {
  const id = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, { ...s, id, csrf: crypto.randomBytes(24).toString('base64url'), expires: Date.now() + SESSION_MS });
  res.cookie(COOKIE, id, { httpOnly: true, secure: secureCookie(), sameSite: 'lax', path: '/admin', maxAge: SESSION_MS });
}

/** End all UI sessions of a workspace (after deletion). */
function dropSessions(wsId: string) {
  for (const [k, s] of sessions) if (s.homeWs === wsId || s.workspaceId === wsId) sessions.delete(k);
}

// ---------- layout ----------

const CSS = `
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--fg:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#2f5d50;--accent-fg:#fff;--soft:#e7efe9;--warn:#9a6700;--warn-bg:#fff4e5;--err:#b3261e;--err-bg:#fbeaea;--ok:#1a7f37;--ok-bg:#e6f4ea;--code:#f1efe9}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#ecebe7;--muted:#a3a29d;--line:#2f2e2b;--accent:#7cc0a8;--accent-fg:#10201a;--soft:#22332d;--warn:#f0c674;--warn-bg:#3a2f12;--err:#f2b8b5;--err-bg:#3d1d1b;--ok:#8fd19e;--ok-bg:#1c3324;--code:#262624}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}code,pre{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}code{background:var(--code);padding:1px 5px;border-radius:4px}
pre{background:var(--code);padding:12px;border-radius:8px;overflow:auto;max-height:420px;white-space:pre-wrap;word-break:break-word}
.shell{display:grid;grid-template-columns:230px 1fr;min-height:100vh}
aside{border-right:1px solid var(--line);padding:20px 14px;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:4px;overflow:auto}
.brand{font-weight:700;font-size:15px;margin:0 8px 14px;line-height:1.3}.brand small{display:block;font-weight:500;color:var(--muted);font-size:12px}
.wsbox{margin:0 4px 14px;padding:10px;border:1px solid var(--line);border-radius:10px;font-size:13px}.wsbox select{width:100%;margin-top:6px;padding:6px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
aside a{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-radius:8px;color:var(--fg);text-decoration:none}
aside a:hover{background:var(--soft)}aside a.on{background:var(--accent);color:var(--accent-fg)}
aside .sep{border-top:1px solid var(--line);margin:8px 6px}
aside form.out{margin-top:auto}aside form.out button{width:100%}
main{padding:28px 32px 60px;max-width:1100px;width:100%}
h1{font-size:24px;margin:0 0 6px}h2{font-size:17px;margin:0 0 12px}h3{font-size:15px;margin:16px 0 8px}.lead{color:var(--muted);margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:0 0 18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}.grid .card{margin:0}
.big{font-size:30px;font-weight:700;line-height:1.1}.muted{color:var(--muted)}.small{font-size:13px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:13px;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}.nowrap{white-space:nowrap}
.btn,button{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:8px 14px;border-radius:8px;font:inherit;font-size:14px;cursor:pointer;text-decoration:none}
.btn.primary,button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}
.btn.danger,button.danger{color:var(--err);border-color:var(--err)}.btn.sm,button.sm{padding:4px 10px;font-size:13px}
button:disabled,input:disabled{opacity:.55}
input[type=text],input[type=url],input[type=password],select,textarea{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
textarea{min-height:320px;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace}
label{display:block;font-weight:600;margin:0 0 6px}.field{margin:0 0 14px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.check{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin:6px 0}.check input{margin-top:4px}
.cols{columns:2 260px}
.pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;background:var(--code);color:var(--muted);white-space:nowrap}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.err{background:var(--err-bg);color:var(--err)}.pill.wait{background:var(--warn-bg);color:var(--warn)}
.badge{background:var(--err);color:#fff;border-radius:999px;font-size:11px;padding:0 7px;line-height:18px}
.flash{padding:12px 14px;border-radius:10px;margin:0 0 18px}.flash.ok{background:var(--ok-bg);color:var(--ok)}.flash.err{background:var(--err-bg);color:var(--err)}.flash.warn{background:var(--warn-bg);color:var(--warn)}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--muted);margin-right:6px}.dot.ok{background:var(--ok)}.dot.err{background:var(--err)}
.copy{display:flex;gap:8px}.copy code{flex:1;padding:9px 11px;overflow:auto}
.banner{background:var(--warn-bg);color:var(--warn);padding:10px 14px;border-radius:10px;margin:0 0 18px;font-size:14px}
.login{min-height:100vh;display:grid;place-items:center;padding:16px}.login .card{width:100%;max-width:420px}
.qr svg{width:200px;height:200px;background:#fff;border-radius:8px;padding:6px}
footer{color:var(--muted);font-size:12px;margin-top:30px}
@media (max-width:760px){.shell{grid-template-columns:1fr}aside{position:static;height:auto;flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--line)}.brand,.wsbox{width:100%}aside form.out{margin:0}main{padding:20px 16px}}
`;

function nav(req: Request, s: Session) {
  const pending = approvals.countPending(s.workspaceId);
  const item = (href: string, label: string, badge = '') => {
    const full = req.baseUrl + req.path;
    const on = href === '/admin' ? full === '/admin' || full === '/admin/' : full.startsWith(href);
    return `<a href="${href}" class="${on ? 'on' : ''}">${esc(label)}${badge}</a>`;
  };
  const wsItems = [
    item('/admin', 'Übersicht'),
    item('/admin/sites', 'Seiten'),
    item('/admin/approvals', 'Freigaben', pending ? `<span class="badge">${pending}</span>` : ''),
    item('/admin/activity', 'Aktivität'),
    item('/admin/updates', 'Updates'),
    item('/admin/settings', 'Einstellungen'),
    item('/admin/privacy', 'Datenschutz'),
  ].join('');
  if (s.role !== 'owner') return wsItems;
  return `${wsItems}<div class="sep"></div>${item('/admin/customers', 'Kunden')}${item('/admin/skills', 'Skills')}${item('/admin/access', 'Zugriffsprotokoll')}${item('/admin/security', 'Sicherheit')}`;
}

function layout(req: Request, title: string, body: string, opts: { refresh?: number } = {}) {
  const s = session(req)!;
  const cur = ws.getWorkspace(s.workspaceId);
  const switcher =
    s.role === 'owner'
      ? `<form class="wsbox" method="post" action="/admin/switch"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><span class="muted">Ansicht</span>
<select name="ws" onchange="this.form.submit()">${ws.listWorkspaces().map((w) => `<option value="${esc(w.id)}"${w.id === s.workspaceId ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}</select></form>`
      : `<div class="wsbox"><span class="muted">Konto</span><br><strong>${esc(cur?.name)}</strong><br><span class="muted small">${esc(s.actor)}</span></div>`;
  const banner = s.role === 'owner' && s.workspaceId !== ws.OWNER_WS ? `<div class="banner">Du siehst den Bereich des Kunden <strong>${esc(cur?.name)}</strong>. Nur lesend. Dieser Zugriff wird im Zugriffsprotokoll des Kunden vermerkt.</div>` : '';
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} – ${esc(APP_NAME)}</title>${opts.refresh ? `<meta http-equiv="refresh" content="${opts.refresh}">` : ''}<style>${CSS}</style></head>
<body><div class="shell"><aside><div class="brand">Code &amp; Blocks MCP<small>${s.role === 'owner' ? 'Betreiber' : 'Kundenportal'} · ${esc(APP_VERSION)}</small></div>${switcher}${nav(req, s)}
<form class="out" method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${esc(s.csrf)}"><button class="sm">Abmelden</button></form></aside>
<main>${banner}${flash(req)}${body}<footer>Code &amp; Blocks by Marijan</footer></main></div></body></html>`;
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
  const names = new Map(ws.listSites().map((s) => [s.id, s.name]));
  return `<table><thead><tr><th>Zeit</th>${withSite ? '<th>Seite</th>' : ''}<th>Aktion</th><th>Wer</th><th>Status</th><th></th></tr></thead><tbody>${list
    .map(
      (e) =>
        `<tr><td class="nowrap small">${esc(fmtDate(e.ts))}</td>${withSite ? `<td class="small">${esc(e.site ? (names.get(e.site) ?? e.site) : '–')}</td>` : ''}<td><code class="small">${esc(e.tool)}</code> ${esc(e.summary)}</td><td class="small muted">${esc(e.actor ?? '')}${e.source === 'ui' ? ' <span class="pill">Portal</span>' : ''}</td><td>${statusPill(e.status)}</td><td class="nowrap small">${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener">${e.kind === 'approval' ? 'Öffnen' : 'Ansehen'}</a>` : ''}${e.edit_link ? ` · <a href="${esc(e.edit_link)}" target="_blank" rel="noopener">Bearbeiten</a>` : ''}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function approvalTable(list: approvals.Approval[]) {
  const names = new Map(ws.listSites().map((s) => [s.id, s.name]));
  return `<table><thead><tr><th>Zeit</th><th>Seite</th><th>Aktion</th><th>Status</th><th></th></tr></thead><tbody>${list
    .map(
      (a) =>
        `<tr><td class="nowrap small">${esc(fmtDate(a.created))}</td><td class="small">${esc(a.site ? (names.get(a.site) ?? a.site) : '–')}</td><td>${esc(a.summary)}</td><td>${statusPill(a.status)}</td><td><a class="btn sm${a.status === 'pending' ? ' primary' : ''}" href="/admin/approvals/${esc(a.id)}">${a.status === 'pending' ? 'Prüfen' : 'Details'}</a></td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function accessTable(list: activity.AccessEntry[], withWs: boolean) {
  if (!list.length) return '<p class="muted">Noch keine Einträge.</p>';
  const names = new Map(ws.listWorkspaces().map((w) => [w.id, w.name]));
  const labels: Record<string, string> = {
    login: 'Anmeldung im Portal',
    login_fehlgeschlagen: 'Fehlgeschlagene Anmeldung',
    workspace_geoeffnet: 'Betreiber hat den Bereich geöffnet',
    ki_client_verbunden: 'KI-Client verbunden',
    export: 'Datenexport',
    token_erstellt: 'Token erstellt',
    token_geloescht: 'Token gelöscht',
    ki_abgemeldet: 'KI-Clients abgemeldet',
    geloescht: 'Konto gelöscht',
    seite_verbunden: 'Seite verbunden',
    seite_getrennt: 'Seite getrennt',
    grenzen_geaendert: 'Grenzen geändert',
    '2fa': 'Zwei-Faktor-Anmeldung geändert',
  };
  return `<table><thead><tr><th>Zeit</th>${withWs ? '<th>Bereich</th>' : ''}<th>Wer</th><th>Was</th><th>Details</th><th>IP</th></tr></thead><tbody>${list
    .map(
      (e) =>
        `<tr><td class="nowrap small">${esc(fmtDate(e.ts))}</td>${withWs ? `<td class="small">${esc(e.workspaceId ? (names.get(e.workspaceId) ?? e.workspaceId) : '–')}</td>` : ''}<td class="small">${esc(e.actor)}</td><td class="small">${esc(labels[e.action] ?? e.action)}</td><td class="small muted">${esc(e.detail ?? '')}</td><td class="small muted">${esc(e.ip ?? '')}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

// ---------- site status ----------

async function siteStatus(id: string) {
  const started = Date.now();
  const wp = getClient(id);
  const [root, me, bridge] = await Promise.allSettled([wp.get('/', { _fields: 'name,url' }), wp.get('/wp/v2/users/me', { context: 'edit', _fields: 'id' }), wp.get('/cbmcp/v1/info')]);
  const ok = root.status === 'fulfilled' && me.status === 'fulfilled';
  const err = [root, me].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  const b = bridge.status === 'fulfilled' ? (bridge.value.data as any) : undefined;
  return { ok, ms: Date.now() - started, bridge: b?.bridge_version, wp: b?.wp_version, error: err ? (err.reason as Error).message : undefined };
}

const STATUS_JS = `
document.querySelectorAll('[data-status]').forEach(function(dot){
  var id=dot.getAttribute('data-status');var info=document.querySelector('[data-info="'+id+'"]');
  fetch('/admin/api/sites/'+encodeURIComponent(id)+'/status').then(function(r){return r.json()}).then(function(s){
    dot.className='dot '+(s.ok?'ok':'err');
    if(info){info.textContent=s.ok?('Erreichbar · '+(s.bridge?('Plugin '+s.bridge):'ohne Bridge-Plugin')+(s.wp?(' · WP '+s.wp):'')+' · '+s.ms+' ms'):('Fehler: '+(s.error||'unbekannt'));}
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
    else{var ok=(res.results||[]).filter(function(x){return x.ok}).length;alert(ok+' von '+(res.results||[]).length+' erfolgreich');}
    load(id,false);
  }).catch(function(e){alert('Fehler: '+e);load(id,false);});
}
function section(id,title,list,type,key){
  var wrap=h('div');wrap.appendChild(h('h3',null,title+' ('+list.length+')'));
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
    card.appendChild(h('p',null,'WordPress '+d.core.version+(d.core.new_version?' → '+d.core.new_version+' verfügbar':' (aktuell)')));
    if(d.core.new_version&&!window.RO){var cb=h('button',{class:'sm danger',type:'button'},'WordPress aktualisieren');cb.onclick=function(){run(id,'core',[],cb)};card.appendChild(cb);}
    card.appendChild(section(id,'Plugins',d.plugins,'plugin','plugin'));
    card.appendChild(section(id,'Themes',d.themes,'theme','theme'));
    card.appendChild(h('p',{class:'muted small'},'Geprüft: '+new Date(d.checked_utc).toLocaleString('de-AT')));
  }).catch(function(e){card.textContent='Fehler: '+e;});
}
function cbAll(refresh){document.querySelectorAll('[data-upd]').forEach(function(c){load(c.getAttribute('data-upd'),refresh)});}
cbAll(false);`;

// ---------- workspace deletion ----------

async function deleteWorkspace(wsId: string, actor: string, provider: AuthProvider) {
  const w = ws.getWorkspace(wsId);
  if (!w || w.isOwner) throw new Error('Dieser Bereich kann nicht gelöscht werden.');
  const sites = ws.listSites(wsId);
  const revoked: string[] = [];
  await runWith({ workspaceId: wsId, role: 'customer', actor, via: 'ui' }, async () => {
    for (const s of sites) {
      try {
        const wp = getClient(s.id);
        const list = (await wp.get('/wp/v2/users/me/application-passwords')).data as any[];
        for (const p of list.filter((p) => p.app_id === APP_PASSWORD_ID || p.name === APP_PASSWORD_NAME)) await wp.delete(`/wp/v2/users/me/application-passwords/${p.uuid}`);
        revoked.push(s.url);
      } catch {
        /* site unreachable – credentials are deleted on our side anyway */
      }
    }
  });
  provider.revokeWorkspace(wsId);
  ws.deleteWorkspaceRows(wsId);
  dropSessions(wsId);
  const ts = new Date().toISOString();
  const detail = `${sites.length} Seite(n) getrennt, Anwendungspasswort widerrufen bei: ${revoked.length ? revoked.join(', ') : 'keiner (Seiten nicht erreichbar)'}`;
  run('INSERT INTO deletion_log (ts, workspace_id, name, actor, detail) VALUES (:ts, :ws, :name, :actor, :d)', { ts, ws: wsId, name: w.name, actor, d: detail });
  activity.logAccess({ workspaceId: undefined, actor, action: 'geloescht', detail: `${w.name} (${wsId}): ${detail}` });
  return { id: wsId, name: w.name, ts, sites: sites.length, revoked, detail };
}

function deletionReceipt(r: Awaited<ReturnType<typeof deleteWorkspace>>) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Löschbestätigung</title><style>${CSS}</style></head>
<body><div class="login"><div class="card" style="max-width:560px"><h1>Löschbestätigung</h1>
<p>Das Konto <strong>${esc(r.name)}</strong> (ID <code>${esc(r.id)}</code>) wurde am ${esc(fmtDate(r.ts))} auf dem Server ${esc(config.publicUrl)} gelöscht.</p>
<p>Gelöscht wurden: Zugangsdaten der Seiten (Anwendungspasswörter), API-Keys, Tokens, KI-Sitzungen, Aktivitätsprotokoll, Freigaben und Pseudonymisierungsdaten.</p>
<p class="small muted">${esc(r.detail)}</p>
<p class="small muted">Aufbewahrt wird nur dieser Löschnachweis (Name, ID, Zeitpunkt) sowie Einträge im Zugriffsprotokoll bis zum Ablauf ihrer Frist (${activity.ACCESS_LOG_DAYS} Tage). Backups und Protokolle im WordPress-Plugin auf deiner Seite bleiben bei dir.</p>
<p><button onclick="window.print()">Drucken / als PDF speichern</button></p><footer>Code &amp; Blocks by Marijan</footer></div></div></body></html>`;
}

// ---------- router ----------

export function adminRouter(provider: AuthProvider): Router {
  const r = Router();
  r.use(express.urlencoded({ extended: false, limit: '300kb' }));
  r.use(express.json({ limit: '100kb' }));
  r.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'");
    next();
  });

  // ----- login -----
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, skipSuccessfulRequests: true, requestWasSuccessful: (_q, s) => s.statusCode < 400 });

  const loginPage = (next: string, error?: string, need2fa = false, ticket = '') => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anmelden – ${esc(APP_NAME)}</title><style>${CSS}</style></head>
<body><div class="login"><div class="card"><h1>Code &amp; Blocks MCP</h1><p class="lead">Portal für deine WordPress-Seiten</p>${error ? `<div class="flash err">${esc(error)}</div>` : ''}
${
  need2fa
    ? `<form method="post" action="/admin/login/2fa"><input type="hidden" name="ticket" value="${esc(ticket)}"><div class="field"><label for="otp">Code aus der Authenticator-App</label><input id="otp" type="text" name="otp" inputmode="numeric" autocomplete="one-time-code" required autofocus></div><button class="primary">Bestätigen</button></form>`
    : `<form method="get" action="/sso/start"><input type="hidden" name="purpose" value="portal"><div class="field"><label for="site">Adresse deiner WordPress-Seite</label><input id="site" type="url" name="site" placeholder="https://deine-seite.at" required></div><button class="primary">Mit WordPress anmelden</button>
<p class="small muted">Du meldest dich in deinem WordPress als Administrator an. Am einfachsten: im Plugin auf „Portal öffnen“ klicken.</p></form>
<details style="margin-top:18px"><summary class="muted small">Anmeldung für den Betreiber</summary><form method="post" action="/admin/login" style="margin-top:12px"><input type="hidden" name="next" value="${esc(next)}">
<div class="field"><label for="pw">Admin-Passwort</label><input id="pw" type="password" name="password" required autocomplete="current-password"></div><button>Anmelden</button></form></details>`
}
<footer>Code &amp; Blocks by Marijan</footer></div></div></body></html>`;

  r.get('/login', (req, res) => {
    res.send(loginPage(typeof req.query.next === 'string' ? req.query.next : '/admin', typeof req.query.err === 'string' ? req.query.err : undefined));
  });

  const ownerLoggedIn = (req: Request, res: Response, next: string) => {
    createSession(res, { role: 'owner', workspaceId: ws.OWNER_WS, homeWs: ws.OWNER_WS, actor: 'Betreiber' });
    activity.logAccess({ workspaceId: ws.OWNER_WS, actor: 'Betreiber', action: 'login', ip: req.ip });
    res.redirect(303, next);
  };

  r.post('/login', loginLimiter, (req, res) => {
    const next = typeof req.body.next === 'string' && req.body.next.startsWith('/admin') ? req.body.next : '/admin';
    if (!config.adminPassword || !safeEqual(String(req.body.password ?? ''), config.adminPassword)) {
      activity.logAccess({ actor: 'Betreiber', action: 'login_fehlgeschlagen', ip: req.ip });
      return void res.status(401).send(loginPage(next, 'Falsches Passwort.'));
    }
    if (ownerTotpEnabled()) {
      const ticket = crypto.randomBytes(24).toString('base64url');
      PENDING_2FA.set(ticket, { expires: Date.now() + 5 * 60 * 1000, next });
      return void res.send(loginPage(next, undefined, true, ticket));
    }
    ownerLoggedIn(req, res, next);
  });

  r.post('/login/2fa', loginLimiter, (req, res) => {
    const t = PENDING_2FA.get(String(req.body.ticket ?? ''));
    if (!t || t.expires < Date.now()) return void res.status(401).send(loginPage('/admin', 'Anmeldung abgelaufen. Bitte erneut.'));
    if (!verifyTotp(ownerTotpSecret() ?? '', String(req.body.otp ?? ''))) {
      activity.logAccess({ actor: 'Betreiber', action: 'login_fehlgeschlagen', ip: req.ip, detail: '2FA' });
      return void res.status(401).send(loginPage(t.next, 'Falscher Code.', true, String(req.body.ticket)));
    }
    PENDING_2FA.delete(String(req.body.ticket));
    ownerLoggedIn(req, res, t.next);
  });

  // ----- auth + csrf + workspace context -----
  r.use((req: Request, res: Response, next: NextFunction) => {
    const s = session(req);
    if (!s) {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) res.redirect(303, `/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      else res.status(401).json({ error: 'not_logged_in' });
      return;
    }
    if (!ws.getWorkspace(s.workspaceId)) {
      sessions.delete(s.id);
      return void res.redirect(303, '/admin/login');
    }
    if (req.method !== 'GET') {
      const token = (req.body && req.body.csrf) || req.get('x-csrf-token');
      if (!token || !safeEqual(String(token), s.csrf)) return void res.status(403).send('Ungültiges Formular (CSRF). Bitte Seite neu laden.');
    }
    // The operator may look into a customer's area, but never change anything there:
    // settings, privacy choices, tokens and approvals are the customer's decisions.
    if (s.role === 'owner' && s.workspaceId !== ws.OWNER_WS && req.method !== 'GET' && !['/switch', '/logout'].includes(req.path) && !/^\/(customers|skills|security)(\/|$)/.test(req.path)) {
      if (req.path.startsWith('/api/')) return void res.status(403).json({ error: 'Betreiber-Ansicht ist nur lesend.' });
      return void back(res, '/admin', 'Die Betreiber-Ansicht eines Kundenbereichs ist nur lesend. Änderungen nimmt der Kunde selbst vor.', 'warn');
    }
    runWith({ workspaceId: s.workspaceId, role: s.role, actor: s.actor, via: 'ui' }, next);
  });

  const ownerOnly = (req: Request, res: Response, next: NextFunction) => {
    if (session(req)?.role !== 'owner') return void res.status(403).send('Nur für den Betreiber.');
    next();
  };

  r.post('/logout', (req, res) => {
    const s = session(req);
    if (s) sessions.delete(s.id);
    res.clearCookie(COOKIE, { path: '/admin' });
    res.redirect(303, '/admin/login');
  });

  r.post('/switch', ownerOnly, (req, res) => {
    const s = session(req)!;
    const target = String(req.body.ws ?? '');
    if (!ws.getWorkspace(target)) return back(res, '/admin', 'Unbekannter Bereich.', 'err');
    s.workspaceId = target;
    if (target !== ws.OWNER_WS) activity.logAccess({ workspaceId: target, actor: 'Betreiber', action: 'workspace_geoeffnet', ip: req.ip });
    res.redirect(303, '/admin');
  });

  // ----- dashboard -----
  r.get('/', (req, res) => {
    const s = session(req)!;
    const sites = ws.listSites();
    const pending = approvals.countPending();
    const st = ws.getSettings();
    const mcpUrl = `${config.publicUrl ?? ''}/mcp`;
    res.send(
      layout(
        req,
        'Übersicht',
        `<h1>Übersicht</h1><p class="lead">${esc(ws.getWorkspace(s.workspaceId)?.name)}</p>
<div class="grid">
<div class="card"><h2>Seiten</h2><div class="big">${sites.length}</div><p class="muted small">verbunden</p><a class="btn sm" href="/admin/sites">Seiten</a></div>
<div class="card"><h2>Freigaben</h2><div class="big">${pending}</div><p class="muted small">warten auf dich</p><a class="btn sm" href="/admin/approvals">Öffnen</a></div>
<div class="card"><h2>Modus</h2><div class="big" style="font-size:20px">${ws.isReadOnly() ? 'Nur lesen' : 'Lesen &amp; schreiben'}</div><p class="muted small">Freigaben ${st.approvals.enabled ? 'an' : 'aus'} · Personenbezogene Daten ${st.pii.mask ? 'pseudonymisiert' : 'sichtbar'}</p><a class="btn sm" href="/admin/settings">Einstellungen</a></div>
</div>
<div class="card" style="margin-top:18px"><h2>Mit deiner KI verbinden</h2><p class="muted small">In Claude (oder einem anderen MCP-fähigen KI-Client) einen eigenen Connector mit dieser Adresse hinzufügen und mit WordPress anmelden. Für Claude Code einen Token unter <a href="/admin/settings">Einstellungen</a> erzeugen.</p>
<div class="copy"><code id="mcpurl">${esc(mcpUrl)}</code><button type="button" class="sm" onclick="navigator.clipboard.writeText(document.getElementById('mcpurl').textContent);this.textContent='Kopiert'">Kopieren</button></div></div>
<div class="card"><h2>Seitenstatus</h2>${sites.length ? `<table><tbody>${sites.map((x) => `<tr><td><span class="dot" data-status="${esc(x.id)}"></span><a href="/admin/sites/${esc(x.id)}">${esc(x.name)}</a> <span class="muted small">${esc(x.url)}</span></td><td class="small muted" data-info="${esc(x.id)}">prüfe…</td></tr>`).join('')}</tbody></table>` : '<p>Noch keine Seite verbunden. <a href="/admin/sites">Jetzt verbinden</a></p>'}</div>
<div class="card"><h2>Letzte Aktivität</h2>${activityTable(activity.recent(8), true)}<p><a href="/admin/activity">Alle anzeigen</a></p></div>
<script>${STATUS_JS}</script>`,
      ),
    );
  });

  // ----- sites -----
  r.get('/sites', (req, res) => {
    const sites = ws.listSites();
    res.send(
      layout(
        req,
        'Seiten',
        `<h1>Seiten</h1><p class="lead">WordPress-Seiten, auf die deine KI über diesen Server zugreifen kann.</p>
<div class="card"><h2>Weitere Seite verbinden</h2>
<form method="post" action="/admin/sites/connect">${csrfField(req)}
<div class="field"><label for="url">Adresse der WordPress-Seite</label><input id="url" type="url" name="url" placeholder="https://deine-seite.at" required></div>
<div class="field"><label for="name">Name (optional)</label><input id="name" type="text" name="name"></div>
<button class="primary">Weiter zu WordPress</button>
<p class="muted small">Du bestätigst die Verbindung in WordPress als Administrator. WordPress erstellt dabei ein Anwendungspasswort, das verschlüsselt auf diesem Server gespeichert wird. Tipp: Im Plugin „Code &amp; Blocks MCP Bridge“ geht das auch direkt.</p></form></div>
<div class="card"><h2>Verbundene Seiten</h2>${
          sites.length
            ? `<table><thead><tr><th>Seite</th><th>Benutzer</th><th>Status</th><th></th></tr></thead><tbody>${sites
                .map(
                  (x) =>
                    `<tr><td><a href="/admin/sites/${esc(x.id)}"><strong>${esc(x.name)}</strong></a>${x.default ? ' <span class="pill">Standard</span>' : ''}<br><span class="muted small">${esc(x.url)} · ID <code>${esc(x.id)}</code></span></td><td>${esc(x.user)}</td><td><span class="dot" data-status="${esc(x.id)}"></span><span class="small muted" data-info="${esc(x.id)}">prüfe…</span></td><td class="nowrap"><a class="btn sm" href="/admin/sites/${esc(x.id)}">Details</a></td></tr>`,
                )
                .join('')}</tbody></table>`
            : '<p class="muted">Noch keine Seite verbunden.</p>'
        }</div><script>${STATUS_JS}</script>`,
      ),
    );
  });

  const startConnect = async (req: Request, res: Response, url: string, name?: string, returnUrl?: string) => {
    if (!publicHttps()) return back(res, '/admin/sites', 'PUBLIC_URL muss mit https:// beginnen, damit WordPress zurückleiten kann.', 'err');
    const s = session(req)!;
    let d;
    try {
      d = await discover(url);
    } catch (e) {
      return back(res, '/admin/sites', (e as Error).message, 'err');
    }
    const other = ws.siteByUrl(d.url);
    if (other && other.workspaceId !== s.workspaceId) return back(res, '/admin/sites', 'Diese Seite ist bereits mit einem anderen Konto verbunden.', 'err');
    const state = newConnectState({ workspaceId: s.workspaceId, url: d.url, name: name || d.name, restBase: d.restBase, returnUrl: safeReturn(returnUrl, d.url), binding: s.id });
    res.redirect(303, authorizeUrl(d, `${config.publicUrl}/admin/sites/callback?state=${state}`));
  };

  r.post('/sites/connect', async (req, res) => {
    if (ws.isReadOnly()) return back(res, '/admin/sites', 'Im Nur-Lesen-Modus können keine Seiten verbunden werden.', 'err');
    await startConnect(req, res, String(req.body.url ?? ''), String(req.body.name ?? '').trim() || undefined, typeof req.body.return === 'string' ? req.body.return : undefined);
  });

  // Plugin 1.2 button (logged-in flow)
  r.get('/connect', (req, res) => {
    const site = typeof req.query.site === 'string' ? req.query.site : '';
    const ret = typeof req.query.return === 'string' ? req.query.return : '';
    res.send(
      layout(
        req,
        'Seite verbinden',
        `<h1>Seite verbinden</h1><div class="card"><p>Diese WordPress-Seite mit <strong>${esc(ws.getWorkspace(session(req)!.workspaceId)?.name)}</strong> verbinden?</p><p><code>${esc(site)}</code></p>
<form method="post" action="/admin/sites/connect">${csrfField(req)}<input type="hidden" name="url" value="${esc(site)}"><input type="hidden" name="return" value="${esc(ret)}">
<div class="row"><button class="primary">Ja, weiter zu WordPress</button><a class="btn" href="/admin">Abbrechen</a></div></form></div>`,
      ),
    );
  });

  r.get('/sites/callback', async (req, res) => {
    const s = session(req)!;
    const st = takeConnectState(String(req.query.state ?? ''));
    if (!st || st.binding !== s.id || st.workspaceId !== s.workspaceId) return back(res, '/admin/sites', 'Die Verbindungsanfrage ist abgelaufen oder ungültig. Bitte erneut starten.', 'err');
    if (req.query.rejected || req.query.success === 'false') return back(res, '/admin/sites', 'Die Verbindung wurde in WordPress abgelehnt.', 'warn');
    const user = String(req.query.user_login ?? '');
    const password = String(req.query.password ?? '');
    if (!user || !password) return back(res, '/admin/sites', 'WordPress hat keine Zugangsdaten zurückgegeben.', 'err');
    let warn = '';
    try {
      warn = await verifyCredentials(st.url, user, password, st.restBase);
    } catch (e) {
      return back(res, '/admin/sites', (e as Error).message, 'err');
    }
    let id: string;
    try {
      id = ws.upsertSite(s.workspaceId, { url: st.url, user, appPassword: password, name: st.name, restBase: st.restBase });
    } catch (e) {
      return back(res, '/admin/sites', (e as Error).message, 'err');
    }
    activity.record({ site: id, tool: 'connect_site', kind: 'change', status: 'ok', summary: `Seite verbunden (${user})`, source: 'ui' });
    activity.logAccess({ workspaceId: s.workspaceId, actor: s.actor, action: 'seite_verbunden', ip: req.ip, detail: st.url });
    if (st.returnUrl) {
      const u = new URL(st.returnUrl);
      u.searchParams.set('cbmcp_connected', '1');
      return res.redirect(303, u.href);
    }
    back(res, `/admin/sites/${id}`, `Verbunden. ${warn}`.trim(), warn ? 'warn' : 'ok');
  });

  r.get('/sites/:id', (req, res) => {
    const x = ws.getSite(String(req.params.id));
    if (!x) return back(res, '/admin/sites', 'Seite nicht gefunden.', 'err');
    res.send(
      layout(
        req,
        x.name,
        `<h1>${esc(x.name)}</h1><p class="lead"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a> · ID <code>${esc(x.id)}</code>${x.default ? ' · <span class="pill">Standard</span>' : ''}</p>
<div class="grid"><div class="card"><h2>Status</h2><p><span class="dot" data-status="${esc(x.id)}"></span><span data-info="${esc(x.id)}" class="small">prüfe…</span></p>
<p class="small muted">Benutzer: ${esc(x.user)} · verbunden ${esc(fmtDate(x.createdAt))}</p></div>
<div class="card"><h2>Name</h2><form method="post" action="/admin/sites/${esc(x.id)}/rename">${csrfField(req)}<div class="row"><input type="text" name="name" value="${esc(x.name)}" style="flex:1"><button class="sm">Speichern</button></div></form>
${x.default ? '' : `<form method="post" action="/admin/sites/${esc(x.id)}/default" style="margin-top:10px">${csrfField(req)}<button class="sm">Als Standardseite festlegen</button></form>`}</div></div>
<div class="card" style="margin-top:18px"><h2>Aktivität</h2>${activityTable(activity.recent(20, x.id), false)}</div>
<div class="card"><h2>Verbindung erneuern oder trennen</h2><div class="row">
<form method="post" action="/admin/sites/connect">${csrfField(req)}<input type="hidden" name="url" value="${esc(x.url)}"><input type="hidden" name="name" value="${esc(x.name)}"><button class="sm">Neu verbinden</button></form>
<form method="post" action="/admin/sites/${esc(x.id)}/delete" onsubmit="return confirm('Seite trennen? Die KI hat danach keinen Zugriff mehr.')">${csrfField(req)}<label class="check"><input type="checkbox" name="revoke" value="1" checked> Anwendungspasswort in WordPress widerrufen</label><button class="sm danger">Seite trennen</button></form>
</div></div><script>${STATUS_JS}</script>`,
      ),
    );
  });

  r.post('/sites/:id/rename', (req, res) => {
    ws.renameSite(session(req)!.workspaceId, String(req.params.id), String(req.body.name ?? '').trim());
    back(res, `/admin/sites/${String(req.params.id)}`, 'Gespeichert.');
  });

  r.post('/sites/:id/default', (req, res) => {
    ws.makeDefault(session(req)!.workspaceId, String(req.params.id));
    back(res, `/admin/sites/${String(req.params.id)}`, 'Ist jetzt die Standardseite.');
  });

  r.post('/sites/:id/delete', async (req, res) => {
    const s = session(req)!;
    const x = ws.getSite(String(req.params.id));
    if (!x) return back(res, '/admin/sites', 'Seite nicht gefunden.', 'err');
    let note = '';
    if (req.body.revoke) {
      try {
        const wp = getClient(x.id);
        const list = (await wp.get('/wp/v2/users/me/application-passwords')).data as any[];
        const ours = list.filter((p) => p.app_id === APP_PASSWORD_ID || p.name === APP_PASSWORD_NAME);
        for (const p of ours) await wp.delete(`/wp/v2/users/me/application-passwords/${p.uuid}`);
        note = ` ${ours.length} Anwendungspasswort(e) in WordPress widerrufen.`;
      } catch (e) {
        note = ` Widerruf in WordPress fehlgeschlagen (${(e as Error).message}) – bitte dort unter Profil → Anwendungspasswörter löschen.`;
      }
    }
    activity.record({ site: x.id, tool: 'disconnect_site', kind: 'change', status: 'ok', summary: 'Seite getrennt', source: 'ui' });
    activity.logAccess({ workspaceId: s.workspaceId, actor: s.actor, action: 'seite_getrennt', ip: req.ip, detail: x.url });
    ws.removeSite(s.workspaceId, x.id);
    back(res, '/admin/sites', `Seite getrennt.${note}`);
  });

  r.get('/api/sites/:id/status', async (req, res) => {
    try {
      res.json(await siteStatus(String(req.params.id)));
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
        `<h1>Freigaben</h1><p class="lead">Riskante Aktionen deiner KI warten hier auf deine Bestätigung. Welche das sind, legst du unter <a href="/admin/settings">Einstellungen</a> fest.</p>
<div class="card"><h2>Offen</h2>${pending.length ? approvalTable(pending) : '<p class="muted">Keine offenen Freigaben.</p>'}</div>
<div class="card"><h2>Verlauf (${activity.APPROVAL_DAYS} Tage)</h2>${done.length ? approvalTable(done) : '<p class="muted">Noch nichts.</p>'}</div>`,
        { refresh: pending.length ? 10 : 30 },
      ),
    );
  });

  r.get('/approvals/:id', (req, res) => {
    const s = session(req)!;
    const a = approvals.getApproval(String(req.params.id));
    if (!a) return back(res, '/admin/approvals', 'Freigabe nicht gefunden (oder sie gehört zu einem anderen Konto).', 'err');
    const site = a.site ? ws.getSite(a.site) : undefined;
    let details = JSON.stringify(a.args, null, 2);
    if (s.role === 'owner' && s.workspaceId !== ws.OWNER_WS) details = maskText(details).text;
    res.send(
      layout(
        req,
        'Freigabe',
        `<h1>Freigabe</h1><p class="lead">${esc(a.summary)}</p>
<div class="card"><table><tbody>
<tr><th>Status</th><td>${statusPill(a.status)}</td></tr><tr><th>Aktion</th><td><code>${esc(a.tool)}</code></td></tr>
<tr><th>Seite</th><td>${site ? `${esc(site.name)} <span class="muted small">${esc(site.url)}</span>` : esc(a.site ?? '–')}</td></tr>
<tr><th>Angefragt</th><td>${esc(fmtDate(a.created))}</td></tr>${a.decided ? `<tr><th>Entschieden</th><td>${esc(fmtDate(a.decided))} · ${esc(a.decidedBy ?? '')}</td></tr>` : ''}</tbody></table>
<h3>Details</h3><pre>${esc(details)}</pre>
${a.status === 'pending' ? `<div class="row"><form method="post" action="/admin/approvals/${esc(a.id)}">${csrfField(req)}<input type="hidden" name="decision" value="approve"><button class="primary">Freigeben</button></form>
<form method="post" action="/admin/approvals/${esc(a.id)}">${csrfField(req)}<input type="hidden" name="decision" value="decline"><button class="danger">Ablehnen</button></form></div>
<p class="muted small">Nach der Freigabe führt die KI die Aktion aus. Falls sie nicht mehr wartet, schreib im Chat „freigegeben“.</p>` : ''}</div>`,
      ),
    );
  });

  r.post('/approvals/:id', (req, res) => {
    const a = approvals.decide(String(req.params.id), req.body.decision === 'approve');
    if (!a) return back(res, '/admin/approvals', 'Freigabe nicht gefunden.', 'err');
    back(res, `/admin/approvals/${a.id}`, a.status === 'approved' ? 'Freigegeben.' : a.status === 'declined' ? 'Abgelehnt.' : `Status: ${a.status}`);
  });

  // ----- activity -----
  r.get('/activity', (req, res) => {
    const site = typeof req.query.site === 'string' && req.query.site ? req.query.site : undefined;
    const sites = ws.listSites();
    const days = ws.getSettings().retentionDays;
    res.send(
      layout(
        req,
        'Aktivität',
        `<h1>Aktivität</h1><p class="lead">Änderungen über deine KI und dieses Portal. Einträge werden nach ${days} Tagen gelöscht.</p>
<form class="row" method="get" action="/admin/activity" style="margin-bottom:14px"><select name="site" onchange="this.form.submit()" style="max-width:320px"><option value="">Alle Seiten</option>${sites.map((x) => `<option value="${esc(x.id)}"${x.id === site ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></form>
<div class="card">${activityTable(activity.recent(300, site), true)}</div>`,
      ),
    );
  });

  // ----- updates -----
  r.get('/updates', (req, res) => {
    const sites = ws.listSites();
    res.send(
      layout(
        req,
        'Updates',
        `<h1>Updates</h1><p class="lead">Plugin-, Theme- und WordPress-Updates deiner Seiten (Bridge-Plugin ab 1.2 nötig). Vor Core-Updates ein Backup machen.</p>
<div class="row" style="margin-bottom:16px"><button class="primary" type="button" onclick="cbAll(true)">Alle Seiten neu prüfen</button></div>
${sites.map((x) => `<div class="card" data-upd="${esc(x.id)}"><h2>${esc(x.name)} <span class="muted small">${esc(x.url)}</span></h2><div class="body muted small">lädt…</div></div>`).join('') || '<p class="muted">Noch keine Seite verbunden.</p>'}
<script>window.CSRF=${JSON.stringify(session(req)?.csrf ?? '')};window.RO=${ws.isReadOnly()};${UPDATES_JS}</script>`,
      ),
    );
  });

  r.get('/api/sites/:id/updates', async (req, res) => {
    try {
      res.json((await getClient(String(req.params.id)).get('/cbmcp/v1/updates/list', { refresh: req.query.refresh ? 1 : undefined })).data);
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  r.post('/api/sites/:id/updates', async (req, res) => {
    if (ws.isReadOnly()) return void res.status(403).json({ error: 'Nur-Lesen-Modus' });
    if (ws.isBlocked('manage_updates')) return void res.status(403).json({ error: 'Updates sind für dieses Konto gesperrt.' });
    const type = String(req.body.type ?? '');
    const items = Array.isArray(req.body.items) ? req.body.items.map(String) : [];
    if (!['plugin', 'theme', 'core'].includes(type)) return void res.status(400).json({ error: 'type' });
    try {
      const out = (await getClient(String(req.params.id)).request('POST', '/cbmcp/v1/updates/run', { body: { type, items }, timeoutMs: 600_000 })).data as any;
      const okN = (out.results ?? []).filter((x: any) => x.ok).length;
      activity.record({ site: String(req.params.id), tool: 'manage_updates', kind: 'change', status: 'ok', summary: `Updates (${type}): ${okN}/${(out.results ?? []).length} erfolgreich`, source: 'ui' });
      res.json(out);
    } catch (e) {
      activity.record({ site: String(req.params.id), tool: 'manage_updates', kind: 'change', status: 'error', summary: `Updates (${type}) fehlgeschlagen`, source: 'ui' });
      res.status(502).json({ error: (e as Error).message });
    }
  });

  // ----- settings (per workspace) -----
  const settingsPage = (req: Request, newToken?: string) => {
    const s = session(req)!;
    const st = ws.getSettings();
    const caps = ws.getCaps();
    const keys = ws.keyStatus(s.workspaceId);
    const tokens = ws.listStaticTokens(s.workspaceId);
    const clients = provider.stats(s.workspaceId);
    const lockedRO = config.envReadOnly || caps.forceReadOnly;
    return layout(
      req,
      'Einstellungen',
      `<h1>Einstellungen</h1>
${newToken ? `<div class="flash warn"><strong>Neuer Token – nur jetzt sichtbar:</strong><div class="copy" style="margin-top:8px"><code id="tok">${esc(newToken)}</code><button type="button" class="sm" onclick="navigator.clipboard.writeText(document.getElementById('tok').textContent);this.textContent='Kopiert'">Kopieren</button></div>
<p class="small" style="margin:8px 0 0">Claude Code: <code>claude mcp add --transport http wordpress ${esc(config.publicUrl)}/mcp --header "Authorization: Bearer ${esc(newToken)}"</code></p></div>` : ''}
<form class="card" method="post" action="/admin/settings">${csrfField(req)}<h2>Zugriff der KI</h2>
<label class="check"><input type="checkbox" name="readOnly" value="1"${st.readOnly || lockedRO ? ' checked' : ''}${lockedRO ? ' disabled' : ''}> <span><strong>Nur lesen</strong><br><span class="muted small">Die KI kann nichts verändern, nur lesen und prüfen.${lockedRO ? ' (Vom Betreiber festgelegt.)' : ''}</span></span></label>
<h3>Freigaben</h3>
<label class="check"><input type="checkbox" name="approvals" value="1"${st.approvals.enabled ? ' checked' : ''}> <span><strong>Riskante Aktionen erst nach Freigabe ausführen</strong><br><span class="muted small">Die KI wartet kurz auf deine Bestätigung unter „Freigaben“ (auch als Hinweis in wp-admin).</span></span></label>
<div class="cols" style="margin-left:26px">${Object.entries(ws.APPROVAL_TOOLS)
        .map(([k, label]) => `<label class="check"><input type="checkbox" name="tool_${esc(k)}" value="1"${st.approvals.tools.includes(k) ? ' checked' : ''}> <span>${esc(label)}</span></label>`)
        .join('')}</div>
${caps.blockedTools.length ? `<p class="small muted">Vom Betreiber gesperrt: ${caps.blockedTools.map((t) => esc(ws.BLOCKABLE_TOOLS[t] ?? t)).join(', ')}</p>` : ''}
<p><button class="primary">Speichern</button></p></form>
<form class="card" method="post" action="/admin/settings/keys">${csrfField(req)}<h2>Stockbilder</h2><p class="small muted">Deine eigenen Keys. Sie werden verschlüsselt gespeichert und nur für deine Seiten verwendet.</p>
<div class="field"><label for="px">Pexels API-Key ${keys.pexels ? `<span class="pill ok">gesetzt${keys.pexelsEnv ? ' (Server)' : ''}</span>` : ''}</label><input id="px" type="password" name="pexels" placeholder="${keys.pexels ? 'unverändert lassen' : 'Key von pexels.com/api'}" autocomplete="off"></div>
<div class="field"><label for="us">Unsplash Access Key ${keys.unsplash ? `<span class="pill ok">gesetzt${keys.unsplashEnv ? ' (Server)' : ''}</span>` : ''}</label><input id="us" type="password" name="unsplash" placeholder="${keys.unsplash ? 'unverändert lassen' : 'Access Key von unsplash.com/developers'}" autocomplete="off"></div>
<label class="check"><input type="checkbox" name="clear" value="1"> Gespeicherte Keys löschen</label>
<p><button>Speichern</button></p></form>
<div class="card"><h2>Tokens für Claude Code und Skripte</h2><p class="small muted">Für Clients ohne Anmeldeseite: <code>Authorization: Bearer &lt;Token&gt;</code>. Jeder Token gilt nur für dieses Konto.</p>
${tokens.length ? `<table><thead><tr><th>Name</th><th>Token</th><th>Erstellt</th><th>Zuletzt benutzt</th><th>Läuft ab</th><th></th></tr></thead><tbody>${tokens.map((t) => `<tr><td>${esc(t.label)}</td><td><code>${esc(t.hint)}</code></td><td class="small">${esc(fmtDate(t.created))}</td><td class="small">${esc(fmtDate(t.lastUsed))}</td><td class="small">${t.expires && t.expires * 1000 < Date.now() ? '<span class="pill err">abgelaufen</span>' : esc(fmtDate(t.expires))}</td><td><form method="post" action="/admin/settings/token/delete" onsubmit="return confirm('Token löschen?')">${csrfField(req)}<input type="hidden" name="id" value="${esc(t.id)}"><button class="sm danger">Löschen</button></form></td></tr>`).join('')}</tbody></table>` : ''}
<form method="post" action="/admin/settings/token" class="row" style="margin-top:10px">${csrfField(req)}<input type="text" name="label" placeholder="Name, z. B. Claude Code Laptop" style="max-width:300px"><select name="days" style="max-width:160px">${ws.TOKEN_DAYS.map((d) => `<option value="${d}"${d === 90 ? ' selected' : ''}>gültig ${d} Tage</option>`).join('')}</select><button>Token erzeugen</button></form></div>
<div class="card"><h2>Verbundene KI-Clients</h2>${clients.length ? `<table><thead><tr><th>Client</th><th>Angemeldet als</th><th>Sitzungen</th></tr></thead><tbody>${clients.map((c) => `<tr><td>${esc(c.name)}</td><td class="small">${esc(c.actor)}</td><td>${c.sessions}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Keine aktiven Sitzungen.</p>'}
<form method="post" action="/admin/settings/sessions/revoke" onsubmit="return confirm('Alle KI-Clients abmelden?')" style="margin-top:12px">${csrfField(req)}<button class="sm danger">Alle abmelden</button></form></div>`,
    );
  };

  r.get('/settings', (req, res) => {
    res.send(settingsPage(req));
  });

  r.post('/settings', (req, res) => {
    const s = session(req)!;
    const tools = Object.keys(ws.APPROVAL_TOOLS).filter((k) => req.body[`tool_${k}`]);
    ws.updateSettings(s.workspaceId, { readOnly: Boolean(req.body.readOnly), approvals: { enabled: Boolean(req.body.approvals), tools } });
    activity.record({ tool: 'settings', kind: 'change', status: 'ok', summary: `Einstellungen geändert (nur lesen: ${req.body.readOnly ? 'ja' : 'nein'}, Freigaben: ${req.body.approvals ? 'an' : 'aus'})`, source: 'ui' });
    back(res, '/admin/settings', 'Gespeichert.');
  });

  r.post('/settings/keys', (req, res) => {
    const s = session(req)!;
    if (req.body.clear) {
      ws.setKey(s.workspaceId, 'pexels', null);
      ws.setKey(s.workspaceId, 'unsplash', null);
    } else {
      const px = String(req.body.pexels ?? '').trim();
      const us = String(req.body.unsplash ?? '').trim();
      if (px) ws.setKey(s.workspaceId, 'pexels', px);
      if (us) ws.setKey(s.workspaceId, 'unsplash', us);
    }
    back(res, '/admin/settings', 'Gespeichert.');
  });

  r.post('/settings/token', (req, res) => {
    const s = session(req)!;
    const label = String(req.body.label ?? '').trim() || 'Token';
    const token = ws.createStaticToken(s.workspaceId, label, s.actor, Number(req.body.days) || 90);
    activity.logAccess({ workspaceId: s.workspaceId, actor: s.actor, action: 'token_erstellt', ip: req.ip, detail: label });
    res.send(settingsPage(req, token));
  });

  r.post('/settings/token/delete', (req, res) => {
    const s = session(req)!;
    ws.deleteStaticToken(s.workspaceId, String(req.body.id ?? ''));
    activity.logAccess({ workspaceId: s.workspaceId, actor: s.actor, action: 'token_geloescht', ip: req.ip });
    back(res, '/admin/settings', 'Token gelöscht.');
  });

  r.post('/settings/sessions/revoke', (req, res) => {
    const s = session(req)!;
    provider.revokeWorkspace(s.workspaceId);
    activity.logAccess({ workspaceId: s.workspaceId, actor: s.actor, action: 'ki_abgemeldet', ip: req.ip });
    back(res, '/admin/settings', 'Alle KI-Clients wurden abgemeldet.');
  });

  // ----- privacy (per workspace) -----
  r.get('/privacy', (req, res) => {
    const s = session(req)!;
    const st = ws.getSettings();
    const w = ws.getWorkspace(s.workspaceId)!;
    res.send(
      layout(
        req,
        'Datenschutz',
        `<h1>Datenschutz</h1><p class="lead">Welche personenbezogenen Daten deine KI über diesen Server zu sehen bekommt und wie lange Protokolle aufbewahrt werden.</p>
<form class="card" method="post" action="/admin/privacy">${csrfField(req)}
<h2>Personenbezogene Daten</h2>
<label class="check"><input type="checkbox" name="mask" value="1"${st.pii.mask ? ' checked' : ''}> <span><strong>Pseudonymisieren (empfohlen)</strong><br><span class="muted small">E-Mail-Adressen, Telefonnummern und IP-Adressen werden durch Platzhalter wie <code>[[pii:3f9a0c1b2d]]</code> ersetzt, bevor sie an die KI gehen. Schreibt die KI einen Platzhalter zurück (z. B. beim Bearbeiten einer Seite mit Kontaktadresse), setzt der Server den Originalwert wieder ein. Code-Dateien sind ausgenommen.</span></span></label>
<label class="check"><input type="checkbox" name="allow" value="1"${st.pii.allowPersonalData ? ' checked' : ''}> <span><strong>Zugriff auf Benutzer-, Kommentar-, Bestell- und Formulardaten erlauben</strong><br><span class="muted small">Standardmäßig gesperrt: Benutzerlisten, Kommentare, WooCommerce-Bestellungen und -Kunden, Formulareinträge und ähnliche Tabellen. Nur aktivieren, wenn deine KI damit arbeiten soll.</span></span></label>
<h2 style="margin-top:18px">Aufbewahrung</h2>
<div class="field" style="max-width:320px"><label for="ret">Aktivitätsprotokoll löschen nach</label><select id="ret" name="retention">${[30, 90, 180, 365].map((d) => `<option value="${d}"${st.retentionDays === d ? ' selected' : ''}>${d} Tagen</option>`).join('')}</select></div>
<p class="small muted">Fest: Freigaben ${activity.APPROVAL_DAYS} Tage, Zugriffsprotokoll ${activity.ACCESS_LOG_DAYS} Tage, Platzhalter-Zuordnungen 24 Stunden.</p>
<p><button class="primary">Speichern</button></p></form>
<div class="card"><h2>Zugriffsprotokoll</h2><p class="small muted">Anmeldungen, verbundene KI-Clients und Zugriffe des Betreibers auf dieses Konto.</p>${accessTable(activity.accessLog(s.workspaceId, 100), false)}</div>
<div class="card"><h2>Deine Daten</h2><p class="small muted">Export aller Daten, die dieser Server zu deinem Konto speichert (ohne Passwörter und Keys).</p>
<a class="btn" href="/admin/privacy/export">Daten exportieren (JSON)</a></div>
${
  w.isOwner
    ? ''
    : `<div class="card"><h2>Konto löschen</h2><p class="small muted">Löscht alle Seitenverbindungen (die Anwendungspasswörter werden in WordPress widerrufen), Keys, Tokens, KI-Sitzungen, Protokolle und Freigaben. Du bekommst eine Löschbestätigung. Das lässt sich nicht rückgängig machen.</p>
<form method="post" action="/admin/privacy/delete">${csrfField(req)}<div class="field" style="max-width:420px"><label for="confirm">Zur Bestätigung den Kontonamen eingeben: <code>${esc(w.name)}</code></label><input id="confirm" type="text" name="confirm" autocomplete="off" required></div><button class="danger">Konto endgültig löschen</button></form></div>`
}`,
      ),
    );
  });

  r.post('/privacy', (req, res) => {
    const s = session(req)!;
    ws.updateSettings(s.workspaceId, { pii: { mask: Boolean(req.body.mask), allowPersonalData: Boolean(req.body.allow) }, retentionDays: Number(req.body.retention) || 90 });
    activity.record({ tool: 'privacy', kind: 'change', status: 'ok', summary: `Datenschutz geändert (Pseudonymisierung: ${req.body.mask ? 'an' : 'aus'}, personenbezogene Daten: ${req.body.allow ? 'erlaubt' : 'gesperrt'}, Aufbewahrung: ${Number(req.body.retention) || 90} Tage)`, source: 'ui' });
    activity.purgeExpired();
    back(res, '/admin/privacy', 'Gespeichert.');
  });

  r.get('/privacy/export', (req, res) => {
    const s = session(req)!;
    const w = ws.getWorkspace(s.workspaceId)!;
    const data = {
      exported_at: new Date().toISOString(),
      server: config.publicUrl,
      workspace: { id: w.id, name: w.name, created: w.createdAt },
      settings: ws.getSettings(),
      limits: ws.getCaps(),
      sites: ws.listSites().map(({ id, name, url, user, createdAt }) => ({ id, name, url, user, connected: createdAt })),
      api_keys: ws.keyStatus(s.workspaceId),
      tokens: ws.listStaticTokens(s.workspaceId).map(({ label, hint, created }) => ({ label, hint, created })),
      ai_clients: provider.stats(s.workspaceId),
      activity: activity.exportActivity(s.workspaceId),
      approvals: approvals.exportApprovals(s.workspaceId),
      access_log: activity.accessLog(s.workspaceId, 100000),
    };
    activity.logAccess({ workspaceId: s.workspaceId, actor: s.actor, action: 'export', ip: req.ip });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cbmcp-export-${w.id}-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(data, null, 2));
  });

  r.post('/privacy/delete', async (req, res) => {
    const s = session(req)!;
    const w = ws.getWorkspace(s.workspaceId)!;
    if (w.isOwner) return back(res, '/admin/privacy', 'Der eigene Betreiber-Bereich kann nicht gelöscht werden.', 'err');
    if (String(req.body.confirm ?? '').trim() !== w.name) return back(res, '/admin/privacy', 'Der eingegebene Name stimmt nicht.', 'err');
    try {
      const receipt = await deleteWorkspace(w.id, s.actor, provider);
      if (s.role === 'owner') s.workspaceId = ws.OWNER_WS;
      else res.clearCookie(COOKIE, { path: '/admin' });
      res.send(deletionReceipt(receipt));
    } catch (e) {
      back(res, '/admin/privacy', (e as Error).message, 'err');
    }
  });

  // =====================================================================
  // Operator only
  // =====================================================================

  r.get('/customers', ownerOnly, (req, res) => {
    const list = ws.listWorkspaces().filter((w) => !w.isOwner);
    const deletions = all<any>('SELECT * FROM deletion_log ORDER BY id DESC LIMIT 50');
    res.send(
      layout(
        req,
        'Kunden',
        `<h1>Kunden</h1><p class="lead">Jeder Kunde hat einen eigenen, abgeschotteten Bereich mit eigenen Seiten, Keys, Tokens und Protokollen.</p>
<form class="card" method="post" action="/admin/customers">${csrfField(req)}<h2>Neuen Kunden anlegen</h2><div class="row"><input type="text" name="name" placeholder="Name des Kunden" required style="max-width:360px"><button class="primary">Anlegen</button></div>
<p class="small muted">Danach bekommst du einen Verbindungscode. Der Kunde trägt ihn mit der Server-Adresse im Plugin ein und klickt „Verbinden“.</p></form>
<div class="card"><h2>Alle Kunden</h2>${
          list.length
            ? `<table><thead><tr><th>Kunde</th><th>Seiten</th><th>Letzte Aktivität</th><th>Grenzen</th><th></th></tr></thead><tbody>${list
                .map((w) => {
                  const c = ws.getCaps(w.id);
                  return `<tr><td><strong>${esc(w.name)}</strong><br><span class="muted small">ID <code>${esc(w.id)}</code> · seit ${esc(fmtDate(w.createdAt))}</span></td><td>${w.sites}</td><td class="small">${esc(fmtDate(w.lastActivity))}</td><td class="small">${c.forceReadOnly ? '<span class="pill wait">nur lesen</span> ' : ''}${c.blockedTools.length ? `${c.blockedTools.length} Tools gesperrt` : ''}</td><td class="nowrap"><a class="btn sm" href="/admin/customers/${esc(w.id)}">Verwalten</a></td></tr>`;
                })
                .join('')}</tbody></table>`
            : '<p class="muted">Noch keine Kunden.</p>'
        }</div>
${deletions.length ? `<div class="card"><h2>Löschnachweise</h2><table><thead><tr><th>Zeit</th><th>Kunde</th><th>Durch</th><th>Details</th></tr></thead><tbody>${deletions.map((d) => `<tr><td class="small nowrap">${esc(fmtDate(d.ts))}</td><td>${esc(d.name)} <span class="muted small">${esc(d.workspace_id)}</span></td><td class="small">${esc(d.actor)}</td><td class="small muted">${esc(d.detail)}</td></tr>`).join('')}</tbody></table></div>` : ''}`,
      ),
    );
  });

  const codeBox = (code: string) =>
    `<div class="flash warn"><strong>Verbindungscode – nur jetzt sichtbar:</strong><div class="copy" style="margin-top:8px"><code id="code">${esc(code)}</code><button type="button" class="sm" onclick="navigator.clipboard.writeText(document.getElementById('code').textContent);this.textContent='Kopiert'">Kopieren</button></div>
<p class="small" style="margin:8px 0 0">Dem Kunden schicken: Server-Adresse <code>${esc(config.publicUrl)}</code> und diesen Code. Im Plugin unter „Code &amp; Blocks MCP → Verbindung“ eintragen und „Verbinden“ klicken.</p></div>`;

  r.post('/customers', ownerOnly, (req, res) => {
    const name = String(req.body.name ?? '').trim();
    if (!name) return back(res, '/admin/customers', 'Name fehlt.', 'err');
    const { workspace, code } = ws.createWorkspace(name);
    res.send(customerPage(req, workspace.id, codeBox(code)));
  });

  const customerPage = (req: Request, id: string, extra = '') => {
    const w = ws.getWorkspace(id)!;
    const caps = ws.getCaps(id);
    const sites = ws.listSites(id);
    return layout(
      req,
      w.name,
      `<h1>${esc(w.name)}</h1><p class="lead">ID <code>${esc(w.id)}</code> · seit ${esc(fmtDate(w.createdAt))} · ${sites.length} Seite(n)</p>${extra}
<div class="grid"><div class="card"><h2>Name</h2><form method="post" action="/admin/customers/${esc(id)}/rename">${csrfField(req)}<div class="row"><input type="text" name="name" value="${esc(w.name)}" style="flex:1"><button class="sm">Speichern</button></div></form></div>
<div class="card"><h2>Verbindungscode</h2><p class="small muted">${w.codeHint ? `Aktiv (endet auf <code>${esc(w.codeHint)}</code>).` : 'Kein Code aktiv. Neue Seiten kann der Kunde dann nur über das Portal verbinden.'}</p><div class="row">
<form method="post" action="/admin/customers/${esc(id)}/code">${csrfField(req)}<button class="sm">Neuen Code erzeugen</button></form>
${w.codeHint ? `<form method="post" action="/admin/customers/${esc(id)}/code/off">${csrfField(req)}<button class="sm">Code deaktivieren</button></form>` : ''}</div></div></div>
<form class="card" style="margin-top:18px" method="post" action="/admin/customers/${esc(id)}/caps">${csrfField(req)}<h2>Grenzen</h2><p class="small muted">Gelten für alle KI-Zugriffe dieses Kunden. Der Kunde kann sie verschärfen, aber nicht lockern.</p>
<label class="check"><input type="checkbox" name="forceReadOnly" value="1"${caps.forceReadOnly ? ' checked' : ''}> <span><strong>Nur lesen erzwingen</strong></span></label>
<h3>Gesperrte Tools</h3><div class="cols">${Object.entries(ws.BLOCKABLE_TOOLS)
        .map(([k, label]) => `<label class="check"><input type="checkbox" name="block_${esc(k)}" value="1"${caps.blockedTools.includes(k) ? ' checked' : ''}> <span>${esc(label)} <code class="small">${esc(k)}</code></span></label>`)
        .join('')}</div><p><button class="primary">Grenzen speichern</button></p></form>
<div class="card"><h2>Seiten</h2>${sites.length ? `<table><tbody>${sites.map((x) => `<tr><td>${esc(x.name)}</td><td class="small muted">${esc(x.url)}</td><td class="small">${esc(x.user)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Noch keine Seite verbunden.</p>'}</div>
<div class="card"><h2>Bereich öffnen</h2><p class="small muted">Zeigt das Portal dieses Kunden nur lesend (Aktivität, Freigaben, Einstellungen). Der Zugriff wird im Zugriffsprotokoll des Kunden vermerkt.</p>
<form method="post" action="/admin/switch">${csrfField(req)}<input type="hidden" name="ws" value="${esc(id)}"><button>Als Betreiber öffnen</button></form></div>
<div class="card"><h2>Kunden löschen</h2><p class="small muted">Trennt alle Seiten (Anwendungspasswörter werden widerrufen) und löscht alle Daten dieses Kunden. Ein Löschnachweis bleibt.</p>
<form method="post" action="/admin/customers/${esc(id)}/delete">${csrfField(req)}<div class="field" style="max-width:420px"><label for="c">Zur Bestätigung den Namen eingeben: <code>${esc(w.name)}</code></label><input id="c" type="text" name="confirm" autocomplete="off" required></div><button class="danger">Endgültig löschen</button></form></div>`,
    );
  };

  r.get('/customers/:id', ownerOnly, (req, res) => {
    const w = ws.getWorkspace(String(req.params.id));
    if (!w || w.isOwner) return back(res, '/admin/customers', 'Kunde nicht gefunden.', 'err');
    res.send(customerPage(req, w.id));
  });

  r.post('/customers/:id/rename', ownerOnly, (req, res) => {
    ws.renameWorkspace(String(req.params.id), String(req.body.name ?? '').trim() || String(req.params.id));
    back(res, `/admin/customers/${String(req.params.id)}`, 'Gespeichert.');
  });

  r.post('/customers/:id/code', ownerOnly, (req, res) => {
    if (!ws.getWorkspace(String(req.params.id))) return back(res, '/admin/customers', 'Kunde nicht gefunden.', 'err');
    res.send(customerPage(req, String(req.params.id), codeBox(ws.rotateConnectCode(String(req.params.id)))));
  });

  r.post('/customers/:id/code/off', ownerOnly, (req, res) => {
    ws.disableConnectCode(String(req.params.id));
    back(res, `/admin/customers/${String(req.params.id)}`, 'Verbindungscode deaktiviert.');
  });

  r.post('/customers/:id/caps', ownerOnly, (req, res) => {
    const blocked = Object.keys(ws.BLOCKABLE_TOOLS).filter((k) => req.body[`block_${k}`]);
    ws.updateCaps(String(req.params.id), { forceReadOnly: Boolean(req.body.forceReadOnly), blockedTools: blocked });
    activity.logAccess({ workspaceId: String(req.params.id), actor: 'Betreiber', action: 'grenzen_geaendert', ip: req.ip, detail: `nur lesen: ${req.body.forceReadOnly ? 'ja' : 'nein'}, gesperrt: ${blocked.join(', ') || '–'}` });
    back(res, `/admin/customers/${String(req.params.id)}`, 'Grenzen gespeichert.');
  });

  r.post('/customers/:id/delete', ownerOnly, async (req, res) => {
    const w = ws.getWorkspace(String(req.params.id));
    if (!w || w.isOwner) return back(res, '/admin/customers', 'Kunde nicht gefunden.', 'err');
    if (String(req.body.confirm ?? '').trim() !== w.name) return back(res, `/admin/customers/${w.id}`, 'Der eingegebene Name stimmt nicht.', 'err');
    try {
      const receipt = await deleteWorkspace(w.id, 'Betreiber', provider);
      const s = session(req);
      if (s && s.workspaceId === w.id) s.workspaceId = ws.OWNER_WS;
      res.send(deletionReceipt(receipt));
    } catch (e) {
      back(res, `/admin/customers/${w.id}`, (e as Error).message, 'err');
    }
  });

  r.get('/access', ownerOnly, (req, res) => {
    res.send(layout(req, 'Zugriffsprotokoll', `<h1>Zugriffsprotokoll</h1><p class="lead">Anmeldungen, KI-Verbindungen, Betreiber-Zugriffe, Exporte und Löschungen aller Bereiche (${activity.ACCESS_LOG_DAYS} Tage).</p><div class="card">${accessTable(activity.accessLog(undefined, 500), true)}</div>`));
  });

  // ----- operator security (2FA) -----
  const pendingTotp = new Map<string, string>();

  r.get('/security', ownerOnly, async (req, res) => {
    const s = session(req)!;
    let setup = '';
    if (!ownerTotpEnabled()) {
      const secret = pendingTotp.get(s.id) ?? newTotpSecret();
      pendingTotp.set(s.id, secret);
      const { uri, svg } = await totpQrSvg(secret);
      setup = `<p>Scanne den QR-Code mit einer Authenticator-App (z. B. Aegis, 2FAS, Google Authenticator, 1Password) und gib den angezeigten Code ein.</p>
<div class="row" style="align-items:flex-start"><div class="qr">${svg}</div><div style="flex:1;min-width:240px"><p class="small muted">Oder manuell eingeben:</p><pre>${esc(secret.replace(/(.{4})/g, '$1 ').trim())}</pre><p class="small muted" style="word-break:break-all">${esc(uri)}</p></div></div>
<form method="post" action="/admin/security/totp" class="row">${csrfField(req)}<input type="text" name="otp" inputmode="numeric" placeholder="123456" required style="max-width:160px"><button class="primary">Aktivieren</button></form>`;
    }
    res.send(
      layout(
        req,
        'Sicherheit',
        `<h1>Sicherheit</h1>
<div class="card"><h2>Zwei-Faktor-Anmeldung für den Betreiber</h2>${
          ownerTotpEnabled()
            ? `<p><span class="pill ok">aktiv</span> Bei jeder Betreiber-Anmeldung (Portal und KI-Client) wird zusätzlich ein Code abgefragt.</p>
<form method="post" action="/admin/security/totp/off" class="row" onsubmit="return confirm('Zwei-Faktor-Anmeldung abschalten?')">${csrfField(req)}<input type="text" name="otp" inputmode="numeric" placeholder="aktueller Code" required style="max-width:160px"><button class="danger">Abschalten</button></form>`
            : setup
        }</div>
<div class="card"><h2>Schlüssel für die Verschlüsselung</h2>${
          keyInDataVolume()
            ? `<p><span class="pill wait">im Datenvolume</span> Der Schlüssel liegt in <code>${esc(config.dataDir)}/secret.key</code>, also im selben Volume wie die verschlüsselten Daten. Wer eine Sicherung von <code>/data</code> bekommt, hat damit auch den Schlüssel.</p>
<p class="small">So trennst du ihn ab:</p><ol class="small"><li>In Coolify im Terminal des Containers <code>cat /data/secret.key</code> ausführen und den Wert in den Passwortmanager kopieren.</li><li>In Coolify die Umgebungsvariable <code>SECRET_KEY</code> mit genau diesem Wert anlegen und neu deployen.</li><li>Prüfen, ob alle Seiten erreichbar sind, dann <code>rm /data/secret.key</code> ausführen.</li></ol>`
            : '<p><span class="pill ok">getrennt</span> Der Schlüssel kommt aus der Umgebungsvariable <code>SECRET_KEY</code>.</p>'
        }</div>
<div class="card"><h2>Server</h2><table><tbody><tr><th>Version</th><td>${esc(APP_VERSION)}</td></tr><tr><th>Öffentliche Adresse</th><td>${esc(config.publicUrl)}</td></tr><tr><th>Daten</th><td><code>${esc(config.dataDir)}</code> · Zugangsdaten und Keys AES-256-GCM-verschlüsselt</td></tr></tbody></table></div>`,
      ),
    );
  });

  r.post('/security/totp', ownerOnly, (req, res) => {
    const s = session(req)!;
    const secret = pendingTotp.get(s.id);
    if (!secret) return back(res, '/admin/security', 'Bitte Seite neu laden.', 'err');
    if (!verifyTotp(secret, String(req.body.otp ?? ''))) return back(res, '/admin/security', 'Code stimmt nicht. Uhrzeit am Handy prüfen und erneut versuchen.', 'err');
    enableOwnerTotp(secret);
    pendingTotp.delete(s.id);
    activity.logAccess({ workspaceId: ws.OWNER_WS, actor: 'Betreiber', action: '2fa', ip: req.ip, detail: 'aktiviert' });
    back(res, '/admin/security', 'Zwei-Faktor-Anmeldung ist aktiv.');
  });

  r.post('/security/totp/off', ownerOnly, (req, res) => {
    if (!verifyTotp(ownerTotpSecret() ?? '', String(req.body.otp ?? ''))) return back(res, '/admin/security', 'Code stimmt nicht.', 'err');
    disableOwnerTotp();
    activity.logAccess({ workspaceId: ws.OWNER_WS, actor: 'Betreiber', action: '2fa', ip: req.ip, detail: 'deaktiviert' });
    back(res, '/admin/security', 'Zwei-Faktor-Anmeldung abgeschaltet.', 'warn');
  });

  // ----- skills (operator) -----
  r.get('/skills', ownerOnly, (req, res) => {
    const skills = loadSkills();
    res.send(
      layout(
        req,
        'Skills',
        `<h1>Skills</h1><p class="lead">Arbeitsanleitungen, die jede KI über diesen Server bei Bedarf lädt (für alle Kunden). Eigene Skills überschreiben mitgelieferte mit gleichem Namen. Die KI selbst kann keine Skills ändern.</p>
<div class="row" style="margin-bottom:16px"><a class="btn primary" href="/admin/skills/_new">Neuer Skill</a></div>
<div class="card"><table><thead><tr><th>Name</th><th>Beschreibung</th><th>Quelle</th></tr></thead><tbody>${skills
          .map((x) => `<tr><td><a href="/admin/skills/${esc(x.name)}"><strong>${esc(x.name)}</strong></a></td><td class="small">${esc(x.description)}</td><td><span class="pill${x.source === 'saved' ? ' ok' : ''}">${x.source === 'saved' ? 'eigener' : 'mitgeliefert'}</span></td></tr>`)
          .join('')}</tbody></table></div>`,
      ),
    );
  });

  r.get('/skills/:name', ownerOnly, (req, res) => {
    const isNew = String(req.params.name) === '_new';
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const x = loadSkills().find((k) => k.name === (isNew ? from : String(req.params.name)));
    if (!isNew && !x) return back(res, '/admin/skills', 'Skill nicht gefunden.', 'err');
    const editable = isNew || x!.source === 'saved';
    res.send(
      layout(
        req,
        isNew ? 'Neuer Skill' : x!.name,
        `<h1>${isNew ? 'Neuer Skill' : esc(x!.name)}</h1>
${
  editable
    ? `<form class="card" method="post" action="/admin/skills">${csrfField(req)}
<div class="field"><label for="n">Name</label><input id="n" type="text" name="name" value="${esc(isNew ? (from ?? '') : x!.name)}" pattern="[a-z0-9][a-z0-9-]{1,60}" required ${isNew ? '' : 'readonly'}></div>
<div class="field"><label for="d">Beschreibung (wann soll die KI den Skill laden?)</label><input id="d" type="text" name="description" value="${esc(x?.description ?? '')}" required></div>
<div class="field"><label for="c">Inhalt (Markdown)</label><textarea id="c" name="content" required>${esc(x?.content ?? '')}</textarea></div>
<div class="row"><button class="primary">Speichern</button><a class="btn" href="/admin/skills">Zurück</a></div></form>
${!isNew ? `<form method="post" action="/admin/skills/${esc(x!.name)}/delete" onsubmit="return confirm('Skill löschen?')">${csrfField(req)}<button class="sm danger">Löschen</button></form>` : ''}`
    : `<div class="card"><p class="muted small">${esc(x!.description)}</p><pre>${esc(x!.content)}</pre><div class="row"><a class="btn primary" href="/admin/skills/_new?from=${esc(x!.name)}">Als eigenen Skill bearbeiten</a><a class="btn" href="/admin/skills">Zurück</a></div></div>`
}`,
      ),
    );
  });

  r.post('/skills', ownerOnly, (req, res) => {
    try {
      saveSkill(String(req.body.name ?? ''), String(req.body.description ?? ''), String(req.body.content ?? ''));
      back(res, `/admin/skills/${encodeURIComponent(String(req.body.name))}`, 'Gespeichert.');
    } catch (e) {
      back(res, '/admin/skills', (e as Error).message, 'err');
    }
  });

  r.post('/skills/:name/delete', ownerOnly, (req, res) => {
    deleteSkill(String(req.params.name));
    back(res, '/admin/skills', 'Skill gelöscht.');
  });

  setInterval(() => {
    const t = Date.now();
    for (const [k, s] of sessions) if (s.expires < t) sessions.delete(k);
    for (const [k, v] of PENDING_2FA) if (v.expires < t) PENDING_2FA.delete(k);
  }, 10 * 60 * 1000).unref();

  return r;
}
