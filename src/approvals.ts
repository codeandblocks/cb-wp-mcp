/**
 * Code & Blocks WordPress MCP – approvals for risky tool calls
 * Author: Code & Blocks by Marijan
 *
 * A gated tool call creates a pending approval and waits a short time for the
 * user to approve it in the admin UI (/admin/approvals/<id>). If the decision
 * takes longer, the tool returns the link and Claude repeats the call with
 * approval_id once the user has approved.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { record } from './activity.js';
import { approvalSettings } from './store.js';

export interface Approval {
  id: string;
  tool: string;
  site?: string;
  summary: string;
  args: Record<string, unknown>;
  hash: string;
  status: 'pending' | 'approved' | 'declined' | 'used' | 'expired';
  created: string;
  decided?: string;
}

const TTL_MS = 60 * 60 * 1000;
const FILE = () => path.join(config.dataDir, 'approvals.json');
let items: Approval[] = [];

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

export function initApprovals() {
  try {
    if (fs.existsSync(FILE())) items = JSON.parse(fs.readFileSync(FILE(), 'utf8')) as Approval[];
  } catch {
    items = [];
  }
  expire();
}

function save() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(items.slice(-300)));
  } catch {
    /* ignore */
  }
}

function expire() {
  const now = Date.now();
  for (const a of items) if (a.status === 'pending' && now - Date.parse(a.created) > TTL_MS) a.status = 'expired';
}

function hashArgs(args: Record<string, unknown>): string {
  const { approval_id: _x, ...rest } = args;
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as any)[k])])) : v;
  return crypto.createHash('sha256').update(JSON.stringify(stable(rest))).digest('hex');
}

export function needsApproval(tool: string, args: Record<string, unknown>): boolean {
  const s = approvalSettings();
  if (!s.enabled || !s.tools.includes(tool)) return false;
  const cond = CONDITIONS[tool];
  return cond ? cond(args) : true;
}

/** Is approval switched on for this tool at all? */
export function toolGated(tool: string): boolean {
  const s = approvalSettings();
  return s.enabled && s.tools.includes(tool);
}

export function list(status?: Approval['status']) {
  expire();
  return [...items].reverse().filter((a) => !status || a.status === status);
}

export function get(id: string) {
  expire();
  return items.find((a) => a.id === id);
}

export function decide(id: string, approve: boolean): Approval | undefined {
  const a = get(id);
  if (!a || a.status !== 'pending') return a;
  a.status = approve ? 'approved' : 'declined';
  a.decided = new Date().toISOString();
  save();
  record({ site: a.site, tool: a.tool, kind: 'approval', status: approve ? 'approved' : 'declined', summary: `${approve ? 'Freigegeben' : 'Abgelehnt'}: ${a.summary}`, source: 'ui' });
  return a;
}

export function approvalUrl(id: string) {
  return `${config.publicUrl ?? ''}/admin/approvals/${id}`;
}

export type GateResult = { proceed: true } | { proceed: false; message: string };

/**
 * Check or create an approval for this call. Waits up to APPROVAL_WAIT_SECONDS
 * for the user's decision before giving Claude the link.
 */
export async function gate(tool: string, site: string | undefined, args: Record<string, unknown>, summary: string): Promise<GateResult> {
  const hash = hashArgs(args);
  const given = typeof args.approval_id === 'string' ? get(args.approval_id) : undefined;

  if (given) {
    if (given.hash !== hash || given.tool !== tool) return { proceed: false, message: 'approval_id does not match this call (arguments changed). Request a new approval by calling the tool without approval_id.' };
    if (given.status === 'approved') {
      given.status = 'used';
      save();
      return { proceed: true };
    }
    if (given.status === 'pending') {
      const decided = await waitFor(given.id);
      if (decided === 'approved') {
        given.status = 'used';
        save();
        return { proceed: true };
      }
      if (decided === 'pending') return { proceed: false, message: `Still waiting for approval. Ask the user to open ${approvalUrl(given.id)} and approve, then call ${tool} again with approval_id="${given.id}".` };
    }
    return { proceed: false, message: `This approval is ${given.status}. The action was not executed.` };
  }

  const a: Approval = { id: crypto.randomBytes(8).toString('hex'), tool, site, summary, args: Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'approval_id')), hash, status: 'pending', created: new Date().toISOString() };
  items.push(a);
  save();
  record({ site, tool, kind: 'approval', status: 'pending', summary: `Freigabe nötig: ${summary}`, source: 'mcp', link: approvalUrl(a.id) });

  const decided = await waitFor(a.id);
  if (decided === 'approved') {
    a.status = 'used';
    save();
    return { proceed: true };
  }
  if (decided === 'declined') return { proceed: false, message: 'The user declined this action. It was not executed. Do not retry unless the user asks.' };
  return {
    proceed: false,
    message:
      `APPROVAL REQUIRED – nothing was changed yet.\n` +
      `Tell the user to review and approve: ${approvalUrl(a.id)}\n` +
      `(also shown as notice in wp-admin). After the user confirms, call ${tool} again with exactly the same arguments plus approval_id="${a.id}".`,
  };
}

async function waitFor(id: string): Promise<Approval['status']> {
  const deadline = Date.now() + config.approvalWaitSeconds * 1000;
  for (;;) {
    const a = get(id);
    if (!a) return 'expired';
    if (a.status !== 'pending' || Date.now() >= deadline) return a.status;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
