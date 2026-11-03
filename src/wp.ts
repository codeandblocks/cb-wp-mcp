/**
 * Code & Blocks WordPress MCP – WordPress REST client
 * Author: Code & Blocks by Marijan
 */
import { config, type SiteConfig } from './config.js';
import { USER_AGENT } from './net.js';

export class WPError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

export type Query = Record<string, string | number | boolean | (string | number)[] | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  raw?: { data: Buffer; contentType: string; filename: string };
  /** Pre-encoded query string (appended after `query`), e.g. for nested input[a][b]=c */
  rawQuery?: string;
  timeoutMs?: number;
}

export interface WPResponse<T = any> {
  status: number;
  data: T;
  total?: number;
  totalPages?: number;
}

function encodeQuery(query: Query | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return params.toString();
}

export class WPClient {
  readonly site: SiteConfig;
  private readonly auth: string;

  constructor(site: SiteConfig) {
    this.site = site;
    this.auth = 'Basic ' + Buffer.from(`${site.user}:${site.appPassword}`).toString('base64');
  }

  get host(): string {
    return new URL(this.site.url).hostname;
  }

  buildUrl(path: string, query?: Query, rawQuery?: string): string {
    const p = path.startsWith('/') ? path : `/${path}`;
    const qs = [encodeQuery(query), rawQuery ?? ''].filter(Boolean).join('&');
    if (this.site.restBase.includes('rest_route=')) {
      return `${this.site.restBase}${p}${qs ? `&${qs}` : ''}`;
    }
    return `${this.site.restBase}${p}${qs ? `?${qs}` : ''}`;
  }

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<WPResponse<T>> {
    const headers: Record<string, string> = {
      Authorization: this.auth,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
    let body: BodyInit | undefined;
    if (opts.raw) {
      const safeName = opts.raw.filename.replace(/[^\w.\-]+/g, '-').replace(/^-+/, '') || 'upload';
      headers['Content-Type'] = opts.raw.contentType;
      headers['Content-Disposition'] = `attachment; filename="${safeName}"`;
      body = new Uint8Array(opts.raw.data);
    } else if (opts.body !== undefined && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    const url = this.buildUrl(path, opts.query, opts.rawQuery);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new WPError(0, 'network_error', `Cannot reach ${this.site.url}: ${msg}`);
    }

    const text = await res.text();
    let data: any = text;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json') || /^\s*[[{]/.test(text)) {
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* keep raw text */
      }
    }

    if (!res.ok) {
      const code = (data && typeof data === 'object' && data.code) || `http_${res.status}`;
      let message = (data && typeof data === 'object' && data.message) || `HTTP ${res.status} ${res.statusText}`;
      if (res.status === 401) {
        message += ' – check WP user / Application Password. Some hosts strip the Authorization header (see README).';
      }
      if (typeof data === 'string' && data.length > 0 && !(data && typeof data === 'object')) {
        message += ` – ${data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)}`;
      }
      throw new WPError(res.status, code, message, typeof data === 'object' ? data?.data : undefined);
    }

    const total = res.headers.get('x-wp-total');
    const totalPages = res.headers.get('x-wp-totalpages');
    return {
      status: res.status,
      data: data as T,
      total: total ? Number(total) : undefined,
      totalPages: totalPages ? Number(totalPages) : undefined,
    };
  }

  get<T = any>(path: string, query?: Query) {
    return this.request<T>('GET', path, { query });
  }
  post<T = any>(path: string, body?: unknown, query?: Query) {
    return this.request<T>('POST', path, { body, query });
  }
  delete<T = any>(path: string, query?: Query) {
    return this.request<T>('DELETE', path, { query });
  }
}

const clients = new Map<string, WPClient>();

/** Forget cached clients (credentials or sites changed). */
export function resetClients() {
  clients.clear();
}

export function getClient(siteId?: string): WPClient {
  if (config.sites.length === 0) {
    throw new Error(`No WordPress site connected. Connect one at ${config.publicUrl ?? ''}/admin (or set WP_URL/WP_USER/WP_APP_PASSWORD).`);
  }
  const site = siteId ? config.sites.find((s) => s.id === siteId) : config.sites[0];
  if (!site) {
    throw new Error(`Unknown site "${siteId}". Available: ${config.sites.map((s) => s.id).join(', ')}`);
  }
  let client = clients.get(site.id);
  if (!client) {
    client = new WPClient(site);
    clients.set(site.id, client);
  }
  return client;
}

export function allSiteHosts(): string[] {
  return config.sites.map((s) => new URL(s.url).hostname);
}
