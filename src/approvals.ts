/**
 * Code & Blocks WordPress MCP – approvals for risky tool calls (per workspace)
 * Author: Code & Blocks by Marijan
 *
 * A gated tool call creates a pending approval and waits a short time for the
 * user to approve it in the portal (/admin/approvals/<id>). If the decision
 * takes longer, the tool returns the link and the AI repeats the call with
 * approval_id once the user has approved. Arguments are stored encrypted.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import { all, get, run } from './db.js';
import { ctx } from './context.js';
import { record } from './activity.js';
import { getSettings } from './workspaces.js';
import { seal, unseal } from './crypto.js';

export interface Approval {
  id: string;
  workspaceId: string;
  tool: string;
  site?: string;
  summary: string;
  args: Record<string, unknown>;
  hash: string;
  status: 'pending' | 'approved' | 'declined' | 'used' | 'expired';
  created: string;
  decided?: string;
  decidedBy?: string;
}

const TTL_MS = 60 * 60 * 1000;

/** Which calls of a gated tool actually need approval. */
const CONDITIONS: Record<string, (a: any) => boolean> = {
  delete_content: (a) => Boolean(a.force) || a.type === 'media',
  manage_plugin: (a) => a.action === 'install' || a.action === 'delete',
  activate_theme: () => true,
  apply_copy: () => true,
  file_delete: () => true,
  db_query: (a) => Boolean(a.allow_write),
  manage_updates: (a) => a.action === 'run',
  manage_option: (a) => a.action === 'delete',
  send_test_email: () => true,
  run_ability: () => false, // gated inside run_ability once the ability's annotations are known
};

function rowTo(r: any): Approval {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(unseal(r.args));
  } catch {
    /* unreadable */
  }
  return { id: r.id, workspaceId: r.workspace_id, tool: r.tool, site: r.site ?? undefined, summary: r.summary, args, hash: r.hash, status: r.status, created: r.created, decided: r.decided ?? undefined, decidedBy: r.decided_by ?? undefined };
}

function expire() {
  run("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND created < :t", { t: new Date(Date.now() - TTL_MS).toISOString() });
}

function hashArgs(args: Record<string, unknown>): string {
  const { approval_id: _x, ...rest } = args;
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as any)[k])])) : v;
  return crypto.createHash('sha256').update(JSON.stringify(stable(rest))).digest('hex');
}

export function needsApproval(tool: string, args: Record<string, unknown>): boolean {
  const s = getSettings().approvals;
  if (!s.enabled || !s.tools.includes(tool)) return false;
  const cond = CONDITIONS[tool];
  return cond ? cond(args) : true;
}

export function toolGated(tool: string): boolean {
  const s = getSettings().approvals;
  return s.enabled && s.tools.includes(tool);
}

export function list(status?: Approval['status'], wsId = ctx().workspaceId): Approval[] {
  expire();
  const rows = status
    ? all('SELECT * FROM approvals WHERE workspace_id = :ws AND status = :st ORDER BY created DESC LIMIT 200', { ws: wsId, st: status })
    : all('SELECT * FROM approvals WHERE workspace_id = :ws ORDER BY created DESC LIMIT 200', { ws: wsId });
  return rows.map(rowTo);
}

export function countPending(wsId = ctx().workspaceId): number {
  expire();
  return Number(get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE workspace_id = :ws AND status = 'pending'", { ws: wsId })?.n ?? 0);
}

/** Only returns approvals of the current workspace. */
export function getApproval(id: string, wsId = ctx().workspaceId): Approval | undefined {
  expire();
  const r = get('SELECT * FROM approvals WHERE id = :id AND workspace_id = :ws', { id, ws: wsId });
  return r ? rowTo(r) : undefined;
}

function setStatus(id: string, status: Approval['status'], by?: string) {
  run('UPDATE approvals SET status = :st, decided = COALESCE(decided, :t), decided_by = COALESCE(decided_by, :by) WHERE id = :id', { id, st: status, t: new Date().toISOString(), by });
}

export function decide(id: string, approve: boolean): Approval | undefined {
  const a = getApproval(id);
  if (!a || a.status !== 'pending') return a;
  setStatus(id, approve ? 'approved' : 'declined', ctx().actor);
  record({ site: a.site, tool: a.tool, kind: 'approval', status: approve ? 'approved' : 'declined', summary: `${approve ? 'Freigegeben' : 'Abgelehnt'}: ${a.summary}`, source: 'ui' });
  return getApproval(id);
}

export function approvalUrl(id: string) {
  return `${config.publicUrl ?? ''}/admin/approvals/${id}`;
}

export function exportApprovals(wsId: string): Approval[] {
  return all('SELECT * FROM approvals WHERE workspace_id = :ws ORDER BY created', { ws: wsId }).map(rowTo);
}

export type GateResult = { proceed: true } | { proceed: false; message: string };

export async function gate(tool: string, site: string | undefined, args: Record<string, unknown>, summary: string): Promise<GateResult> {
  const wsId = ctx().workspaceId;
  const hash = hashArgs(args);
  const given = typeof args.approval_id === 'string' ? getApproval(args.approval_id) : undefined;

  if (given) {
    if (given.hash !== hash || given.tool !== tool) return { proceed: false, message: 'approval_id does not match this call (arguments changed). Request a new approval by calling the tool without approval_id.' };
    if (given.status === 'approved') {
      setStatus(given.id, 'used');
      return { proceed: true };
    }
    if (given.status === 'pending') {
      const decided = await waitFor(given.id, wsId);
      if (decided === 'approved') {
        setStatus(given.id, 'used');
        return { proceed: true };
      }
      if (decided === 'pending') return { proceed: false, message: `Still waiting for approval. Ask the user to open ${approvalUrl(given.id)} and approve, then call ${tool} again with approval_id="${given.id}".` };
    }
    return { proceed: false, message: `This approval is ${given.status}. The action was not executed.` };
  }

  const id = crypto.randomBytes(8).toString('hex');
  const clean = Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'approval_id'));
  run('INSERT INTO approvals (id, workspace_id, tool, site, summary, args, hash, status, created) VALUES (:id, :ws, :tool, :site, :summary, :args, :hash, \'pending\', :t)', {
    id,
    ws: wsId,
    tool,
    site,
    summary: summary.slice(0, 300),
    args: seal(JSON.stringify(clean)),
    hash,
    t: new Date().toISOString(),
  });
  record({ site, tool, kind: 'approval', status: 'pending', summary: `Freigabe nötig: ${summary}`, source: 'mcp', link: approvalUrl(id) });

  const decided = await waitFor(id, wsId);
  if (decided === 'approved') {
    setStatus(id, 'used');
    return { proceed: true };
  }
  if (decided === 'declined') return { proceed: false, message: 'The user declined this action. It was not executed. Do not retry unless the user asks.' };
  return {
    proceed: false,
    message:
      `APPROVAL REQUIRED – nothing was changed yet.\n` +
      `Tell the user to review and approve: ${approvalUrl(id)}\n` +
      `(also shown as notice in wp-admin). After the user confirms, call ${tool} again with exactly the same arguments plus approval_id="${id}".`,
  };
}

async function waitFor(id: string, wsId: string): Promise<Approval['status']> {
  const deadline = Date.now() + config.approvalWaitSeconds * 1000;
  for (;;) {
    const a = getApproval(id, wsId);
    if (!a) return 'expired';
    if (a.status !== 'pending' || Date.now() >= deadline) return a.status;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
