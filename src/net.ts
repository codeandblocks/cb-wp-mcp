/**
 * Code & Blocks WordPress MCP – safe outbound fetching
 * Author: Code & Blocks by Marijan
 *
 * Downloads triggered by tools (e.g. "upload this image from URL") must not
 * reach internal services on the VPS (Coolify, databases, metadata APIs).
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';

export const USER_AGENT = 'CodeBlocks-WP-MCP/1.0 (+self-hosted)';

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

function inV4(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4',
];

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return PRIVATE_V4.some((c) => inV4(ip, c));
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}

async function assertPublic(url: URL, trustedHosts: Set<string>): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported protocol ${url.protocol}`);
  if (config.allowPrivateFetch || trustedHosts.has(url.hostname.toLowerCase())) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateIp)) {
    throw new Error(`Refusing to fetch ${url.hostname}: resolves to a private/internal address`);
  }
}

/** fetch() that validates every redirect hop against private address ranges. */
export async function safeFetch(rawUrl: string, init: RequestInit = {}, trustedHosts: string[] = []): Promise<Response> {
  const trusted = new Set(trustedHosts.map((h) => h.toLowerCase()));
  let url = new URL(rawUrl);
  for (let hop = 0; hop < 6; hop++) {
    await assertPublic(url, trusted);
    const res = await fetch(url, {
      ...init,
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
      signal: init.signal ?? AbortSignal.timeout(60_000),
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

/** Read a response body into a Buffer, aborting above maxBytes. */
export async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error(`File too large (${len} bytes, limit ${maxBytes})`);
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`File too large (limit ${maxBytes} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
