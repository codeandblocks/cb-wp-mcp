/**
 * Code & Blocks WordPress MCP – protection of personal data (DSGVO)
 * Author: Code & Blocks by Marijan
 *
 * 1. Pseudonymisation: e-mail addresses, phone numbers and IP addresses in
 *    tool results are replaced by tokens like [[pii:3f9a0c1b2d]] before they
 *    reach the AI. When the AI writes a token back (e.g. when it edits a page
 *    that contains a contact address), the server puts the original value
 *    back. Mapping: encrypted, per workspace, 24 h.
 * 2. Personal-data gate: endpoints and tables that mainly contain personal
 *    data (users, comments, orders, form entries …) are blocked until the
 *    customer allows access in the portal.
 */
import { all, run } from './db.js';
import { ctx } from './context.js';
import { hmac, seal, unseal } from './crypto.js';
import { getSettings } from './workspaces.js';

const TTL_SECONDS = 24 * 3600;
const TOKEN_RE = /\[\[pii:([a-f0-9]{10})\]\]/g;

/** Tools whose results are code/configuration and are never masked. */
export const MASK_EXEMPT = new Set([
  'file_list',
  'file_read',
  'file_search',
  'manage_snippet',
  'skill_list',
  'skill_load',
  'list_sites',
  'list_abilities',
  'list_plugins',
  'list_themes',
  'db_schema',
  'list_content_types',
]);

const IMAGE_TLD = /\.(png|jpe?g|gif|webp|svg|avif|css|js|ico)$/i;

const PATTERNS: { re: RegExp; accept?: (m: string) => boolean }[] = [
  // e-mail
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g, accept: (m) => !IMAGE_TLD.test(m) },
  // international phone numbers (+43 …, 0043 …)
  { re: /(?<![\w+])(?:\+|00)[1-9]\d{0,2}(?:[ ./-]?\(?\d{1,5}\)?){2,6}(?![\w])/g, accept: (m) => m.replace(/\D/g, '').length >= 8 },
  // national phone numbers with separator after the area code (0664 1234567, 01/234 56 78)
  { re: /(?<![\w./-])0[1-9]\d{0,4}(?: ?\/ ?|[ -])\d{3,}(?:[ -]?\d{2,}){0,3}(?![\w./-])/g, accept: (m) => m.replace(/\D/g, '').length >= 7 },
  // IPv4
  { re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g },
  // IPv6 (full and compressed); plain times like 12:30:45 are skipped
  { re: /\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){2,7}\b/g, accept: (m) => /[a-f]/i.test(m) || m.includes('::') || m.split(':').length >= 5 },
];

function tokenFor(wsId: string, value: string): string {
  const id = hmac(`${wsId}\u0000${value}`).slice(0, 10);
  run(
    `INSERT INTO pii_tokens (workspace_id, token, value, expires_at) VALUES (:ws, :t, :v, :e)
     ON CONFLICT(workspace_id, token) DO UPDATE SET expires_at = excluded.expires_at`,
    { ws: wsId, t: id, v: seal(value), e: Math.floor(Date.now() / 1000) + TTL_SECONDS },
  );
  return `[[pii:${id}]]`;
}

/** Replace personal data in a tool result. */
export function maskText(text: string, wsId = ctx().workspaceId): { text: string; count: number } {
  let count = 0;
  const cache = new Map<string, string>();
  let out = text;
  for (const { re, accept } of PATTERNS) {
    out = out.replace(re, (m) => {
      if (m.includes('[[pii:') || (accept && !accept(m))) return m;
      let t = cache.get(m);
      if (!t) {
        t = tokenFor(wsId, m);
        cache.set(m, t);
      }
      count++;
      return t;
    });
  }
  return { text: out, count };
}

export class ExpiredPseudonymError extends Error {}

/** Put original values back into tool arguments written by the AI. */
export function unmaskDeep<T>(value: T, wsId = ctx().workspaceId): T {
  const ids = new Set<string>();
  const collect = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.matchAll(TOKEN_RE)) ids.add(m[1]);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(value);
  if (!ids.size) return value;
  const map = new Map<string, string>();
  const now = Math.floor(Date.now() / 1000);
  for (const r of all<{ token: string; value: string; expires_at: number }>(
    `SELECT token, value, expires_at FROM pii_tokens WHERE workspace_id = :ws AND token IN (${[...ids].map((_, i) => `:t${i}`).join(',')})`,
    Object.fromEntries([['ws', wsId], ...[...ids].map((id, i) => [`t${i}`, id])]),
  )) {
    if (r.expires_at >= now) map.set(r.token, unseal(r.value));
  }
  const missing = [...ids].filter((id) => !map.has(id));
  if (missing.length) {
    throw new ExpiredPseudonymError(
      `The placeholder(s) ${missing.map((m) => `[[pii:${m}]]`).join(', ')} are unknown or expired. Read the data again and retry; never invent placeholders.`,
    );
  }
  const replace = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(TOKEN_RE, (_m, id: string) => map.get(id)!);
    if (Array.isArray(v)) return v.map(replace);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replace(x)]));
    return v;
  };
  return replace(value) as T;
}

// ---------- personal-data gate ----------

const PII_REST = [
  /^\/wp\/v2\/users(?!\/me(?:\/|$|\?))/i,
  /^\/wp\/v2\/comments/i,
  /^\/wc\/v\d\/(orders|customers|refunds)/i,
  /^\/wc-analytics\/(customers|reports\/customers|orders)/i,
  /^\/wc\/store/i,
  /^\/(fluentform|wpforms|gf|frm|ninja-forms|sureforms|srfm|edd|affwp|flamingo|cartflows)[^/]*\//i,
];

const PII_TABLES =
  /\b\w*(users|usermeta|comments|commentmeta|wc_orders|wc_order_addresses|wc_customer_lookup|woocommerce_order_items|fluentform_submissions|fluentform_entry_details|frm_items|frm_item_metas|wpforms_entr\w*|srfm_entries|nf3_\w*|edd_customers|edd_orders|edd_order_addresses|affiliate_wp_\w*|cartflows_ca_\w*|simple_history\w*|gf_entry\w*)\b/i;

const DENIED =
  'Access to personal data (users, comments, orders, form entries …) is switched off for this workspace. ' +
  'The site owner can allow it in the portal under Einstellungen → Datenschutz. Do not try to work around this.';

/** Returns an error message if the call would read data that is mainly personal data. */
export function personalDataDenied(tool: string, a: Record<string, any>, wsId = ctx().workspaceId): string | undefined {
  if (getSettings(wsId).pii.allowPersonalData) return undefined;
  if (tool === 'rest_request' && typeof a.path === 'string' && PII_REST.some((re) => re.test(a.path))) return DENIED;
  if (tool === 'db_query' && typeof a.sql === 'string' && PII_TABLES.test(a.sql)) return DENIED;
  if (tool === 'manage_meta' && (a.object_type === 'user' || a.object_type === 'comment')) return DENIED;
  if ((tool === 'list_content' || tool === 'get_content') && typeof a.type === 'string' && /^(users|comments|orders|shop_order)$/i.test(a.type)) return DENIED;
  return undefined;
}
