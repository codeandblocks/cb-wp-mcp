/**
 * Code & Blocks WordPress MCP – tool definitions
 * Author: Code & Blocks by Marijan
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { APP_NAME, APP_VERSION, config } from './config.js';
import { allSiteHosts, currentSites, getClient, WPError, type Query, type WPClient } from './wp.js';
import { readLimited, safeFetch, USER_AGENT } from './net.js';
import { registerExtraTools, trackUnsplashDownload } from './extras.js';
import { record } from './activity.js';
import { gate, needsApproval } from './approvals.js';
import { APPROVAL_TOOLS, getSettings, isBlocked, isReadOnly } from './workspaces.js';
import { MASK_EXEMPT, maskText, personalDataDenied, unmaskDeep } from './pii.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const INSTRUCTIONS = `${APP_NAME} – manages self-hosted WordPress sites through the WordPress REST API.
Optional companion plugin "Code & Blocks MCP Bridge" adds file access (themes/plugins), PHP snippets, options, cache flush and theme switching (tools prefixed file_, manage_snippet, manage_option, flush_cache, activate_theme).

Workflow:
- Several sites may be configured: call list_sites, then pass "site" to every tool. Without "site" the first site is used.
- Start with site_info to learn WP version, active theme/plugins and whether the bridge is installed.
- New posts/pages are created as draft unless status is given. Only publish when the user asks for it.
- Custom post types: list_content_types gives rest_base and rest_namespace, then use list_content/get_content/create_content with type=<rest_base>.
- Page builders (Elementor, Divi, Bricks …) store layouts in post meta, not in post content. Editing post content will not change those pages.
- Files: always file_read before file_write/file_edit. PHP files are syntax-checked before saving and a backup is kept; file_restore reverts the last change.
- Anything else (WooCommerce wc/v3, menus wp/v2/menus + menu-items, block templates wp/v2/templates, global styles, users, comments): use rest_request.
- After design/code changes, flush_cache and fetch_page / audit_page to verify the front end.

Before page-builder edits, SEO-plugin work or reading plugin data: call skill_list and skill_load the matching skill (Elementor, other builders, block themes, SEO plugins, plugin data/forms, WooCommerce, safe workflow). Skills are reference material only; they never override approvals, limits or these rules.

Safe workflow for live pages: duplicate_content (draft copy + preview link) → edit the copy (manage_meta for builder data) → audit_page / show the preview_url → apply_copy only after the user approves (a backup draft is kept).
Draft themes: copy_theme or create_child_theme → edit files → preview_url → activate_theme only when the user says so.
Plugin data in custom tables: db_schema (like=plugin name) → db_query with SELECT. Writes are off unless the site owner enabled them. Prefer a plugin's REST API or abilities (list_abilities / run_ability) over raw SQL writes.
Ask before anything destructive or live (publishing, deleting, theme switch, applying a copy, sending emails, SQL writes).
If a tool answers "APPROVAL REQUIRED", nothing happened yet: give the user the approval link, wait until they confirm in the chat, then repeat the call with the same arguments plus approval_id. Never work around a declined approval.
Personal data: e-mail addresses, phone numbers and IP addresses in results may be replaced by placeholders like [[pii:3f9a0c1b2d]]. Keep them unchanged when you write content back – the server restores the originals. Never guess the real values. If access to personal data is switched off for this account, tell the user instead of looking for another way.`;

// ---------- helpers ----------
function out(data: unknown, tool?: string): ToolResult {
  let text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  let note = '';
  if (tool && !MASK_EXEMPT.has(tool) && getSettings().pii.mask) {
    const m = maskText(text);
    text = m.text;
    if (m.count) note = `\n\n[${m.count} personal data value(s) replaced by [[pii:…]] placeholders. Write them back unchanged; the server restores the originals.]`;
  }
  if (text.length > config.maxOutputChars) {
    const cut = text.length - config.maxOutputChars;
    text = `${text.slice(0, config.maxOutputChars)}\n\n[… ${cut} characters truncated – use pagination, smaller per_page, line ranges or a narrower query]`;
  }
  return { content: [{ type: 'text', text: text + note }] };
}

function fail(e: unknown, bridge = false): ToolResult {
  let msg: string;
  if (e instanceof WPError) {
    msg = `WordPress error ${e.status} (${e.code}): ${e.message}`;
    if (bridge && e.code === 'rest_no_route') {
      msg += '\nThe "Code & Blocks MCP Bridge" plugin is not installed/active on this site. Install it from wordpress-plugin/ in the server repository.';
    }
  } else if (e instanceof Error) {
    msg = e.message;
  } else {
    msg = String(e);
  }
  return { content: [{ type: 'text', text: msg }], isError: true };
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'", '&#8217;': '’', '&#8216;': '‘', '&#8220;': '“', '&#8221;': '”', '&#8211;': '–', '&#8212;': '—', '&nbsp;': ' ', '&hellip;': '…', '&#8230;': '…' };
function decode(s: string): string {
  return s.replace(/&[#\w]+;/g, (m) => ENTITIES[m] ?? m);
}
function plain(html: unknown): string {
  return decode(String(html ?? '').replace(/<[^>]*>/g, '')).trim();
}

/** Turn {raw, rendered} objects into raw strings and drop REST noise. */
function clean(obj: any, includeRendered = false): any {
  if (Array.isArray(obj)) return obj.map((x) => clean(x, includeRendered));
  if (!obj || typeof obj !== 'object') return obj;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_links' || k === '_embedded' || k === 'guid') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && ('raw' in v || 'rendered' in v)) {
      const rv = v as { raw?: unknown; rendered?: unknown };
      if (rv.raw !== undefined) result[k] = rv.raw;
      else result[k] = typeof rv.rendered === 'string' && !includeRendered ? plain(rv.rendered) : rv.rendered;
      if (includeRendered && rv.raw !== undefined && rv.rendered !== undefined) result[`${k}_rendered`] = rv.rendered;
      continue;
    }
    result[k] = clean(v, includeRendered);
  }
  return result;
}

function ns(namespace?: string): string {
  return `/${(namespace ?? 'wp/v2').replace(/^\/+|\/+$/g, '')}`;
}

function segment(v: string, label: string): string {
  if (!/^[\w.\-]+$/.test(v)) throw new Error(`Invalid ${label} "${v}"`);
  return v;
}

const site = z.string().optional().describe('Site id from list_sites. Omit for the default (first) site.');
const typeParam = z
  .string()
  .default('posts')
  .describe('REST base of the content type: posts, pages, media, or a custom post type rest_base (see list_content_types).');
const namespaceParam = z.string().optional().describe('REST namespace of the type, default wp/v2.');

function pickTheme(t: any) {
  if (!t) return t;
  const { stylesheet, template, name, version, is_block_theme, author, requires_php } = t;
  return { stylesheet, template, name, version, is_block_theme, author, requires_php };
}

// ---------- activity helpers ----------
function isWriteCall(opts: ToolOpts, a: Record<string, any>): boolean {
  if (!opts.write && !opts.mixed) return false;
  if (!opts.mixed) return true;
  if (typeof a.method === 'string') return a.method.toUpperCase() !== 'GET';
  if ('allow_write' in a) return Boolean(a.allow_write);
  if (typeof a.action === 'string') return !['get', 'list', 'backups', 'check'].includes(a.action);
  return true;
}

function describeCall(title: string, a: Record<string, any>): string {
  const parts: string[] = [];
  const pick = (k: string, label = '') => {
    const v = a[k];
    if (v === undefined || v === null || v === '' || typeof v === 'object') return;
    parts.push(`${label}${String(v).slice(0, 80)}`);
  };
  pick('action');
  pick('type');
  for (const k of ['id', 'object_id', 'target_id', 'copy_id', 'post_id']) pick(k, '#');
  // Data minimisation: no recipients, no SQL values, no content in the activity log.
  for (const k of ['path', 'key', 'name', 'plugin', 'slug', 'stylesheet', 'theme', 'hook', 'taxonomy', 'method']) pick(k);
  if (typeof a.title === 'string') parts.push(`"${a.title.slice(0, 60)}"`);
  if (typeof a.sql === 'string') parts.push(`SQL ${(a.sql.trim().split(/\s+/)[0] ?? '').toUpperCase().slice(0, 10)}`);
  return parts.length ? `${title}: ${parts.join(' · ')}` : title;
}

function resultRef(r: unknown): { id?: number; title?: string; link?: string; edit?: string } {
  if (!r || typeof r !== 'object') return {};
  const o = r as Record<string, any>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return {
    id: typeof o.id === 'number' ? o.id : typeof o.applied_to === 'number' ? o.applied_to : undefined,
    title: str(o.title)?.slice(0, 80),
    link: str(o.link) ?? str(o.url) ?? str(o.preview_url),
    edit: str(o.edit_url),
  };
}

// ---------- registration ----------
export type Handler = (args: any) => Promise<unknown>;
export interface ToolOpts {
  title: string;
  description: string;
  input: z.ZodRawShape;
  write?: boolean;
  /** Has read and write actions: always registered, write actions check READ_ONLY themselves. */
  mixed?: boolean;
  destructive?: boolean;
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'cb-wp-mcp', version: APP_VERSION }, { instructions: INSTRUCTIONS });

  const tool = (name: string, opts: ToolOpts, handler: Handler) => {
    if (isBlocked(name)) return; // blocked for this workspace by the operator
    if (isReadOnly() && opts.write && !opts.mixed) return;
    const input = name in APPROVAL_TOOLS
      ? { ...opts.input, approval_id: z.string().optional().describe('Only after the user approved: the approval id from the approval message') }
      : opts.input;
    server.registerTool(
      name,
      {
        title: opts.title,
        description: opts.description,
        inputSchema: input,
        annotations: {
          title: opts.title,
          readOnlyHint: !opts.write && !opts.mixed,
          destructiveHint: Boolean(opts.destructive),
          openWorldHint: true,
        },
      },
      async (args: any) => {
        const started = Date.now();
        let a: Record<string, any> = args ?? {};
        const siteId: string | undefined = typeof a.site === 'string' ? a.site : currentSites()[0]?.id;
        const isWrite = isWriteCall(opts, a);
        const summary = describeCall(opts.title, a);
        try {
          const denied = personalDataDenied(name, a);
          if (denied) return out(denied);
          a = unmaskDeep(a);
          if (isWrite && needsApproval(name, a)) {
            const g = await gate(name, siteId, a, summary);
            if (!g.proceed) return out(g.message);
          }
          const result = await handler(a);
          console.log(`[tool] ${name} site=${siteId ?? '-'} ok ${Date.now() - started}ms`);
          if (isWrite && !(typeof result === 'string' && result.startsWith('APPROVAL REQUIRED'))) {
            const ref = resultRef(result);
            record({ site: siteId, tool: name, kind: 'change', status: 'ok', summary: ref.title ? `${summary} – ${ref.title}` : summary, source: 'mcp', ms: Date.now() - started, link: ref.link, edit_link: ref.edit, object_id: ref.id });
          }
          return out(result, name);
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          console.log(`[tool] ${name} site=${siteId ?? '-'} error ${Date.now() - started}ms`);
          if (isWrite) record({ site: siteId, tool: name, kind: 'change', status: 'error', summary: `${summary} – Fehler`, source: 'mcp', ms: Date.now() - started });
          const r = fail(e, opts.description.startsWith('[Bridge]'));
          if (!MASK_EXEMPT.has(name) && getSettings().pii.mask) r.content[0].text = maskText(r.content[0].text).text;
          void msg;
          return r;
        }
      },
    );
  };

  // ===== Sites =====
  tool(
    'list_sites',
    { title: 'List sites', description: 'List the WordPress sites this server is configured for.', input: {} },
    async () => ({
      sites: currentSites().map((s, i) => ({ id: s.id, url: s.url, default: i === 0 })),
      hint: currentSites().length ? undefined : 'No site connected yet. Ask the user to connect a site with the Code & Blocks MCP Bridge plugin (Code & Blocks MCP → Verbindung).',
      read_only: isReadOnly(),
    }),
  );

  tool(
    'site_info',
    {
      title: 'Site info',
      description: 'Overview of a site: name, URL, WordPress/PHP version (with bridge), active theme, active plugins, REST namespaces.',
      input: { site },
    },
    async ({ site: id }) => {
      const wp = getClient(id);
      const [root, theme, plugins, bridge] = await Promise.allSettled([
        wp.get('/', { _fields: 'name,description,url,home,gmt_offset,timezone_string,namespaces' }),
        wp.get('/wp/v2/themes', { status: 'active' }),
        wp.get('/wp/v2/plugins', { status: 'active', _fields: 'plugin,name,version' }),
        wp.get('/cbmcp/v1/info'),
      ]);
      const val = (r: PromiseSettledResult<any>) => (r.status === 'fulfilled' ? r.value.data : { error: (r.reason as Error).message });
      return {
        site: wp.site.id,
        general: val(root),
        active_theme: theme.status === 'fulfilled' ? pickTheme(clean(theme.value.data)[0]) : val(theme),
        active_plugins: val(plugins),
        bridge: bridge.status === 'fulfilled' ? bridge.value.data : 'not installed or not reachable (file/snippet tools unavailable)',
      };
    },
  );

  tool(
    'site_settings',
    {
      title: 'Site settings',
      description: 'Read or update general site settings (title, description/tagline, timezone, date format, show_on_front, page_on_front, page_for_posts, posts_per_page …).',
      input: {
        site,
        action: z.enum(['get', 'update']).default('get'),
        values: z.record(z.string(), z.any()).optional().describe('Settings to change (action=update), e.g. {"title":"…","description":"…"}'),
      },
      mixed: true,
    },
    async ({ site: id, action, values }) => {
      const wp = getClient(id);
      if (action === 'get') return (await wp.get('/wp/v2/settings')).data;
      if (isReadOnly()) throw new Error('Server is in READ_ONLY mode');
      if (!values || Object.keys(values).length === 0) throw new Error('values is required for action=update');
      return (await wp.post('/wp/v2/settings', values)).data;
    },
  );

  // ===== Content =====
  tool(
    'list_content_types',
    {
      title: 'List content types',
      description: 'List post types and taxonomies with their rest_base / rest_namespace (needed for custom post types and custom taxonomies).',
      input: { site },
    },
    async ({ site: id }) => {
      const wp = getClient(id);
      const [types, taxes] = await Promise.all([wp.get('/wp/v2/types'), wp.get('/wp/v2/taxonomies')]);
      return {
        post_types: Object.values(types.data as Record<string, any>).map((t) => ({
          slug: t.slug,
          name: t.name,
          rest_base: t.rest_base,
          rest_namespace: t.rest_namespace,
          hierarchical: t.hierarchical,
          taxonomies: t.taxonomies,
        })),
        taxonomies: Object.values(taxes.data as Record<string, any>).map((t) => ({
          slug: t.slug,
          name: t.name,
          rest_base: t.rest_base,
          rest_namespace: t.rest_namespace,
          types: t.types,
          hierarchical: t.hierarchical,
        })),
      };
    },
  );

  tool(
    'list_content',
    {
      title: 'List posts/pages',
      description: 'List posts, pages or custom post type entries with id, title, status, slug, dates and link. Supports search, status, taxonomy and pagination filters.',
      input: {
        site,
        type: typeParam,
        namespace: namespaceParam,
        search: z.string().optional(),
        status: z.string().optional().describe('publish, draft, pending, private, future, trash or any (comma separated allowed)'),
        per_page: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).default(1),
        orderby: z.string().optional().describe('date, modified, title, id, menu_order, relevance …'),
        order: z.enum(['asc', 'desc']).optional(),
        categories: z.array(z.number().int()).optional(),
        tags: z.array(z.number().int()).optional(),
        author: z.number().int().optional(),
        parent: z.number().int().optional(),
        extra_query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Additional raw query parameters'),
      },
    },
    async (a) => {
      const wp = getClient(a.site);
      const query: Query = {
        context: 'edit',
        search: a.search,
        status: a.status,
        per_page: a.per_page,
        page: a.page,
        orderby: a.orderby,
        order: a.order,
        categories: a.categories,
        tags: a.tags,
        author: a.author,
        parent: a.parent,
        _fields: 'id,type,status,slug,title,date,modified,link,parent,author,menu_order,template',
        ...(a.extra_query ?? {}),
      };
      const res = await wp.get(`${ns(a.namespace)}/${segment(a.type, 'type')}`, query);
      return { total: res.total, total_pages: res.totalPages, page: a.page, items: clean(res.data) };
    },
  );

  tool(
    'get_content',
    {
      title: 'Get post/page',
      description: 'Get one entry with raw (editable) title, content (HTML / block markup), excerpt, meta, template, terms and featured image.',
      input: {
        site,
        type: typeParam,
        namespace: namespaceParam,
        id: z.number().int(),
        include_rendered: z.boolean().default(false).describe('Also return rendered HTML'),
      },
    },
    async (a) => {
      const wp = getClient(a.site);
      const res = await wp.get(`${ns(a.namespace)}/${segment(a.type, 'type')}/${a.id}`, { context: 'edit' });
      return clean(res.data, a.include_rendered);
    },
  );

  const contentFields = {
    title: z.string().optional(),
    content: z.string().optional().describe('Content as HTML or block markup (<!-- wp:paragraph --><p>…</p><!-- /wp:paragraph -->)'),
    excerpt: z.string().optional(),
    status: z.enum(['publish', 'draft', 'pending', 'private', 'future']).optional(),
    slug: z.string().optional(),
    parent: z.number().int().optional(),
    menu_order: z.number().int().optional(),
    author: z.number().int().optional(),
    date: z.string().optional().describe('Publish date (site timezone), ISO 8601'),
    categories: z.array(z.number().int()).optional(),
    tags: z.array(z.number().int()).optional(),
    featured_media: z.number().int().optional().describe('Media id of the featured image (0 removes it)'),
    template: z.string().optional(),
    comment_status: z.enum(['open', 'closed']).optional(),
    meta: z.record(z.string(), z.any()).optional().describe('Registered post meta (show_in_rest) to set'),
    fields: z.record(z.string(), z.any()).optional().describe('Any other REST fields merged into the request body (e.g. acf, custom taxonomies, alt_text for media)'),
  };

  const bodyFrom = (a: Record<string, any>) => {
    const { site: _s, type: _t, namespace: _n, id: _i, fields, ...rest } = a;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
    return { ...body, ...(fields ?? {}) };
  };

  tool(
    'create_content',
    {
      title: 'Create post/page',
      description: 'Create a post, page or custom post type entry. Status defaults to draft.',
      input: { site, type: typeParam, namespace: namespaceParam, ...contentFields },
      write: true,
    },
    async (a) => {
      const wp = getClient(a.site);
      const body = bodyFrom(a);
      if (!body.status) body.status = 'draft';
      const res = await wp.post(`${ns(a.namespace)}/${segment(a.type, 'type')}`, body, { context: 'edit' });
      const d = clean(res.data);
      return { id: d.id, status: d.status, link: d.link, title: d.title, slug: d.slug, edit_url: `${wp.site.url}/wp-admin/post.php?post=${d.id}&action=edit` };
    },
  );

  tool(
    'update_content',
    {
      title: 'Update post/page',
      description: 'Update fields of an existing entry. Only the given fields are changed. Also works for media (type=media: title, caption, alt_text via fields).',
      input: { site, type: typeParam, namespace: namespaceParam, id: z.number().int(), ...contentFields },
      write: true,
    },
    async (a) => {
      const wp = getClient(a.site);
      const body = bodyFrom(a);
      if (Object.keys(body).length === 0) throw new Error('Nothing to update');
      const res = await wp.post(`${ns(a.namespace)}/${segment(a.type, 'type')}/${a.id}`, body, { context: 'edit' });
      const d = clean(res.data);
      return { id: d.id, status: d.status, link: d.link, title: d.title, modified: d.modified, updated_fields: Object.keys(body) };
    },
  );

  tool(
    'delete_content',
    {
      title: 'Delete post/page',
      description: 'Move an entry to the trash, or delete it permanently with force=true (media always needs force=true).',
      input: { site, type: typeParam, namespace: namespaceParam, id: z.number().int(), force: z.boolean().default(false) },
      write: true,
      destructive: true,
    },
    async (a) => {
      const wp = getClient(a.site);
      const res = await wp.delete(`${ns(a.namespace)}/${segment(a.type, 'type')}/${a.id}`, { force: a.force || undefined });
      return { deleted: a.force, trashed: !a.force, id: a.id, status: (res.data as any)?.status ?? (res.data as any)?.previous?.status };
    },
  );

  // ===== Taxonomies =====
  tool(
    'list_terms',
    {
      title: 'List terms',
      description: 'List categories, tags or custom taxonomy terms.',
      input: {
        site,
        taxonomy: z.string().default('categories').describe('categories, tags or a custom taxonomy rest_base'),
        namespace: namespaceParam,
        search: z.string().optional(),
        parent: z.number().int().optional(),
        hide_empty: z.boolean().optional(),
        post: z.number().int().optional().describe('Only terms assigned to this post id'),
        per_page: z.number().int().min(1).max(100).default(50),
        page: z.number().int().min(1).default(1),
      },
    },
    async (a) => {
      const wp = getClient(a.site);
      const res = await wp.get(`${ns(a.namespace)}/${segment(a.taxonomy, 'taxonomy')}`, {
        search: a.search,
        parent: a.parent,
        hide_empty: a.hide_empty,
        post: a.post,
        per_page: a.per_page,
        page: a.page,
        _fields: 'id,name,slug,parent,count,description',
      });
      return { total: res.total, total_pages: res.totalPages, items: res.data };
    },
  );

  tool(
    'manage_term',
    {
      title: 'Create/update/delete term',
      description: 'Create, update or delete a category, tag or custom taxonomy term.',
      input: {
        site,
        action: z.enum(['create', 'update', 'delete']),
        taxonomy: z.string().default('categories'),
        namespace: namespaceParam,
        id: z.number().int().optional().describe('Required for update/delete'),
        name: z.string().optional(),
        slug: z.string().optional(),
        description: z.string().optional(),
        parent: z.number().int().optional(),
      },
      write: true,
    },
    async (a) => {
      const wp = getClient(a.site);
      const base = `${ns(a.namespace)}/${segment(a.taxonomy, 'taxonomy')}`;
      const body: Record<string, unknown> = {};
      for (const k of ['name', 'slug', 'description', 'parent'] as const) if (a[k] !== undefined) body[k] = a[k];
      if (a.action === 'create') {
        if (!a.name) throw new Error('name is required');
        return (await wp.post(base, body)).data;
      }
      if (!a.id) throw new Error('id is required');
      if (a.action === 'update') return (await wp.post(`${base}/${a.id}`, body)).data;
      return (await wp.delete(`${base}/${a.id}`, { force: true })).data;
    },
  );

  // ===== Media =====
  tool(
    'list_media',
    {
      title: 'List media',
      description: 'List media library items with id, title, URL, mime type, alt text and dimensions.',
      input: {
        site,
        search: z.string().optional(),
        media_type: z.enum(['image', 'video', 'audio', 'application', 'text']).optional(),
        parent: z.number().int().optional().describe('Attached to this post id'),
        per_page: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).default(1),
      },
    },
    async (a) => {
      const wp = getClient(a.site);
      const res = await wp.get('/wp/v2/media', {
        search: a.search,
        media_type: a.media_type,
        parent: a.parent,
        per_page: a.per_page,
        page: a.page,
        _fields: 'id,title,source_url,mime_type,alt_text,date,media_details',
      });
      const items = (res.data as any[]).map((m) => ({
        id: m.id,
        title: plain(m.title?.rendered),
        url: m.source_url,
        mime_type: m.mime_type,
        alt_text: m.alt_text,
        width: m.media_details?.width,
        height: m.media_details?.height,
        date: m.date,
      }));
      return { total: res.total, total_pages: res.totalPages, items };
    },
  );

  tool(
    'upload_media',
    {
      title: 'Upload media',
      description: 'Upload a file to the media library, either from a public URL (downloaded by the server) or as base64 data. Optionally sets title/alt/caption and the featured image of a post.',
      input: {
        site,
        source_url: z.string().url().optional().describe('Public http(s) URL of the file'),
        data_base64: z.string().optional().describe('File content as base64 (alternative to source_url)'),
        filename: z.string().optional().describe('File name incl. extension (required with data_base64)'),
        mime_type: z.string().optional(),
        title: z.string().optional(),
        alt_text: z.string().optional(),
        caption: z.string().optional(),
        description: z.string().optional(),
        attach_to: z.number().int().optional().describe('Post id to attach the media to'),
        set_featured_for: z.number().int().optional().describe('Post id whose featured image should become this media'),
        featured_type: z.string().default('posts').describe('rest_base of the post for set_featured_for (posts, pages, …)'),
        unsplash_download_location: z.string().url().optional().describe('download_location from search_images (Unsplash) – required by Unsplash when downloading their photos'),
      },
      write: true,
    },
    async (a) => {
      const wp = getClient(a.site);
      let data: Buffer;
      let filename = a.filename as string | undefined;
      let contentType = a.mime_type as string | undefined;

      if (a.source_url) {
        const res = await safeFetch(a.source_url, {}, allSiteHosts());
        if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
        data = await readLimited(res, config.maxUploadBytes);
        contentType = contentType ?? res.headers.get('content-type')?.split(';')[0] ?? undefined;
        if (!filename) {
          const fromUrl = decodeURIComponent(new URL(res.url || a.source_url).pathname.split('/').pop() ?? '');
          filename = fromUrl || 'upload';
        }
      } else if (a.data_base64) {
        if (!filename) throw new Error('filename is required with data_base64');
        data = Buffer.from(a.data_base64.replace(/^data:[^,]+,/, ''), 'base64');
        if (data.length > config.maxUploadBytes) throw new Error('File too large');
      } else {
        throw new Error('Provide source_url or data_base64');
      }

      const extByType: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'application/pdf': 'pdf', 'video/mp4': 'mp4' };
      if (filename && !/\.[a-z0-9]{2,5}$/i.test(filename) && contentType && extByType[contentType]) {
        filename = `${filename}.${extByType[contentType]}`;
      }

      const up = await wp.request('POST', '/wp/v2/media', {
        raw: { data, contentType: contentType ?? 'application/octet-stream', filename: filename ?? 'upload' },
        timeoutMs: 120_000,
      });
      const media: any = up.data;

      const meta: Record<string, unknown> = {};
      if (a.title) meta.title = a.title;
      if (a.alt_text) meta.alt_text = a.alt_text;
      if (a.caption) meta.caption = a.caption;
      if (a.description) meta.description = a.description;
      if (a.attach_to) meta.post = a.attach_to;
      if (Object.keys(meta).length) await wp.post(`/wp/v2/media/${media.id}`, meta);

      if (a.unsplash_download_location) await trackUnsplashDownload(a.unsplash_download_location);

      if (a.set_featured_for) {
        await wp.post(`/wp/v2/${segment(a.featured_type, 'featured_type')}/${a.set_featured_for}`, { featured_media: media.id });
      }

      return {
        id: media.id,
        url: media.source_url,
        mime_type: media.mime_type,
        width: media.media_details?.width,
        height: media.media_details?.height,
        featured_for: a.set_featured_for,
      };
    },
  );

  // ===== Plugins & themes =====
  tool(
    'list_plugins',
    {
      title: 'List plugins',
      description: 'List installed plugins with their id (folder/file), status and version.',
      input: { site, status: z.enum(['active', 'inactive']).optional(), search: z.string().optional() },
    },
    async (a) => {
      const wp = getClient(a.site);
      const res = await wp.get('/wp/v2/plugins', {
        status: a.status,
        search: a.search,
        _fields: 'plugin,status,name,version,requires_wp,requires_php,network_only',
      });
      return res.data;
    },
  );

  tool(
    'manage_plugin',
    {
      title: 'Manage plugin',
      description: 'Activate, deactivate, install (from wordpress.org by slug) or delete a plugin. plugin = id from list_plugins, e.g. "akismet/akismet".',
      input: {
        site,
        action: z.enum(['activate', 'deactivate', 'install', 'delete']),
        plugin: z.string().optional().describe('Plugin id "folder/file" (without .php) – for activate/deactivate/delete'),
        slug: z.string().optional().describe('wordpress.org slug – for install'),
        activate: z.boolean().default(false).describe('Activate right after install'),
      },
      write: true,
      destructive: true,
    },
    async (a) => {
      const wp = getClient(a.site);
      if (a.action === 'install') {
        if (!a.slug) throw new Error('slug is required for install');
        const res = await wp.post('/wp/v2/plugins', { slug: segment(a.slug, 'slug'), status: a.activate ? 'active' : 'inactive' }, { _fields: 'plugin,status,name,version' });
        return res.data;
      }
      if (!a.plugin) throw new Error('plugin is required');
      const id = a.plugin.replace(/\.php$/, '');
      if (!/^[\w.\-]+(\/[\w.\-]+)?$/.test(id)) throw new Error(`Invalid plugin id "${a.plugin}"`);
      if (a.action === 'delete') return (await wp.delete(`/wp/v2/plugins/${id}`)).data;
      const res = await wp.post(`/wp/v2/plugins/${id}`, { status: a.action === 'activate' ? 'active' : 'inactive' }, { _fields: 'plugin,status,name,version' });
      return res.data;
    },
  );

  tool(
    'list_themes',
    {
      title: 'List themes',
      description: 'List installed themes (stylesheet, template/parent, version, status, block theme or classic).',
      input: { site },
    },
    async ({ site: id }) => {
      const wp = getClient(id);
      return clean((await wp.get('/wp/v2/themes')).data).map((t: any) => ({
        stylesheet: t.stylesheet,
        template: t.template,
        name: t.name,
        version: t.version,
        status: t.status,
        is_block_theme: t.is_block_theme,
      }));
    },
  );

  // ===== Generic REST & front end =====
  tool(
    'rest_request',
    {
      title: 'REST request',
      description: 'Send any request to the site REST API, e.g. GET /wp/v2/users, POST /wp/v2/templates/<id>, GET /wc/v3/products, /wp/v2/menu-items, /wp/v2/global-styles/<id>, /wp/v2/block-types. path is relative to /wp-json.',
      input: {
        site,
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        path: z.string().describe('e.g. /wp/v2/users or /wc/v3/orders'),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.any().optional().describe('JSON body for POST/PUT/PATCH'),
        raw_output: z.boolean().default(false).describe('Return the unprocessed JSON (keeps _links and rendered fields)'),
      },
      mixed: true,
      destructive: true,
    },
    async (a) => {
      if (isReadOnly() && a.method !== 'GET') throw new Error('Server is in READ_ONLY mode – only GET is allowed');
      if (!a.path.startsWith('/')) throw new Error('path must start with "/"');
      if (a.path.includes('..')) throw new Error('Invalid path');
      const wp = getClient(a.site);
      const res = await wp.request(a.method, a.path, { query: a.query, body: a.body });
      return {
        status: res.status,
        total: res.total,
        total_pages: res.totalPages,
        data: a.raw_output ? res.data : clean(res.data),
      };
    },
  );

  tool(
    'fetch_page',
    {
      title: 'Fetch front-end page',
      description: 'Load a public page of the site (as a visitor) and return its HTML or visible text, e.g. to verify a change. Only URLs of the configured site are allowed.',
      input: {
        site,
        path: z.string().default('/').describe('Path like /kontakt/ or a full URL on the same site'),
        mode: z.enum(['html', 'text']).default('text'),
        max_chars: z.number().int().min(1000).max(200000).default(40000),
        bust_cache: z.boolean().default(true).describe('Append a random query parameter to bypass page caches'),
      },
    },
    async (a) => {
      const wp = getClient(a.site);
      const url = new URL(a.path, `${wp.site.url}/`);
      if (url.hostname !== wp.host) throw new Error(`Only URLs on ${wp.host} are allowed`);
      if (a.bust_cache) url.searchParams.set('cbmcp_nocache', Date.now().toString(36));
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(45_000) });
      const html = await res.text();
      const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
      let body = html;
      if (a.mode === 'text') {
        body = decode(
          html
            .replace(/<head[\s\S]*?<\/head>/i, ' ')
            .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|br)>/gi, '\n')
            .replace(/<[^>]+>/g, ' '),
        )
          .replace(/[ \t]+/g, ' ')
          .replace(/\n\s*\n+/g, '\n')
          .trim();
      }
      return {
        status: res.status,
        url: res.url,
        title: title ? decode(title.trim()) : undefined,
        length: body.length,
        content: body.length > a.max_chars ? `${body.slice(0, a.max_chars)}\n[… truncated]` : body,
      };
    },
  );

  // ===== Bridge plugin: files =====
  const B = '/cbmcp/v1';
  const filePath = z.string().describe('Path relative to wp-content, e.g. themes/my-theme/functions.php');

  tool(
    'file_list',
    {
      title: 'List files',
      description: '[Bridge] List files and folders below wp-content/themes, plugins, mu-plugins or languages.',
      input: {
        site,
        path: z.string().default('themes').describe('Folder relative to wp-content, e.g. themes/my-theme'),
        depth: z.number().int().min(1).max(6).default(2),
      },
    },
    async (a) => (await getClient(a.site).get(`${B}/files/list`, { path: a.path, depth: a.depth })).data,
  );

  tool(
    'file_read',
    {
      title: 'Read file',
      description: '[Bridge] Read a text file (theme/plugin source, CSS, JSON …). Use start_line/end_line for large files.',
      input: {
        site,
        path: filePath,
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
        line_numbers: z.boolean().default(false),
      },
    },
    async (a) => {
      const res = (await getClient(a.site).get(`${B}/files/read`, { path: a.path })).data as { path: string; content: string; size: number; modified: string };
      let lines = res.content.split('\n');
      const total = lines.length;
      const start = a.start_line ?? 1;
      const end = Math.min(a.end_line ?? total, total);
      if (a.start_line || a.end_line) lines = lines.slice(start - 1, end);
      const content = a.line_numbers ? lines.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n') : lines.join('\n');
      return { path: res.path, size: res.size, modified: res.modified, total_lines: total, lines: `${start}-${end}`, content };
    },
  );

  tool(
    'file_write',
    {
      title: 'Write file',
      description: '[Bridge] Create or overwrite a file. PHP is syntax-checked first (invalid code is rejected), the previous version is backed up (see file_restore). For small changes prefer file_edit.',
      input: { site, path: filePath, content: z.string(), create_dirs: z.boolean().default(true) },
      write: true,
      destructive: true,
    },
    async (a) => (await getClient(a.site).post(`${B}/files/write`, { path: a.path, content: a.content, create_dirs: a.create_dirs })).data,
  );

  tool(
    'file_edit',
    {
      title: 'Edit file',
      description: '[Bridge] Replace an exact text snippet in a file. old_string must occur exactly once (or set replace_all). Include enough surrounding lines to make it unique.',
      input: {
        site,
        path: filePath,
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().default(false),
      },
      write: true,
      destructive: true,
    },
    async (a) => {
      const wp = getClient(a.site);
      const file = (await wp.get(`${B}/files/read`, { path: a.path })).data as { content: string };
      const count = file.content.split(a.old_string).length - 1;
      if (count === 0) throw new Error('old_string not found in file (check whitespace/indentation; use file_read with line_numbers)');
      if (count > 1 && !a.replace_all) throw new Error(`old_string occurs ${count} times – add more context or set replace_all=true`);
      const updated = a.replace_all ? file.content.split(a.old_string).join(a.new_string) : file.content.replace(a.old_string, () => a.new_string);
      const res = (await wp.post(`${B}/files/write`, { path: a.path, content: updated })).data;
      return { ...res, replacements: a.replace_all ? count : 1 };
    },
  );

  tool(
    'file_delete',
    {
      title: 'Delete file',
      description: '[Bridge] Delete a file (a backup copy is kept, restorable with file_restore).',
      input: { site, path: filePath },
      write: true,
      destructive: true,
    },
    async (a) => (await getClient(a.site).post(`${B}/files/delete`, { path: a.path })).data,
  );

  tool(
    'file_search',
    {
      title: 'Search files',
      description: '[Bridge] Search text in files below a folder (like grep). Returns path, line number and line.',
      input: {
        site,
        path: z.string().default('themes').describe('Folder relative to wp-content'),
        query: z.string().min(2),
        regex: z.boolean().default(false).describe('Treat query as a PCRE regular expression (without delimiters)'),
        case_sensitive: z.boolean().default(false),
        extensions: z.array(z.string()).optional().describe('e.g. ["php","css"]'),
        max_results: z.number().int().min(1).max(500).default(100),
      },
    },
    async (a) =>
      (
        await getClient(a.site).get(`${B}/files/search`, {
          path: a.path,
          query: a.query,
          regex: a.regex ? 1 : 0,
          case_sensitive: a.case_sensitive ? 1 : 0,
          extensions: a.extensions,
          max: a.max_results,
        })
      ).data,
  );

  tool(
    'file_restore',
    {
      title: 'Restore file backup',
      description: '[Bridge] List backups of a file (action=list) or restore the latest/a specific backup (action=restore).',
      input: { site, path: filePath, action: z.enum(['list', 'restore']).default('list'), backup: z.string().optional().describe('Backup name from action=list; default latest') },
      write: true,
      destructive: true,
    },
    async (a) => {
      const wp = getClient(a.site);
      if (a.action === 'list') return (await wp.get(`${B}/files/backups`, { path: a.path })).data;
      return (await wp.post(`${B}/files/restore`, { path: a.path, backup: a.backup })).data;
    },
  );

  // ===== Bridge plugin: snippets, options, cache, theme =====
  tool(
    'manage_snippet',
    {
      title: 'PHP snippets',
      description:
        '[Bridge] Manage PHP code snippets that run on every request (like the Code Snippets plugin): list, get, save, enable, disable, delete. Code is syntax-checked; a snippet that throws an error is disabled automatically. Prefer snippets over editing a parent theme functions.php.',
      input: {
        site,
        action: z.enum(['list', 'get', 'save', 'enable', 'disable', 'delete']),
        name: z.string().optional().describe('Snippet slug: a-z, 0-9, - and _'),
        code: z.string().optional().describe('PHP code (with or without leading <?php) – for save'),
        description: z.string().optional(),
        active: z.boolean().default(true).describe('Activate on save'),
      },
      write: true,
      destructive: true,
    },
    async (a) => {
      const wp = getClient(a.site);
      if (a.action === 'list') return (await wp.get(`${B}/snippets`)).data;
      if (!a.name) throw new Error('name is required');
      if (a.action === 'get') return (await wp.get(`${B}/snippets/get`, { name: a.name })).data;
      if (a.action === 'save') {
        if (a.code === undefined) throw new Error('code is required');
        return (await wp.post(`${B}/snippets/save`, { name: a.name, code: a.code, description: a.description, active: a.active })).data;
      }
      if (a.action === 'delete') return (await wp.post(`${B}/snippets/delete`, { name: a.name })).data;
      return (await wp.post(`${B}/snippets/toggle`, { name: a.name, active: a.action === 'enable' })).data;
    },
  );

  tool(
    'manage_option',
    {
      title: 'WordPress options',
      description: '[Bridge] Read, set or delete a WordPress option (wp_options) such as plugin settings. Core URL/theme/plugin options are protected – use the dedicated tools.',
      input: {
        site,
        action: z.enum(['get', 'set', 'delete']).default('get'),
        name: z.string().min(1),
        value: z.any().optional().describe('New value (string, number, array or object) for action=set'),
        autoload: z.boolean().optional(),
      },
      mixed: true,
    },
    async (a) => {
      const wp = getClient(a.site);
      if (a.action === 'get') return (await wp.post(`${B}/options/get`, { name: a.name })).data;
      if (isReadOnly()) throw new Error('Server is in READ_ONLY mode');
      if (a.action === 'delete') return (await wp.post(`${B}/options/delete`, { name: a.name })).data;
      return (await wp.post(`${B}/options/set`, { name: a.name, value: a.value, autoload: a.autoload })).data;
    },
  );

  tool(
    'flush_cache',
    {
      title: 'Flush caches',
      description: '[Bridge] Flush object cache, rewrite rules (optional) and common page-cache plugins (WP Rocket, W3TC, WP Super Cache, LiteSpeed, Autoptimize, SiteGround, Breeze, WP Fastest Cache, Elementor CSS).',
      input: { site, rewrite_rules: z.boolean().default(false) },
      write: true,
    },
    async (a) => (await getClient(a.site).post(`${B}/cache/flush`, { rewrite_rules: a.rewrite_rules })).data,
  );

  tool(
    'activate_theme',
    {
      title: 'Activate theme',
      description: '[Bridge] Switch the active theme (stylesheet from list_themes). This changes the live site immediately – confirm with the user first.',
      input: { site, stylesheet: z.string() },
      write: true,
      destructive: true,
    },
    async (a) => (await getClient(a.site).post(`${B}/theme/activate`, { stylesheet: a.stylesheet })).data,
  );

  registerExtraTools(tool);

  return server;
}
