/**
 * Code & Blocks WordPress MCP – configuration
 * Author: Code & Blocks by Marijan
 *
 * All settings come from environment variables (set them in Coolify).
 */
import { z } from 'zod';

export const APP_NAME = 'Code & Blocks WordPress MCP';
export const APP_VERSION = '1.1.0';

const siteSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,40}$/i, 'Site id: letters, numbers, "-" and "_" only'),
  url: z.string().url(),
  user: z.string().min(1),
  appPassword: z.string().min(1),
  /** Optional: REST base, default "<url>/wp-json". Use "<url>/?rest_route=" without pretty permalinks. */
  restBase: z.string().url().optional(),
});

export interface SiteConfig {
  id: string;
  url: string;
  user: string;
  appPassword: string;
  restBase: string;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

function bool(name: string, fallback = false): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number`);
  return n;
}

function parseSites(): SiteConfig[] {
  const raw: unknown[] = [];
  const json = env('WP_SITES');
  if (json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('WP_SITES is not valid JSON');
    }
    if (!Array.isArray(parsed)) throw new Error('WP_SITES must be a JSON array');
    raw.push(...parsed);
  }
  if (env('WP_URL')) {
    raw.push({
      id: env('WP_SITE_ID') ?? 'default',
      url: env('WP_URL'),
      user: env('WP_USER'),
      appPassword: env('WP_APP_PASSWORD'),
      restBase: env('WP_REST_BASE'),
    });
  }

  const sites: SiteConfig[] = [];
  raw.forEach((entry, i) => {
    const res = siteSchema.safeParse(entry);
    if (!res.success) {
      throw new Error(
        `Invalid site #${i + 1}: ${res.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`,
      );
    }
    const s = res.data;
    if (sites.some((x) => x.id === s.id)) throw new Error(`Duplicate site id "${s.id}"`);
    const url = s.url.replace(/\/+$/, '');
    sites.push({
      id: s.id,
      url,
      user: s.user,
      appPassword: s.appPassword.replace(/\s+/g, ''),
      restBase: (s.restBase ?? `${url}/wp-json`).replace(/\/+$/, ''),
    });
  });
  return sites;
}

function publicUrl(): string | undefined {
  const explicit = env('PUBLIC_URL');
  // Coolify injects COOLIFY_URL (comma separated if several domains are set)
  const coolify = env('COOLIFY_URL')?.split(',')[0]?.trim();
  const url = explicit ?? coolify;
  return url ? url.replace(/\/+$/, '') : undefined;
}

function build() {
  const mcpToken = env('MCP_TOKEN');
  const adminPassword = env('ADMIN_PASSWORD');
  const url = publicUrl();

  if (mcpToken && mcpToken.length < 24) throw new Error('MCP_TOKEN must be at least 24 characters long');
  if (adminPassword && adminPassword.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters long');
  if (!mcpToken && !adminPassword) {
    throw new Error('Set ADMIN_PASSWORD (OAuth login for claude.ai) and/or MCP_TOKEN (static bearer token). Refusing to start without authentication.');
  }
  if (adminPassword && !url) throw new Error('PUBLIC_URL is required when ADMIN_PASSWORD (OAuth) is used, e.g. https://mcp.example.com');

  const trustProxyRaw = env('TRUST_PROXY') ?? '1';
  const trustProxy: boolean | number | string = /^\d+$/.test(trustProxyRaw)
    ? Number(trustProxyRaw)
    : trustProxyRaw === 'true'
      ? true
      : trustProxyRaw === 'false'
        ? false
        : trustProxyRaw;

  return {
    port: int('PORT', 3000),
    publicUrl: url,
    mcpToken,
    adminPassword,
    oauthEnabled: Boolean(adminPassword),
    allowTokenInUrl: bool('ALLOW_TOKEN_IN_URL', false),
    dataDir: env('DATA_DIR') ?? '/data',
    readOnly: bool('READ_ONLY', false),
    allowPrivateFetch: bool('ALLOW_PRIVATE_FETCH', false),
    maxOutputChars: int('MAX_OUTPUT_CHARS', 60000),
    maxUploadBytes: int('MAX_UPLOAD_MB', 50) * 1024 * 1024,
    accessTokenTtl: int('ACCESS_TOKEN_TTL_HOURS', 24 * 7) * 3600,
    refreshTokenTtl: int('REFRESH_TOKEN_TTL_DAYS', 180) * 86400,
    trustProxy,
    pexelsApiKey: env('PEXELS_API_KEY'),
    unsplashAccessKey: env('UNSPLASH_ACCESS_KEY'),
    skillsDir: env('SKILLS_DIR'),
    sites: parseSites(),
  };
}

export const config = build();
export type Config = typeof config;
