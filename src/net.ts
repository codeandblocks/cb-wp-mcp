/**
 * Code & Blocks WordPress MCP – safe outbound fetching
 * Author: Code & Blocks by Marijan
 *
 * Downloads triggered by tools (e.g. "upload this image from URL") must not
 * reach internal services on the VPS (Coolify, databases, metadata APIs).
 */
import dnsCb from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
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

/**
 * DNS lookup used for every outgoing connection: refuses private/internal
 * addresses at connect time (also protects against DNS rebinding).
 */
function guardedLookup(hostname: string, options: any, cb: (...args: any[]) => void) {
  const opts = typeof options === 'object' && options !== null ? options : { family: options };
  dnsCb.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = (Array.isArray(addrs) ? addrs : [addrs]) as { address: string; family: number }[];
    if (!config.allowPrivateFetch && (list.length === 0 || list.some((a) => isPrivateIp(a.address)))) {
      const e = new Error(`Refusing to connect to ${hostname}: resolves to a private/internal address`) as NodeJS.ErrnoException;
      e.code = 'EPRIVATEADDR';
      return cb(e);
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

const agent = new Agent({ connect: { lookup: guardedLookup as any }, headersTimeout: 60_000, bodyTimeout: 120_000 });

export class BlockedRequestError extends Error {}

function assertAllowedUrl(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedRequestError(`Unsupported protocol ${url.protocol}`);
  if (url.username || url.password) throw new BlockedRequestError('URLs with credentials are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // IP literals skip DNS lookup, so check them here.
  if (!config.allowPrivateFetch && (net.isIP(host) ? isPrivateIp(host) : /^localhost$|\.localhost$|\.internal$|\.local$/i.test(host))) {
    throw new BlockedRequestError(`Refusing to connect to ${url.hostname}: private/internal address`);
  }
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '');

export interface GuardOptions {
  /** Only follow redirects to the same host (www. variant allowed), never downgrade https → http. */
  sameHost?: boolean;
  maxRedirects?: number;
}

/**
 * The only way this server talks to the outside world: blocks private and
 * internal addresses on every hop (checked at connect time) and validates
 * each redirect itself instead of letting fetch follow it.
 */
export async function guardedFetch(rawUrl: string | URL, init: RequestInit = {}, opts: GuardOptions = {}): Promise<Response> {
  const origin = new URL(String(rawUrl));
  let url = origin;
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) };
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    assertAllowedUrl(url);
    const res = (await undiciFetch(url, {
      method,
      headers,
      body: body as any,
      redirect: 'manual',
      dispatcher: agent,
      signal: init.signal ?? AbortSignal.timeout(60_000),
    })) as unknown as Response;
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return res;
    await res.body?.cancel().catch(() => undefined);
    const next = new URL(location, url);
    if (opts.sameHost) {
      if (bareHost(next.hostname) !== bareHost(origin.hostname)) throw new BlockedRequestError(`Blocked redirect from ${origin.hostname} to another host (${next.hostname})`);
      if (origin.protocol === 'https:' && next.protocol !== 'https:') throw new BlockedRequestError('Blocked redirect from https to http');
    } else if (next.hostname !== url.hostname) {
      delete headers.Authorization;
      delete headers.authorization;
    }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
    }
    url = next;
  }
  throw new BlockedRequestError('Too many redirects');
}

/** Download from a public URL (no credentials, any host, private addresses blocked). */
export function safeFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  return guardedFetch(rawUrl, init, { sameHost: false });
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
