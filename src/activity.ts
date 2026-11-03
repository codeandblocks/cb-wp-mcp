/**
 * Code & Blocks WordPress MCP – activity log
 * Author: Code & Blocks by Marijan
 *
 * Every change made through the MCP server (and through the admin UI) is
 * appended to DATA_DIR/activity.jsonl and sent to the site's bridge plugin,
 * which shows it in wp-admin (activity tab, admin-bar counter, live toasts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getClient } from './wp.js';

export interface ActivityEvent {
  id: number;
  ts: string;
  site?: string;
  tool: string;
  kind: 'change' | 'approval';
  status: 'ok' | 'error' | 'pending' | 'approved' | 'declined';
  summary: string;
  source: 'mcp' | 'ui';
  link?: string;
  edit_link?: string;
  object_type?: string;
  object_id?: number;
  ms?: number;
}

const MAX_MEMORY = 1000;
const MAX_FILE_LINES = 20000;
const FILE = () => path.join(config.dataDir, 'activity.jsonl');
let events: ActivityEvent[] = [];
let nextId = 1;
let writes = 0;
const noBridgeUntil = new Map<string, number>();

export function initActivity() {
  try {
    if (!fs.existsSync(FILE())) return;
    const lines = fs.readFileSync(FILE(), 'utf8').trim().split('\n').filter(Boolean);
    events = lines.slice(-MAX_MEMORY).map((l) => JSON.parse(l) as ActivityEvent);
    nextId = (events[events.length - 1]?.id ?? 0) + 1;
  } catch (e) {
    console.warn(`[activity] cannot read log: ${(e as Error).message}`);
  }
}

function persist(e: ActivityEvent) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.appendFileSync(FILE(), `${JSON.stringify(e)}\n`);
    if (++writes % 500 === 0) {
      const lines = fs.readFileSync(FILE(), 'utf8').trim().split('\n');
      if (lines.length > MAX_FILE_LINES) fs.writeFileSync(FILE(), `${lines.slice(-MAX_FILE_LINES / 2).join('\n')}\n`);
    }
  } catch {
    /* logging must never break a tool call */
  }
}

/** Send the event to the site's bridge plugin (best effort, never throws). */
async function pushToSite(e: ActivityEvent) {
  if (!e.site) return;
  const until = noBridgeUntil.get(e.site) ?? 0;
  if (until > Date.now()) return;
  try {
    const wp = getClient(e.site);
    await wp.request('POST', '/cbmcp/v1/activity/log', {
      body: {
        kind: e.kind,
        tool: e.tool,
        summary: e.summary,
        status: e.status === 'pending' ? 'ok' : e.status === 'error' ? 'error' : 'ok',
        object_type: e.object_type,
        object_id: e.object_id,
        link: e.link,
        edit_link: e.edit_link,
      },
      timeoutMs: 8000,
    });
  } catch (err) {
    // Bridge missing or older than 1.2 – do not retry for 10 minutes.
    noBridgeUntil.set(e.site, Date.now() + 10 * 60 * 1000);
  }
}

export function record(e: Omit<ActivityEvent, 'id' | 'ts'>): ActivityEvent {
  const ev: ActivityEvent = { id: nextId++, ts: new Date().toISOString(), ...e };
  events.push(ev);
  if (events.length > MAX_MEMORY) events = events.slice(-MAX_MEMORY);
  persist(ev);
  void pushToSite(ev);
  return ev;
}

export function recent(limit = 100, site?: string): ActivityEvent[] {
  const list = site ? events.filter((e) => e.site === site) : events;
  return list.slice(-limit).reverse();
}

export function lastForSite(site: string): ActivityEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].site === site) return events[i];
  return undefined;
}
