/**
 * Code & Blocks WordPress MCP – TOTP (RFC 6238) for the operator login
 * Author: Code & Blocks by Marijan
 */
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { APP_NAME } from './config.js';
import { getMeta, setMeta } from './db.js';
import { seal, unseal } from './crypto.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

const lastUsed = () => Number(getMeta('owner_totp_last') ?? 0);

export function verifyTotp(secret: string, code: string): boolean {
  const c = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const now = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const counter = now + d;
    if (counter <= lastUsed()) continue; // no replay (persisted across restarts)
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, counter)), Buffer.from(c))) {
      setMeta('owner_totp_last', String(counter));
      return true;
    }
  }
  return false;
}

// ---------- operator 2FA state ----------

export function ownerTotpSecret(): string | undefined {
  const v = getMeta('owner_totp');
  if (!v) return undefined;
  try {
    return unseal(v);
  } catch {
    return undefined;
  }
}

export const ownerTotpEnabled = () => Boolean(ownerTotpSecret());

export function newTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function enableOwnerTotp(secret: string) {
  setMeta('owner_totp', seal(secret));
}

export function disableOwnerTotp() {
  setMeta('owner_totp', null);
}

export async function totpQrSvg(secret: string, account = 'Betreiber'): Promise<{ uri: string; svg: string }> {
  const uri = `otpauth://totp/${encodeURIComponent(`${APP_NAME}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(APP_NAME)}&algorithm=SHA1&digits=6&period=30`;
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 });
  return { uri, svg };
}
