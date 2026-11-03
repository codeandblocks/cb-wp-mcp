/**
 * Code & Blocks WordPress MCP – extended tools
 * Author: Code & Blocks by Marijan
 *
 * Post meta (page builders, SEO plugins), database, abilities, cron, mail,
 * draft copies + previews, draft themes, page audit, skills, stock images.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parse, type HTMLElement } from 'node-html-parser';
import { config } from './config.js';
import { getClient } from './wp.js';
import { USER_AGENT } from './net.js';
import type { Handler, ToolOpts } from './tools.js';

type ToolFn = (name: string, opts: ToolOpts, handler: Handler) => void;

const B = '/cbmcp/v1';
const site = z.string().optional().describe('Site id from list_sites. Omit for the default (first) site.');
const objectType = z.enum(['post', 'term', 'user', 'comment']).default('post');

// ---------- JSON / tree helpers ----------

function tryJson(v: unknown): { ok: boolean; value: unknown } {
  if (typeof v !== 'string') return { ok: false, value: v };
  const t = v.trim();
  if (!(t.startsWith('[') || t.startsWith('{'))) return { ok: false, value: v };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false, value: v };
  }
}

function splitPath(p: string): string[] {
  return p
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getAt(root: any, p: string): any {
  let cur = root;
  for (const seg of splitPath(p)) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) throw new Error(`json_path "${p}" not found at "${seg}"`);
    cur = cur[seg];
  }
  return cur;
}

function setAt(root: any, p: string, value: unknown): any {
  const segs = splitPath(p);
  if (segs.length === 0) return value;
  let cur = root;
  for (const seg of segs.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) throw new Error(`json_path "${p}" not found at "${seg}"`);
    cur = cur[seg];
  }
  const last = segs[segs.length - 1];
  if (cur === null || typeof cur !== 'object') throw new Error(`json_path "${p}": parent is not an object/array`);
  cur[last] = value;
  return root;
}

/** Find an element (Elementor, Bricks, Breakdance …) by its "id" field. Returns its path. */
function findById(node: any, id: string, p = ''): string | undefined {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const r = findById(node[i], id, p ? `${p}.${i}` : String(i));
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (node && typeof node === 'object') {
    if (String(node.id ?? '') === id) return p;
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') {
        const r = findById(v, id, p ? `${p}.${k}` : k);
        if (r !== undefined) return r;
      }
    }
  }
  return undefined;
}

function textPreview(settings: any): string | undefined {
  if (!settings || typeof settings !== 'object') return undefined;
  for (const k of ['title', 'heading', 'editor', 'text', 'content', 'description', 'button_text', 'label', 'html', 'tag']) {
    const v = settings[k];
    if (typeof v === 'string' && v.trim()) return v.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
  }
  return undefined;
}

/** Compact outline of a builder element tree: path, id, type, preview text. */
function outline(node: any, p = '', depth = 0, acc: any[] = []): any[] {
  if (acc.length > 2000) return acc;
  if (Array.isArray(node)) {
    node.forEach((n, i) => outline(n, p ? `${p}.${i}` : String(i), depth, acc));
    return acc;
  }
  if (node && typeof node === 'object') {
    const type = node.widgetType ?? node.elType ?? node.name ?? node.type ?? node.data?.type;
    if (type && ('id' in node || 'elType' in node)) {
      acc.push({ path: p, id: node.id, type, depth, text: textPreview(node.settings ?? node.data?.properties?.content?.content) });
    }
    for (const k of ['elements', 'children']) {
      if (Array.isArray(node[k]) && node[k].some((c: unknown) => c && typeof c === 'object')) {
        outline(node[k], p ? `${p}.${k}` : k, depth + 1, acc);
      }
    }
    if (node.root && typeof node.root === 'object') outline(node.root, p ? `${p}.root` : 'root', depth, acc);
  }
  return acc;
}

function flattenQuery(prefix: string, value: unknown, out: string[] = []): string[] {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) value.forEach((v, i) => flattenQuery(`${prefix}[${i}]`, v, out));
  else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) flattenQuery(`${prefix}[${k}]`, v, out);
  else out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  return out;
}

// ---------- skills ----------

interface Skill {
  name: string;
  description: string;
  content: string;
  source: 'built-in' | 'saved';
}

const BUILTIN_SKILLS = config.skillsDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills');
const USER_SKILLS = path.join(config.dataDir, 'skills');

function parseSkill(file: string, source: Skill['source']): Skill | undefined {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    const meta: Record<string, string> = {};
    if (m) for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return {
      name: meta.name || path.basename(file, '.md'),
      description: meta.description || '',
      content: m ? m[2] : raw,
      source,
    };
  } catch {
    return undefined;
  }
}

function loadSkills(): Skill[] {
  const map = new Map<string, Skill>();
  for (const [dir, source] of [[BUILTIN_SKILLS, 'built-in'], [USER_SKILLS, 'saved']] as const) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const s = parseSkill(path.join(dir, f), source);
      if (s) map.set(s.name, s); // saved skills override built-ins with the same name
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function scoreSkill(s: Skill, query: string): number {
  const words = query.toLowerCase().split(/[^a-z0-9äöüß]+/).filter((w) => w.length > 2);
  const hay = `${s.name} ${s.description}`.toLowerCase();
  const body = s.content.toLowerCase();
  return words.reduce((acc, w) => acc + (hay.includes(w) ? 3 : 0) + (body.includes(w) ? 1 : 0), 0);
}

// ---------- page audit ----------

const PLACEHOLDERS: [RegExp, string][] = [
  [/lorem ipsum|dolor sit amet|consectetur adipiscing/i, 'Lorem ipsum'],
  [/add your heading text here/i, 'Elementor default heading'],
  [/click edit button to change this text/i, 'Elementor default text'],
  [/your title goes here|your content goes here/i, 'Divi default text'],
  [/\b(your|add your|insert your) (text|heading|title|content|description) here\b/i, 'Placeholder text'],
  [/\b(ihr|dein|deine|ihre) (text|überschrift|titel|inhalt) (hier|steht hier)\b/i, 'Platzhaltertext'],
  [/\bbutton text\b|\bclick here\b|\bread more\b(?=\s*$)/i, 'Generic button text'],
  [/\bsample page\b|\bhello world!/i, 'WordPress sample content'],
  [/\b[\w.+-]+@example\.(com|org|net)\b|\bexample\.com\b/i, 'example.com address'],
  [/\b(555[-. ]\d{4}|123[-. ]456[-. ]7890|\+?1? ?\(?555\)?[-. ]\d{3}[-. ]\d{4})\b/, 'Dummy phone number'],
  [/\b(john|jane) doe\b|\bmax mustermann\b|\bmusterstra(ss|ß)e\b/i, 'Dummy name/address'],
];

async function auditPage(url: URL) {
  const started = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(45_000) });
  const html = await res.text();
  const ms = Date.now() - started;
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  const attr = (sel: string, a: string) => root.querySelector(sel)?.getAttribute(a)?.trim();
  const isHttps = url.protocol === 'https:';

  const og: Record<string, string> = {};
  for (const m of root.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')) {
    const k = m.getAttribute('property') ?? m.getAttribute('name');
    if (k) og[k] = m.getAttribute('content') ?? '';
  }

  const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6').map((h) => ({
    level: Number(h.tagName.slice(1)),
    text: h.text.replace(/\s+/g, ' ').trim().slice(0, 120),
  }));
  const h1 = headings.filter((h) => h.level === 1);
  const skipped: string[] = [];
  for (let i = 1; i < headings.length; i++) {
    if (headings[i].level > headings[i - 1].level + 1) skipped.push(`h${headings[i - 1].level} → h${headings[i].level} ("${headings[i].text.slice(0, 40)}")`);
  }

  const imgs = root.querySelectorAll('img');
  const missingAlt = imgs
    .filter((i) => {
      const alt = i.getAttribute('alt');
      return alt === undefined || alt.trim() === '';
    })
    .map((i) => i.getAttribute('src') ?? i.getAttribute('data-src') ?? '')
    .filter((s) => s && !s.startsWith('data:'))
    .slice(0, 40);

  const host = url.hostname;
  const dead: { text: string; href: string | undefined }[] = [];
  let internal = 0;
  let external = 0;
  for (const a of root.querySelectorAll('a')) {
    const href = a.getAttribute('href')?.trim();
    const text = (a.text || a.getAttribute('aria-label') || a.querySelector('img')?.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!href || href === '#' || /^javascript:/i.test(href) || /example\.(com|org)/i.test(href)) {
      if (!a.getAttribute('data-toggle') && !a.getAttribute('aria-controls') && !a.getAttribute('role')) dead.push({ text, href });
      continue;
    }
    if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    try {
      new URL(href, url).hostname === host ? internal++ : external++;
    } catch {
      dead.push({ text, href });
    }
  }

  const mixed = isHttps
    ? root
        .querySelectorAll('img[src^="http:"], script[src^="http:"], link[href^="http:"][rel="stylesheet"], iframe[src^="http:"]')
        .map((e) => e.getAttribute('src') ?? e.getAttribute('href'))
        .slice(0, 20)
    : [];

  const body = (root.querySelector('body') as HTMLElement | null) ?? root;
  const text = body.structuredText;
  const placeholders: { type: string; snippet: string }[] = [];
  for (const [re, type] of PLACEHOLDERS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    let n = 0;
    let lastEnd = -1000;
    while ((m = g.exec(text)) && n < 3) {
      if (m.index - lastEnd < 80) continue; // same passage already reported
      lastEnd = m.index + m[0].length;
      placeholders.push({ type, snippet: text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, ' ').trim() });
      n++;
    }
  }

  const robots = attr('meta[name="robots"]', 'content') ?? '';
  const xRobots = res.headers.get('x-robots-tag') ?? '';
  const bodyClass = body.getAttribute?.('class') ?? '';
  const builders = [
    [/elementor/, 'Elementor'],
    [/et_pb|et-db|divi/, 'Divi'],
    [/brxe-|bricks/, 'Bricks'],
    [/fl-builder/, 'Beaver Builder'],
    [/siteorigin-panels/, 'SiteOrigin'],
    [/breakdance/, 'Breakdance'],
    [/seedprod/, 'SeedProd'],
    [/pagelayer/, 'Pagelayer'],
    [/wp-block-|wp-site-blocks/, 'Blocks (Gutenberg)'],
  ]
    .filter(([re]) => (re as RegExp).test(html.slice(0, 400000)))
    .map(([, n]) => n);

  const issues: string[] = [];
  if (res.status >= 400) issues.push(`HTTP status ${res.status}`);
  if (!root.querySelector('title')?.text.trim()) issues.push('Missing <title>');
  if (!attr('meta[name="description"]', 'content')) issues.push('Missing meta description');
  if (h1.length === 0) issues.push('No H1');
  if (h1.length > 1) issues.push(`${h1.length} H1 headings`);
  if (skipped.length) issues.push(`${skipped.length} skipped heading level(s)`);
  if (missingAlt.length) issues.push(`${missingAlt.length} image(s) without alt text`);
  if (dead.length) issues.push(`${dead.length} dead/placeholder link(s)`);
  if (placeholders.length) issues.push(`${placeholders.length} placeholder text hit(s)`);
  if (mixed.length) issues.push(`${mixed.length} insecure http:// resource(s)`);
  if (/noindex/i.test(robots + xRobots)) issues.push('Page is set to noindex');
  if (!og['og:image']) issues.push('No og:image (social share preview)');

  return {
    url: res.url,
    status: res.status,
    response_ms: ms,
    html_kb: Math.round(html.length / 1024),
    issues,
    seo: {
      title: root.querySelector('title')?.text.trim(),
      description: attr('meta[name="description"]', 'content'),
      robots: robots || undefined,
      x_robots_tag: xRobots || undefined,
      canonical: attr('link[rel="canonical"]', 'href'),
      lang: root.querySelector('html')?.getAttribute('lang'),
      social: og,
    },
    headings: { h1: h1.map((h) => h.text), skipped_levels: skipped, outline: headings.slice(0, 60) },
    images: { total: imgs.length, missing_alt: missingAlt },
    links: { internal, external, dead: dead.slice(0, 40) },
    placeholders: placeholders.slice(0, 40),
    mixed_content: mixed,
    forms: root.querySelectorAll('form').length,
    builders,
    body_class: bodyClass.slice(0, 300) || undefined,
  };
}

// ---------- images ----------

export async function trackUnsplashDownload(location: string): Promise<void> {
  const u = new URL(location);
  if (u.hostname !== 'api.unsplash.com' || !config.unsplashAccessKey) return;
  try {
    await fetch(u, { headers: { Authorization: `Client-ID ${config.unsplashAccessKey}`, 'Accept-Version': 'v1' }, signal: AbortSignal.timeout(15_000) });
  } catch {
    /* tracking is best effort */
  }
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'image'
  );
}

async function searchPexels(q: { query: string; orientation?: string; per_page: number; page: number; locale?: string }) {
  if (!config.pexelsApiKey) throw new Error('PEXELS_API_KEY is not set');
  const u = new URL('https://api.pexels.com/v1/search');
  u.searchParams.set('query', q.query);
  u.searchParams.set('per_page', String(q.per_page));
  u.searchParams.set('page', String(q.page));
  if (q.orientation) u.searchParams.set('orientation', q.orientation);
  if (q.locale) u.searchParams.set('locale', q.locale);
  const res = await fetch(u, { headers: { Authorization: config.pexelsApiKey, 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Pexels: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return (data.photos ?? []).map((p: any) => ({
    source: 'pexels',
    id: p.id,
    description: p.alt || undefined,
    width: p.width,
    height: p.height,
    photographer: p.photographer,
    photographer_url: p.photographer_url,
    page_url: p.url,
    preview_url: p.src?.medium,
    upload_media_args: {
      source_url: p.src?.large2x ?? p.src?.original,
      filename: `${slugify(p.alt || q.query)}-pexels-${p.id}.jpg`,
      alt_text: p.alt || undefined,
      caption: `Photo by <a href="${p.photographer_url}">${p.photographer}</a> on <a href="${p.url}">Pexels</a>`,
    },
  }));
}

async function searchUnsplash(q: { query: string; orientation?: string; per_page: number; page: number }) {
  if (!config.unsplashAccessKey) throw new Error('UNSPLASH_ACCESS_KEY is not set');
  const u = new URL('https://api.unsplash.com/search/photos');
  u.searchParams.set('query', q.query);
  u.searchParams.set('per_page', String(Math.min(30, q.per_page)));
  u.searchParams.set('page', String(q.page));
  u.searchParams.set('content_filter', 'high');
  if (q.orientation) u.searchParams.set('orientation', q.orientation === 'square' ? 'squarish' : q.orientation);
  const res = await fetch(u, {
    headers: { Authorization: `Client-ID ${config.unsplashAccessKey}`, 'Accept-Version': 'v1', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Unsplash: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  const ref = 'utm_source=code_blocks_wp_mcp&utm_medium=referral';
  return (data.results ?? []).map((p: any) => ({
    source: 'unsplash',
    id: p.id,
    description: p.alt_description || p.description || undefined,
    width: p.width,
    height: p.height,
    photographer: p.user?.name,
    photographer_url: p.user?.links?.html ? `${p.user.links.html}?${ref}` : undefined,
    page_url: p.links?.html ? `${p.links.html}?${ref}` : undefined,
    preview_url: p.urls?.small,
    upload_media_args: {
      source_url: p.urls?.raw ? `${p.urls.raw}&w=2000&q=80&fm=jpg` : p.urls?.full,
      filename: `${slugify(p.alt_description || q.query)}-unsplash-${p.id}.jpg`,
      alt_text: p.alt_description || undefined,
      caption: `Photo by <a href="${p.user?.links?.html}?${ref}">${p.user?.name}</a> on <a href="https://unsplash.com/?${ref}">Unsplash</a>`,
      unsplash_download_location: p.links?.download_location,
    },
  }));
}

// ---------- registration ----------

export function registerExtraTools(tool: ToolFn) {
  // ===== Post meta =====
  tool(
    'manage_meta',
    {
      title: 'Post/term/user meta',
      description:
        '[Bridge] Read and write meta including protected "_" keys (page builders like _elementor_data, panels_data, _bricks_page_content_2; SEO plugins like _yoast_wpseo_metadesc, rank_math_description; ACF fields). ' +
        'get: all meta or keys/prefix; JSON strings are decoded (listed in json_decoded_keys). For big builder data use outline=true, find_id or json_path instead of loading everything. ' +
        'set: whole value, or a part via json_path / find_id (the stored format, JSON string or array, is kept). Every change is backed up (action=backups / restore).',
      input: {
        site,
        action: z.enum(['get', 'set', 'delete', 'backups', 'restore']).default('get'),
        object_type: objectType,
        object_id: z.number().int(),
        keys: z.array(z.string()).optional().describe('get: only these keys'),
        prefix: z.string().optional().describe('get: only keys starting with this, e.g. "_yoast_wpseo_"'),
        keys_only: z.boolean().default(false).describe('get: only key names with value type and size'),
        key: z.string().optional().describe('The meta key for outline/find_id/json_path, set, delete, backups, restore'),
        outline: z.boolean().default(false).describe('get + key: compact element outline (path, id, type, text) of a builder tree'),
        find_id: z.string().optional().describe('get/set + key: element id inside the tree (Elementor/Bricks/Breakdance)'),
        json_path: z.string().optional().describe('get/set + key: dot path inside the value, e.g. "0.elements.1.settings.title"'),
        value: z.any().optional().describe('set: new value (or new sub-value with json_path/find_id)'),
        encode_json: z.boolean().optional().describe('set without path: store value as JSON string (needed for _elementor_data and other json_decoded_keys)'),
        backup: z.string().optional().describe('restore: backup name, default latest'),
      },
      write: true,
      mixed: true,
      destructive: true,
    },
    async (a) => {
      const wp = getClient(a.site);
      const target = { object_type: a.object_type, object_id: a.object_id };
      const needKey = () => {
        if (!a.key) throw new Error('key is required for this action');
        return a.key as string;
      };
      const readOne = async (key: string) => {
        const r = (await wp.post(`${B}/meta/get`, { ...target, keys: [key] })).data as { meta: Record<string, unknown> };
        if (!(key in r.meta)) throw new Error(`Meta key "${key}" does not exist on ${a.object_type} #${a.object_id}`);
        const raw = r.meta[key];
        const j = tryJson(raw);
        return { raw, value: j.value, isJson: j.ok };
      };

      if (a.action === 'get') {
        if (a.key && (a.outline || a.find_id || a.json_path)) {
          const { value, isJson } = await readOne(a.key);
          if (a.outline) return { key: a.key, stored_as: isJson ? 'json' : typeof value, outline: outline(value) };
          const p = a.find_id ? findById(value, a.find_id) : a.json_path!;
          if (p === undefined) throw new Error(`Element id "${a.find_id}" not found`);
          return { key: a.key, json_path: p, value: p === '' ? value : getAt(value, p) };
        }
        const r = (await wp.post(`${B}/meta/get`, { ...target, keys: a.key ? [a.key] : a.keys, prefix: a.prefix })).data as { meta: Record<string, unknown>; count: number };
        const meta: Record<string, unknown> = {};
        const jsonKeys: string[] = [];
        for (const [k, v] of Object.entries(r.meta ?? {})) {
          if (a.keys_only) {
            const size = typeof v === 'string' ? v.length : JSON.stringify(v ?? null).length;
            meta[k] = { type: Array.isArray(v) ? 'array' : typeof v, size };
            continue;
          }
          const j = tryJson(v);
          if (j.ok) jsonKeys.push(k);
          meta[k] = j.value;
        }
        return { object_type: a.object_type, object_id: a.object_id, count: r.count, json_decoded_keys: jsonKeys, meta };
      }

      if (a.action === 'backups') return (await wp.post(`${B}/meta/backups`, { ...target, key: needKey() })).data;
      if (config.readOnly) throw new Error('Server is in READ_ONLY mode');
      if (a.action === 'restore') return (await wp.post(`${B}/meta/restore`, { ...target, key: needKey(), backup: a.backup })).data;
      if (a.action === 'delete') return (await wp.post(`${B}/meta/delete`, { ...target, key: needKey() })).data;

      // set
      const key = needKey();
      if (a.value === undefined) throw new Error('value is required for set');
      let toStore: unknown = a.value;
      if (a.find_id || a.json_path) {
        const cur = await readOne(key);
        const p = a.find_id ? findById(cur.value, a.find_id) : a.json_path!;
        if (p === undefined) throw new Error(`Element id "${a.find_id}" not found`);
        const updated = setAt(structuredClone(cur.value), p, a.value);
        toStore = cur.isJson ? JSON.stringify(updated) : updated;
      } else if (a.encode_json && typeof a.value !== 'string') {
        toStore = JSON.stringify(a.value);
      }
      return (await wp.post(`${B}/meta/set`, { ...target, key, value: toStore })).data;
    },
  );

  // ===== Database =====
  tool(
    'db_schema',
    {
      title: 'Database tables',
      description: '[Bridge] List database tables (filter with like, e.g. "fluentform") or show the columns of one table. Use before db_query to learn plugin tables.',
      input: { site, like: z.string().optional(), table: z.string().optional().describe('Table name, {prefix} is replaced, e.g. {prefix}fluentform_submissions') },
    },
    async (a) => (await getClient(a.site).get(`${B}/db/schema`, { like: a.like, table: a.table })).data,
  );

  tool(
    'db_query',
    {
      title: 'Database query',
      description:
        '[Bridge] Run one SQL statement. {prefix} is replaced with the table prefix (e.g. SELECT * FROM {prefix}fluentform_submissions WHERE status = "unread" LIMIT 50). ' +
        'SELECT/SHOW/DESCRIBE/EXPLAIN always work (LIMIT added automatically). INSERT/UPDATE/DELETE/REPLACE need allow_write=true and the site owner must enable CBMCP_ALLOW_DB_WRITE in wp-config.php. No schema changes. Prefer REST APIs/abilities for writes.',
      input: {
        site,
        sql: z.string().min(6),
        max_rows: z.number().int().min(1).max(2000).default(200),
        allow_write: z.boolean().default(false),
      },
      mixed: true,
      destructive: true,
    },
    async (a) => {
      if (config.readOnly && a.allow_write) throw new Error('Server is in READ_ONLY mode');
      return (await getClient(a.site).post(`${B}/db/query`, { sql: a.sql, max_rows: a.max_rows, allow_write: a.allow_write })).data;
    },
  );

  // ===== Abilities API (WordPress 6.9+) =====
  tool(
    'list_abilities',
    {
      title: 'List abilities',
      description: 'List abilities that WordPress core and plugins expose via the Abilities API (WordPress 6.9+), with input schema and whether they are read-only or destructive.',
      input: { site, category: z.string().optional(), search: z.string().optional(), page: z.number().int().min(1).default(1) },
    },
    async (a) => {
      const wp = getClient(a.site);
      const res = await wp.get('/wp-abilities/v1/abilities', { per_page: 100, page: a.page, category: a.category });
      let items = (res.data as any[]).map((x) => ({
        name: x.name,
        label: x.label,
        description: x.description,
        category: x.category,
        readonly: Boolean(x.meta?.annotations?.readonly),
        destructive: Boolean(x.meta?.annotations?.destructive),
        instructions: x.meta?.annotations?.instructions || undefined,
        input_schema: x.input_schema,
      }));
      if (a.search) {
        const s = a.search.toLowerCase();
        items = items.filter((x) => `${x.name} ${x.label} ${x.description}`.toLowerCase().includes(s));
      }
      return { total: res.total, total_pages: res.totalPages, abilities: items };
    },
  );

  tool(
    'run_ability',
    {
      title: 'Run ability',
      description: 'Execute an ability by name (e.g. "core/get-site-info") with input matching its input_schema from list_abilities. The correct HTTP method is chosen from the ability annotations.',
      input: { site, name: z.string().regex(/^[a-z0-9-]+\/[a-z0-9\-/]+$/i), input: z.any().optional() },
      mixed: true,
      destructive: true,
    },
    async (a) => {
      const wp = getClient(a.site);
      const info = (await wp.get(`/wp-abilities/v1/abilities/${a.name}`)).data as any;
      const ann = info?.meta?.annotations ?? {};
      const method = ann.readonly ? 'GET' : ann.destructive && ann.idempotent ? 'DELETE' : 'POST';
      if (config.readOnly && method !== 'GET') throw new Error('Server is in READ_ONLY mode – only read-only abilities can run');
      const route = `/wp-abilities/v1/abilities/${a.name}/run`;
      const res =
        method === 'POST'
          ? await wp.request('POST', route, { body: a.input === undefined ? {} : { input: a.input } })
          : await wp.request(method, route, { rawQuery: flattenQuery('input', a.input).join('&') || undefined });
      return { ability: a.name, method, result: res.data };
    },
  );

  // ===== Cron =====
  tool(
    'manage_cron',
    {
      title: 'Scheduled tasks (cron)',
      description: '[Bridge] WP-Cron: list events (late ones, missing callbacks), run an event hook now, pause (unschedule but remember) or resume it.',
      input: {
        site,
        action: z.enum(['list', 'run', 'pause', 'resume']).default('list'),
        search: z.string().optional().describe('list: filter hooks'),
        hook: z.string().optional(),
        args: z.array(z.any()).optional().describe('Event arguments exactly as shown in list'),
        timestamp: z.number().int().optional().describe('pause: specific occurrence'),
      },
      mixed: true,
      destructive: true,
    },
    async (a) => {
      const wp = getClient(a.site);
      if (a.action === 'list') return (await wp.get(`${B}/cron/list`, { search: a.search })).data;
      if (config.readOnly) throw new Error('Server is in READ_ONLY mode');
      if (!a.hook) throw new Error('hook is required');
      return (await wp.post(`${B}/cron/${a.action}`, { hook: a.hook, args: a.args ?? [], timestamp: a.timestamp })).data;
    },
  );

  // ===== Mail =====
  tool(
    'send_test_email',
    {
      title: 'Send test email',
      description: '[Bridge] Send a test email through wp_mail() and report errors, the effective From address/name and detected mail/SMTP plugins. Only send to an address the user gave.',
      input: { site, to: z.string().email(), subject: z.string().optional(), message: z.string().optional() },
      write: true,
    },
    async (a) => (await getClient(a.site).post(`${B}/mail/test`, { to: a.to, subject: a.subject, message: a.message })).data,
  );

  // ===== Draft copies & previews =====
  tool(
    'duplicate_content',
    {
      title: 'Duplicate as draft',
      description: '[Bridge] Copy a post/page (content, all meta incl. page-builder data, terms) to a new draft and return a preview_url that works without login. Use this to test changes before touching the live page.',
      input: { site, id: z.number().int(), title: z.string().optional(), status: z.enum(['draft', 'pending', 'private']).default('draft') },
      write: true,
    },
    async (a) => (await getClient(a.site).post(`${B}/posts/duplicate`, { id: a.id, title: a.title, status: a.status })).data,
  );

  tool(
    'apply_copy',
    {
      title: 'Apply draft copy to original',
      description: '[Bridge] Replace content and meta of the original (target_id) with the reviewed copy (copy_id). A backup draft of the original is created first; the copy is deleted unless keep_copy. Changes the live page – only after the user approved.',
      input: {
        site,
        copy_id: z.number().int(),
        target_id: z.number().int(),
        copy_title: z.boolean().default(false).describe('Also take over the title of the copy'),
        keep_copy: z.boolean().default(false),
        backup: z.boolean().default(true),
      },
      write: true,
      destructive: true,
    },
    async (a) =>
      (
        await getClient(a.site).post(`${B}/posts/apply`, {
          source_id: a.copy_id,
          target_id: a.target_id,
          copy_title: a.copy_title,
          keep_source: a.keep_copy,
          backup: a.backup,
        })
      ).data,
  );

  tool(
    'create_preview',
    {
      title: 'Create preview link',
      description: '[Bridge] Create a time-limited link that shows a draft/unpublished post and/or a not-yet-active theme without login. Share it with the user for review; works with fetch_page and audit_page.',
      input: {
        site,
        post_id: z.number().int().optional(),
        theme: z.string().optional().describe('Theme stylesheet to preview'),
        minutes: z.number().int().min(5).max(10080).default(120),
      },
      write: true,
    },
    async (a) => (await getClient(a.site).post(`${B}/preview/create`, { post_id: a.post_id, theme: a.theme, minutes: a.minutes })).data,
  );

  // ===== Draft themes =====
  tool(
    'copy_theme',
    {
      title: 'Copy theme as draft',
      description: '[Bridge] Copy an installed theme to a new, inactive theme folder (a draft) and return a preview_url. Edit it with the file tools, activate only on request.',
      input: { site, from: z.string().describe('Source stylesheet'), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/), name: z.string().optional() },
      write: true,
    },
    async (a) => (await getClient(a.site).post(`${B}/theme/copy`, { from: a.from, slug: a.slug, name: a.name })).data,
  );

  tool(
    'create_child_theme',
    {
      title: 'Create child theme',
      description: '[Bridge] Create a child theme of an installed parent (classic or block theme) with style.css and functions.php, inactive, with a preview_url. Use for lasting customisations instead of editing the parent.',
      input: { site, parent: z.string(), slug: z.string().optional(), name: z.string().optional(), author: z.string().optional() },
      write: true,
    },
    async (a) => (await getClient(a.site).post(`${B}/theme/child`, { parent: a.parent, slug: a.slug, name: a.name, author: a.author })).data,
  );

  // ===== Audit =====
  tool(
    'audit_page',
    {
      title: 'Audit page',
      description:
        'Check a front-end page (also preview URLs): title, meta description, robots/noindex, canonical, social tags, H1 count and heading order, images without alt text, dead or placeholder links, leftover template text (Lorem ipsum, builder defaults, example.com, dummy phone numbers), insecure resources, detected page builder. Read-only.',
      input: { site, path: z.string().default('/').describe('Path or full URL on the site') },
    },
    async (a) => {
      const wp = getClient(a.site);
      const url = new URL(a.path, `${wp.site.url}/`);
      if (url.hostname !== wp.host) throw new Error(`Only URLs on ${wp.host} are allowed`);
      if (!url.searchParams.has('cbmcp_preview')) url.searchParams.set('cbmcp_nocache', Date.now().toString(36));
      return auditPage(url);
    },
  );

  // ===== Skills =====
  tool(
    'skill_list',
    { title: 'List skills', description: 'List reference guides (built-in and saved) for WordPress tasks such as page builders, SEO plugins, plugin data, WooCommerce.', input: {} },
    async () => ({ skills: loadSkills().map((s) => ({ name: s.name, description: s.description, source: s.source })) }),
  );

  tool(
    'skill_load',
    {
      title: 'Load skill',
      description: 'Load a reference guide by name, or the best match for a task description (query).',
      input: { name: z.string().optional(), query: z.string().optional() },
    },
    async (a) => {
      const all = loadSkills();
      if (a.name) {
        const s = all.find((x) => x.name === a.name);
        if (!s) throw new Error(`Unknown skill "${a.name}". Available: ${all.map((x) => x.name).join(', ')}`);
        return `# ${s.name} (${s.source})\n\n${s.content}`;
      }
      if (!a.query) throw new Error('name or query is required');
      const ranked = all.map((s) => ({ s, score: scoreSkill(s, a.query!) })).filter((x) => x.score > 0).sort((x, y) => y.score - x.score);
      if (!ranked.length) return `No matching skill. Available: ${all.map((x) => x.name).join(', ')}`;
      const best = ranked[0].s;
      const others = ranked.slice(1, 4).map((x) => x.s.name);
      return `# ${best.name} (${best.source})\n${others.length ? `Other matches: ${others.join(', ')}\n` : ''}\n${best.content}`;
    },
  );

  tool(
    'skill_save',
    {
      title: 'Save skill',
      description: 'Save a reusable workflow, site convention or preference as a skill (Markdown) so future conversations can load it. Overrides a built-in skill with the same name. Ask the user before saving.',
      input: {
        name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
        description: z.string().min(5).max(300),
        content: z.string().min(10).max(100_000),
      },
      write: true,
    },
    async (a) => {
      fs.mkdirSync(USER_SKILLS, { recursive: true });
      const desc = a.description.replace(/\s+/g, ' ');
      fs.writeFileSync(path.join(USER_SKILLS, `${a.name}.md`), `---\nname: ${a.name}\ndescription: ${desc}\n---\n${a.content.trim()}\n`);
      return { saved: a.name, location: 'saved' };
    },
  );

  tool(
    'skill_delete',
    { title: 'Delete skill', description: 'Delete a saved skill (built-in skills cannot be deleted).', input: { name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/) }, write: true, destructive: true },
    async (a) => {
      const f = path.join(USER_SKILLS, `${a.name}.md`);
      if (!fs.existsSync(f)) throw new Error(`No saved skill "${a.name}"`);
      fs.unlinkSync(f);
      return { deleted: a.name };
    },
  );

  // ===== Stock images =====
  tool(
    'search_images',
    {
      title: 'Search stock images',
      description:
        'Search free stock photos on Pexels and/or Unsplash. Each result has upload_media_args to pass to upload_media (includes attribution caption and, for Unsplash, the required download tracking). Show the user preview_url before uploading when the choice matters.',
      input: {
        query: z.string().min(2).describe('Search terms, English works best'),
        source: z.enum(['auto', 'pexels', 'unsplash', 'both']).default('auto'),
        orientation: z.enum(['landscape', 'portrait', 'square']).optional(),
        per_page: z.number().int().min(1).max(30).default(8),
        page: z.number().int().min(1).default(1),
        locale: z.string().optional().describe('Pexels search locale, e.g. de-DE'),
      },
    },
    async (a) => {
      const hasP = Boolean(config.pexelsApiKey);
      const hasU = Boolean(config.unsplashAccessKey);
      if (!hasP && !hasU) {
        throw new Error('No image API key configured. Set PEXELS_API_KEY (https://www.pexels.com/api/) and/or UNSPLASH_ACCESS_KEY (https://unsplash.com/oauth/applications) in the server environment.');
      }
      const want = a.source === 'auto' ? (hasP ? ['pexels'] : ['unsplash']) : a.source === 'both' ? ['pexels', 'unsplash'] : [a.source];
      const results: any[] = [];
      const errors: string[] = [];
      for (const src of want) {
        try {
          results.push(...(src === 'pexels' ? await searchPexels(a) : await searchUnsplash(a)));
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      if (!results.length && errors.length) throw new Error(errors.join('; '));
      return {
        count: results.length,
        results,
        errors: errors.length ? errors : undefined,
        attribution: 'Credit the photographer and Pexels/Unsplash (the caption in upload_media_args does this).',
      };
    },
  );
}
