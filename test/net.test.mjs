/**
 * Code & Blocks WordPress MCP – outbound request guard
 * Author: Code & Blocks by Marijan
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.ADMIN_PASSWORD ??= 'test-admin-password-123';
process.env.PUBLIC_URL ??= 'http://localhost:1';
delete process.env.ALLOW_PRIVATE_FETCH;

const { guardedFetch } = await import('../dist/net.js');
let srv;
let hits = 0;
let port;

before(async () => {
  srv = http.createServer((_q, r) => {
    hits++;
    r.end('internal');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
});
after(() => srv.close());

for (const url of [
  () => `http://127.0.0.1:${port}/`,
  () => `http://localhost:${port}/`,
  () => `http://localhost.:${port}/`, // resolved by DNS → blocked at connect time
  () => `http://[::1]:${port}/`,
  () => `http://0.0.0.0:${port}/`,
  () => `http://2130706433:${port}/`, // 127.0.0.1 as a number
  () => 'http://169.254.169.254/latest/meta-data/',
  () => 'http://10.0.0.1/',
  () => 'http://192.168.1.1/',
  () => 'http://172.17.0.1:8000/',
  () => 'http://coolify.internal/',
  () => 'file:///etc/passwd',
  () => 'http://user:pass@example.com/',
]) {
  test(`blocked: ${url().replace(String(port), 'PORT')}`, async () => {
    const before = hits;
    await assert.rejects(guardedFetch(url(), { signal: AbortSignal.timeout(3000) }));
    assert.equal(hits, before);
  });
}
