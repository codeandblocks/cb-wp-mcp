/**
 * Code & Blocks WordPress MCP – encryption helpers
 * Author: Code & Blocks by Marijan
 *
 * AES-256-GCM. The key comes from SECRET_KEY or is generated once into
 * DATA_DIR/secret.key (same key file as version 1.2).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export interface Enc {
  iv: string;
  tag: string;
  data: string;
}

let key: Buffer | undefined;

function loadKey(): Buffer {
  if (config.secretKey) return crypto.createHash('sha256').update(config.secretKey).digest();
  const f = path.join(config.dataDir, 'secret.key');
  try {
    if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
    fs.mkdirSync(config.dataDir, { recursive: true });
    const k = crypto.randomBytes(32);
    fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 });
    return k;
  } catch (e) {
    console.warn(`[crypto] cannot persist ${f} (${(e as Error).message}); using a temporary key – stored secrets are lost on restart`);
    return crypto.randomBytes(32);
  }
}

function k(): Buffer {
  if (!key) key = loadKey();
  return key;
}

export function encrypt(plain: string): Enc {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k(), iv);
  const out = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: out.toString('base64') };
}

export function decrypt(e: Enc): string {
  const d = crypto.createDecipheriv('aes-256-gcm', k(), Buffer.from(e.iv, 'base64'));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
}

/** Encrypt to a JSON string (for database columns). */
export const seal = (plain: string) => JSON.stringify(encrypt(plain));
export const unseal = (sealed: string) => decrypt(JSON.parse(sealed) as Enc);

/** Keyed hash (for deterministic pseudonyms). */
export function hmac(value: string): string {
  return crypto.createHmac('sha256', k()).update(value).digest('hex');
}

export const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
