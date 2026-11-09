/**
 * Code & Blocks WordPress MCP – tenant isolation and privacy tests
 * Author: Code & Blocks by Marijan
 *
 * Starts the built server (dist/) with two fake WordPress sites belonging to
 * two customers and checks that neither customer (nor their AI) can reach the
 * other's data. Run: npm run build && npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { startMockWordPress } from './mock-wordpress.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4300 + Math.floor(Math.random() * 400);
const SERVER = `http://localhost:${PORT}`;
const ADMIN_PASSWORD = 'test-admin-password-123';
let proc;
let dataDir;
let wpA;
let wpB;
let internal;
let internalHits = 0;

/** Tiny browser: cookie jar + manual redirects. */
function browser() {
  const jar = new Map();
  const store = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || v === '') jar.delete(k.trim());
      else jar.set(k.trim(), v);
    }
  };
  const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    jar,
    async req(url, opts = {}) {
      const res = await fetch(url, { redirect: 'manual', ...opts, headers: { ...(opts.headers ?? {}), cookie: cookie() } });
      store(res);
      return res;
    },
    async form(url, data) {
      return this.req(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
    },
    async follow(url, max = 8) {
      let res = await this.req(url);
      for (let i = 0; i < max && res.status >= 300 && res.status < 400; i++) res = await this.req(new URL(res.headers.get('location'), url).href);
      return res;
    },
  };
}

const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];

async function mcp(token, method, params = {}) {
  const res = await fetch(`${SERVER}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (res.status !== 200) return { status: res.status };
  return res.json();
}

const call = async (token, name, args = {}) => {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  return { text: r.result?.content?.[0]?.text ?? JSON.stringify(r), isError: Boolean(r.result?.isError), status: r.status };
};

// ---------- setup ----------
const owner = browser();
const ctx = { codes: {}, tokens: {}, ws: {}, sites: {} };

async function ownerCsrf() {
  const html = await (await owner.req(`${SERVER}/admin`)).text();
  return csrfOf(html);
}

async function connectWithCode(code, wp, user, password) {
  const b = browser();
  let res = await b.form(`${SERVER}/connect/start`, { site: wp.base, code, return: `${wp.base}/wp-admin/admin.php?page=cbmcp&tab=connection` });
  const html = await res.text();
  assert.equal(res.status, 200, html);
  const state = html.match(/name="state" value="([^"]+)"/)[1];
  res = await b.form(`${SERVER}/connect/confirm`, { state });
  assert.equal(res.status, 303);
  const authorize = new URL(res.headers.get('location'));
  const success = new URL(authorize.searchParams.get('success_url'));
  success.searchParams.set('user_login', user);
  success.searchParams.set('password', password);
  res = await b.req(success.href);
  return res;
}

async function customerPortal(wp) {
  const b = browser();
  const res = await b.follow(`${SERVER}/sso/start?site=${encodeURIComponent(wp.base)}&purpose=portal`);
  return { b, html: await res.text() };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbmcp-test-'));
  internal = http.createServer((_req, res) => {
    internalHits++;
    res.end('INTERNAL-SECRET');
  });
  await new Promise((r) => internal.listen(PORT + 3, '127.0.0.1', r));
  // "localhost" is a different host name than the sites' 127.0.0.1 – like an internal service
  wpA = await startMockWordPress({ port: PORT + 1, name: 'alpha', user: 'anna', password: 'aaaa bbbb cccc', serverUrl: SERVER, internalUrl: `http://localhost:${PORT + 3}` });
  wpB = await startMockWordPress({ port: PORT + 2, name: 'beta', user: 'bert', password: 'dddd eeee ffff', serverUrl: SERVER });
  proc = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'dist/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PUBLIC_URL: SERVER, ADMIN_PASSWORD, DATA_DIR: dataDir, APPROVAL_WAIT_SECONDS: '1', MCP_TOKEN: '', WP_URL: '', ALLOW_PRIVATE_FETCH: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${SERVER}/health`)).ok) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // operator login
  const res = await owner.form(`${SERVER}/admin/login`, { password: ADMIN_PASSWORD, next: '/admin' });
  assert.equal(res.status, 303, log);
  // two customers
  for (const [key, name] of [['a', 'Kunde Alpha'], ['b', 'Kunde Beta']]) {
    const html = await (await owner.form(`${SERVER}/admin/customers`, { csrf: await ownerCsrf(), name })).text();
    ctx.codes[key] = html.match(/<code id="code">([^<]+)<\/code>/)[1];
    ctx.ws[key] = html.match(/ID <code>([^<]+)<\/code>/)[1];
  }
  // each customer connects their site with their own code
  assert.equal((await connectWithCode(ctx.codes.a, wpA, 'anna', 'aaaa bbbb cccc')).status, 303);
  assert.equal((await connectWithCode(ctx.codes.b, wpB, 'bert', 'dddd eeee ffff')).status, 303);
  // each customer signs in with WordPress and creates a token for their AI
  for (const [key, wp] of [['a', wpA], ['b', wpB]]) {
    const { b, html } = await customerPortal(wp);
    const out = await (await b.form(`${SERVER}/admin/settings/token`, { csrf: csrfOf(html), label: `test-${key}`, days: '30' })).text();
    ctx.tokens[key] = out.match(/<code id="tok">([^<]+)<\/code>/)[1];
  }
  const listA = JSON.parse((await call(ctx.tokens.a, 'list_sites')).text);
  const listB = JSON.parse((await call(ctx.tokens.b, 'list_sites')).text);
  ctx.sites.a = listA.sites[0].id;
  ctx.sites.b = listB.sites[0].id;
});

after(() => {
  proc?.kill();
  internal?.close();
  wpA?.server.close();
  wpB?.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------- tests ----------

test('connecting needs a confirmation in the same browser', async () => {
  // attacker starts with their own code, the victim's browser never confirmed
  const attacker = browser();
  const res = await attacker.form(`${SERVER}/connect/start`, { site: wpA.base, code: ctx.codes.a });
  const html = await res.text();
  assert.match(html, /Kunde Alpha/, 'confirmation page names the target account');
  const state = html.match(/name="state" value="([^"]+)"/)[1];
  const victim = browser();
  const r = await victim.form(`${SERVER}/connect/confirm`, { state });
  assert.equal(r.status, 400);
});

test('WordPress REST redirects to another host are blocked', async () => {
  const before = internalHits;
  const r = await call(ctx.tokens.a, 'rest_request', { path: '/wp/v2/redirect-test' });
  assert.ok(r.isError);
  assert.match(r.text, /Blocked redirect/);
  assert.doesNotMatch(r.text, /INTERNAL-SECRET/);
  assert.equal(internalHits, before);
});

test('front-end redirects to another host are blocked (fetch_page, audit_page)', async () => {
  const before = internalHits;
  for (const tool of ['fetch_page', 'audit_page']) {
    const r = await call(ctx.tokens.a, tool, { path: '/go/' });
    assert.ok(r.isError, tool);
    assert.doesNotMatch(r.text, /INTERNAL-SECRET/);
  }
  assert.equal(internalHits, before);
});

test('free REST writes need approval', async () => {
  const r = await call(ctx.tokens.a, 'rest_request', { method: 'DELETE', path: '/wp/v2/posts/1', query: { force: true } });
  assert.match(r.text, /APPROVAL REQUIRED/);
});

test('personal-data gate catches embeds and form tables', async () => {
  assert.match((await call(ctx.tokens.a, 'rest_request', { path: '/wp/v2/posts', query: { _embed: 1 } })).text, /switched off/);
  assert.match((await call(ctx.tokens.a, 'db_query', { sql: 'SELECT * FROM {prefix}fluentform_submissions LIMIT 5' })).text, /switched off/);
  assert.doesNotMatch((await call(ctx.tokens.a, 'db_query', { sql: 'SELECT ID, menu_order FROM {prefix}posts ORDER BY menu_order' })).text, /switched off/);
});

test('operator view of a customer area is read-only', async () => {
  await owner.form(`${SERVER}/admin/switch`, { csrf: await ownerCsrf(), ws: ctx.ws.b });
  const res = await owner.form(`${SERVER}/admin/privacy`, { csrf: await ownerCsrf(), retention: '30' });
  assert.match(decodeURIComponent(res.headers.get('location') ?? ''), /nur lesend/);
  const tok = await owner.form(`${SERVER}/admin/settings/token`, { csrf: await ownerCsrf(), label: 'owner-sneak' });
  assert.equal(tok.status, 303);
  await owner.form(`${SERVER}/admin/switch`, { csrf: await ownerCsrf(), ws: 'intern' });
  const { b } = await customerPortal(wpB);
  const priv = await (await b.req(`${SERVER}/admin/privacy`)).text();
  assert.match(priv, /value="90" selected/);
  const settings = await (await b.req(`${SERVER}/admin/settings`)).text();
  assert.doesNotMatch(settings, /owner-sneak/);
});

test('wrong connection code is rejected', async () => {
  const res = await browser().form(`${SERVER}/connect/start`, { site: wpA.base, code: 'CBX-AAAA-BBBB-CCCC' });
  assert.equal(res.status, 401);
});

test('a site cannot be connected to a second customer', async () => {
  const res = await browser().form(`${SERVER}/connect/start`, { site: wpA.base, code: ctx.codes.b });
  assert.equal(res.status, 409);
});

test('each AI token only sees its own customer\'s site', async () => {
  const a = JSON.parse((await call(ctx.tokens.a, 'list_sites')).text);
  const b = JSON.parse((await call(ctx.tokens.b, 'list_sites')).text);
  assert.deepEqual(a.sites.map((s) => s.url), [wpA.base]);
  assert.deepEqual(b.sites.map((s) => s.url), [wpB.base]);
});

test('an AI token cannot address another customer\'s site by id', async () => {
  const r = await call(ctx.tokens.a, 'get_content', { site: ctx.sites.b, type: 'posts', id: 1 });
  assert.ok(r.isError);
  assert.match(r.text, /Unknown site/);
  assert.doesNotMatch(r.text, /beta/i);
});

test('personal data is pseudonymised and restored on write', async () => {
  const r = await call(ctx.tokens.a, 'list_content', { type: 'posts' });
  assert.doesNotMatch(r.text, /office@alpha\.at/);
  assert.doesNotMatch(r.text, /664 1234567/);
  const token = r.text.match(/\[\[pii:[a-f0-9]{10}\]\]/)[0];
  const w = await call(ctx.tokens.a, 'update_content', { type: 'posts', id: 1, content: `<p>Neu: ${token}</p>` });
  assert.ok(!w.isError, w.text);
  assert.equal(wpA.state.writes.at(-1).content, '<p>Neu: office@alpha.at</p>');
});

test('placeholders of one customer are useless for another', async () => {
  const r = await call(ctx.tokens.a, 'list_content', { type: 'posts' });
  const token = r.text.match(/\[\[pii:[a-f0-9]{10}\]\]/)[0];
  const w = await call(ctx.tokens.b, 'update_content', { type: 'posts', id: 1, content: token });
  assert.ok(w.isError);
  assert.match(w.text, /unknown or expired/);
  assert.equal(wpB.state.writes.length, 0);
});

test('personal-data endpoints are blocked by default', async () => {
  const r = await call(ctx.tokens.a, 'rest_request', { path: '/wp/v2/comments' });
  assert.match(r.text, /personal data .* switched off/);
});

test('approvals of one customer are invisible to another customer', async () => {
  const r = await call(ctx.tokens.a, 'delete_content', { type: 'posts', id: 1, force: true });
  const id = r.text.match(/approval_id="([a-f0-9]+)"/)[1];
  // customer B signs in with WordPress
  const b = browser();
  const res = await b.follow(`${SERVER}/sso/start?site=${encodeURIComponent(wpB.base)}&purpose=portal`);
  assert.equal(res.status, 200);
  const page = await (await b.req(`${SERVER}/admin/approvals/${id}`)).text();
  assert.doesNotMatch(page, /Freigeben<\/button>/);
  const list = await (await b.req(`${SERVER}/admin/approvals`)).text();
  assert.doesNotMatch(list, new RegExp(id));
});

test('customer portal via WordPress login shows only the own account', async () => {
  const a = browser();
  const res = await a.follow(`${SERVER}/sso/start?site=${encodeURIComponent(wpA.base)}&purpose=portal`);
  const html = await res.text();
  assert.match(html, /Kunde Alpha/);
  const sites = await (await a.req(`${SERVER}/admin/sites`)).text();
  assert.match(sites, new RegExp(wpA.base.replace(/[.:/]/g, '\\$&')));
  assert.doesNotMatch(sites, new RegExp(wpB.base.replace(/[.:/]/g, '\\$&')));
  assert.equal((await a.req(`${SERVER}/admin/customers`)).status, 403);
  const csrf = csrfOf(html);
  assert.equal((await a.form(`${SERVER}/admin/switch`, { csrf, ws: ctx.ws.b })).status, 403);
  const exp = await (await a.req(`${SERVER}/admin/privacy/export`)).text();
  assert.doesNotMatch(exp, /aaaa|bbbb|cccc/, 'export must not contain the application password');
  assert.doesNotMatch(exp, /beta/i);
});

test('SSO without the starting browser is rejected', async () => {
  const a = browser();
  const res = await a.req(`${SERVER}/sso/start?site=${encodeURIComponent(wpA.base)}&purpose=portal`);
  const wpUrl = res.headers.get('location');
  const back = await fetch(wpUrl, { redirect: 'manual' });
  const callback = back.headers.get('location');
  const other = browser();
  const r = await other.req(callback);
  assert.equal(r.status, 400);
});

test('operator limits remove tools for that customer only', async () => {
  await owner.form(`${SERVER}/admin/customers/${ctx.ws.a}/caps`, { csrf: await ownerCsrf(), block_file_write: '1', block_db_query: '1' });
  const toolsA = (await mcp(ctx.tokens.a, 'tools/list')).result.tools.map((t) => t.name);
  const toolsB = (await mcp(ctx.tokens.b, 'tools/list')).result.tools.map((t) => t.name);
  assert.ok(!toolsA.includes('file_write'));
  assert.ok(!toolsA.includes('db_query'));
  assert.ok(toolsB.includes('file_write'));
  assert.ok(!toolsA.includes('skill_save') && !toolsB.includes('skill_save'), 'AI must not be able to change skills');
});

test('activity summaries contain no personal data', async () => {
  const all = JSON.stringify(wpA.state.activity);
  assert.doesNotMatch(all, /office@alpha\.at/);
});

test('deleting a customer revokes access and WordPress credentials', async () => {
  const before = wpA.state.revoked;
  const res = await owner.form(`${SERVER}/admin/customers/${ctx.ws.a}/delete`, { csrf: await ownerCsrf(), confirm: 'Kunde Alpha' });
  assert.match(await res.text(), /Löschbestätigung/);
  assert.equal(wpA.state.revoked, before + 1);
  const r = await mcp(ctx.tokens.a, 'tools/list');
  assert.equal(r.status, 401);
  const b = JSON.parse((await call(ctx.tokens.b, 'list_sites')).text);
  assert.equal(b.sites.length, 1, 'other customers are unaffected');
});
