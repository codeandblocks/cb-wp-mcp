/**
 * Code & Blocks WordPress MCP – minimal fake WordPress for tests
 * Author: Code & Blocks by Marijan
 */
import http from 'node:http';
import crypto from 'node:crypto';

export function startMockWordPress({ port, name, user, password, serverUrl }) {
  const auth = 'Basic ' + Buffer.from(`${user}:${password.replace(/\s/g, '')}`).toString('base64');
  const state = { revoked: 0, writes: [], activity: [], ssoCodes: new Map(), appPasswords: [{ uuid: 'u1', app_id: '6f1c3c2e-6c2b-4e43-9d8f-2a9c0b5d7e11', name: 'Code & Blocks MCP' }] };
  const base = `http://127.0.0.1:${port}`;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url, base);
      const send = (status, data, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      // SSO step in wp-admin (the admin is "logged in")
      if (u.pathname === '/wp-admin/admin-post.php' && u.searchParams.get('action') === 'cbmcp_sso') {
        const code = crypto.randomBytes(24).toString('hex');
        state.ssoCodes.set(code, u.searchParams.get('state'));
        res.writeHead(302, { location: `${serverUrl}/sso/callback?state=${encodeURIComponent(u.searchParams.get('state'))}&code=${code}` });
        return res.end();
      }
      const p = u.pathname.replace(/^\/wp-json/, '');
      if ((p === '/' || p === '') && !req.headers.authorization) {
        return send(200, { name, url: base, home: base, authentication: { 'application-passwords': { endpoints: { authorization: `${base}/wp-admin/authorize-application.php` } } } });
      }
      if (req.headers.authorization !== auth) return send(401, { code: 'rest_not_logged_in', message: 'Not logged in' });
      const j = body && (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(body) : {};
      if (p === '/' || p === '') return send(200, { name, url: base });
      if (p === '/wp/v2/users/me') return send(200, { id: 1, name: user, capabilities: { manage_options: true } });
      if (p === '/wp/v2/users/me/application-passwords' && req.method === 'GET') return send(200, state.appPasswords);
      if (p.startsWith('/wp/v2/users/me/application-passwords/') && req.method === 'DELETE') {
        state.revoked++;
        return send(200, { deleted: true });
      }
      if (p === '/cbmcp/v1/sso/verify') {
        const st = state.ssoCodes.get(j.code);
        state.ssoCodes.delete(j.code);
        if (!st) return send(400, { code: 'cbmcp_sso_expired', message: 'expired' });
        return send(200, { user_login: `admin-${name}`, display_name: `Admin ${name}`, state: st, manage_options: true });
      }
      if (p === '/cbmcp/v1/activity/log') {
        state.activity.push(j);
        return send(200, { logged: state.activity.length });
      }
      if (p === '/cbmcp/v1/info') return send(200, { bridge_version: '1.3.0', wp_version: '7.1.4' });
      if (p === '/wp/v2/posts' && req.method === 'GET') {
        return send(200, [{ id: 1, status: 'publish', title: { raw: `Kontakt ${name}` }, content: { raw: `<p>Schreib an office@${name}.at oder ruf an: +43 664 1234567</p>` }, link: `${base}/kontakt/` }], { 'x-wp-total': '1', 'x-wp-totalpages': '1' });
      }
      if (p === '/wp/v2/posts/1' && req.method === 'GET') return send(200, { id: 1, title: { raw: `Kontakt ${name}` }, content: { raw: `<p>Schreib an office@${name}.at</p>` } });
      if (p === '/wp/v2/posts/1' && req.method === 'POST') {
        state.writes.push(j);
        return send(200, { id: 1, status: 'publish', title: { raw: j.title ?? 'x' }, link: `${base}/kontakt/` });
      }
      if (p === '/wp/v2/posts/1' && req.method === 'DELETE') return send(200, { deleted: true });
      if (p === '/wp/v2/comments') return send(200, [{ id: 5, author_name: 'Max', author_email: 'max@example.org', author_ip: '203.0.113.7' }]);
      send(404, { code: 'rest_no_route', message: `No route ${p}` });
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, state, base })));
}
