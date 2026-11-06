/**
 * Code & Blocks WordPress MCP – activity log, access log, retention
 * Author: Code & Blocks by Marijan
 *
 * Activity: every change made through the MCP server or the UI, per workspace.
 * It is also sent to the site's bridge plugin (wp-admin activity tab, live
 * notices). Summaries never contain content, e-mail addresses or SQL values.
 *
 * Access log: who opened which workspace in the UI or authorised an AI client.
 */
import { all, get, run } from './db.js';
import { ctx, maybeCtx } from './context.js';
import { getClient } from './wp.js';
import { getSettings, listWorkspaces } from './workspaces.js';

export interface ActivityEvent {
  id: number;
  workspaceId: string;
  ts: string;
  site?: string;
  tool: string;
  kind: 'change' | 'approval';
  status: 'ok' | 'error' | 'pending' | 'approved' | 'declined';
  summary: string;
  source: 'mcp' | 'ui';
  actor?: string;
  link?: string;
  edit_link?: string;
  object_type?: string;
  object_id?: number;
  ms?: number;
}

const noBridgeUntil = new Map<string, number>();

function rowToEvent(r: any): ActivityEvent {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    ts: r.ts,
    site: r.site ?? undefined,
    tool: r.tool,
    kind: r.kind,
    status: r.status,
    summary: r.summary,
    source: r.source,
    actor: r.actor ?? undefined,
    link: r.link ?? undefined,
    edit_link: r.edit_link ?? undefined,
    object_type: r.object_type ?? undefined,
    object_id: r.object_id ?? undefined,
    ms: r.ms ?? undefined,
  };
}

/** Send the event to the site's bridge plugin (best effort, never throws). */
async function pushToSite(e: ActivityEvent) {
  if (!e.site) return;
  const key = `${e.workspaceId}:${e.site}`;
  if ((noBridgeUntil.get(key) ?? 0) > Date.now()) return;
  try {
    const wp = getClient(e.site);
    await wp.request('POST', '/cbmcp/v1/activity/log', {
      body: {
        kind: e.kind,
        tool: e.tool,
        summary: e.summary,
        status: e.status === 'error' ? 'error' : 'ok',
        object_type: e.object_type,
        object_id: e.object_id,
        link: e.link,
        edit_link: e.edit_link,
      },
      timeoutMs: 8000,
    });
  } catch {
    noBridgeUntil.set(key, Date.now() + 10 * 60 * 1000);
  }
}

export function record(e: Omit<ActivityEvent, 'id' | 'ts' | 'workspaceId' | 'actor'> & { workspaceId?: string; actor?: string }): ActivityEvent {
  const c = maybeCtx();
  const wsId = e.workspaceId ?? c?.workspaceId;
  if (!wsId) throw new Error('record(): no workspace');
  const ts = new Date().toISOString();
  const r = run(
    `INSERT INTO activity (workspace_id, ts, site, tool, kind, status, summary, source, actor, link, edit_link, object_type, object_id, ms)
     VALUES (:ws, :ts, :site, :tool, :kind, :status, :summary, :source, :actor, :link, :edit, :ot, :oid, :ms)`,
    {
      ws: wsId,
      ts,
      site: e.site,
      tool: e.tool,
      kind: e.kind,
      status: e.status,
      summary: e.summary.slice(0, 500),
      source: e.source,
      actor: e.actor ?? c?.actor,
      link: e.link,
      edit: e.edit_link,
      ot: e.object_type,
      oid: e.object_id,
      ms: e.ms,
    },
  );
  const ev: ActivityEvent = { ...e, id: Number(r.lastInsertRowid), ts, workspaceId: wsId, actor: e.actor ?? c?.actor };
  if (c && c.workspaceId === wsId) void pushToSite(ev);
  return ev;
}

export function recent(limit = 100, site?: string, wsId = ctx().workspaceId): ActivityEvent[] {
  const rows = site
    ? all('SELECT * FROM activity WHERE workspace_id = :ws AND site = :site ORDER BY id DESC LIMIT :n', { ws: wsId, site, n: limit })
    : all('SELECT * FROM activity WHERE workspace_id = :ws ORDER BY id DESC LIMIT :n', { ws: wsId, n: limit });
  return rows.map(rowToEvent);
}

export function exportActivity(wsId: string): ActivityEvent[] {
  return all('SELECT * FROM activity WHERE workspace_id = :ws ORDER BY id', { ws: wsId }).map(rowToEvent);
}

// ---------- access log ----------

export interface AccessEntry {
  id: number;
  ts: string;
  workspaceId?: string;
  actor: string;
  action: string;
  ip?: string;
  detail?: string;
}

export function logAccess(e: { workspaceId?: string; actor: string; action: string; ip?: string; detail?: string }) {
  run('INSERT INTO access_log (ts, workspace_id, actor, action, ip, detail) VALUES (:ts, :ws, :actor, :action, :ip, :detail)', {
    ts: new Date().toISOString(),
    ws: e.workspaceId,
    actor: e.actor.slice(0, 120),
    action: e.action.slice(0, 60),
    ip: e.ip,
    detail: e.detail?.slice(0, 300),
  });
}

export function accessLog(wsId?: string, limit = 300): AccessEntry[] {
  const rows = wsId
    ? all('SELECT * FROM access_log WHERE workspace_id = :ws ORDER BY id DESC LIMIT :n', { ws: wsId, n: limit })
    : all('SELECT * FROM access_log ORDER BY id DESC LIMIT :n', { n: limit });
  return rows.map((r: any) => ({ id: r.id, ts: r.ts, workspaceId: r.workspace_id ?? undefined, actor: r.actor, action: r.action, ip: r.ip ?? undefined, detail: r.detail ?? undefined }));
}

// ---------- retention ----------

export const ACCESS_LOG_DAYS = 365;
export const APPROVAL_DAYS = 30;

/** Delete data older than the retention period. Runs at start-up and daily. */
export function purgeExpired() {
  const days = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
  let removed = 0;
  for (const ws of listWorkspaces()) {
    removed += Number(run('DELETE FROM activity WHERE workspace_id = :ws AND ts < :t', { ws: ws.id, t: days(getSettings(ws.id).retentionDays) }).changes);
  }
  removed += Number(run('DELETE FROM approvals WHERE created < :t', { t: days(APPROVAL_DAYS) }).changes);
  removed += Number(run('DELETE FROM access_log WHERE ts < :t', { t: days(ACCESS_LOG_DAYS) }).changes);
  const now = Math.floor(Date.now() / 1000);
  removed += Number(run('DELETE FROM pii_tokens WHERE expires_at < :n', { n: now }).changes);
  removed += Number(run("DELETE FROM tokens WHERE kind IN ('access','refresh') AND expires_at < :n", { n: now }).changes);
  if (removed) console.log(`[retention] removed ${removed} expired record(s)`);
}

export function lastActivityTs(wsId: string): string | undefined {
  return get<{ t: string }>('SELECT MAX(ts) AS t FROM activity WHERE workspace_id = :ws', { ws: wsId })?.t ?? undefined;
}
