/**
 * Code & Blocks WordPress MCP – request context
 * Author: Code & Blocks by Marijan
 *
 * Every MCP request and every admin/portal request runs inside exactly one
 * workspace. All data access (sites, keys, activity, approvals) reads the
 * workspace from here, so one customer can never reach another's data.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface Ctx {
  workspaceId: string;
  role: 'owner' | 'customer';
  /** Who acts, e.g. "owner", "maria@kunde.at (WordPress)", "token:Claude Code" */
  actor: string;
  via: 'mcp' | 'ui';
  /** Per-request cache (settings, caps) – filled lazily. */
  memo?: Map<string, unknown>;
}

const als = new AsyncLocalStorage<Ctx>();

export function runWith<T>(c: Ctx, fn: () => T): T {
  return als.run(c, fn);
}

export function ctx(): Ctx {
  const c = als.getStore();
  if (!c) throw new Error('Internal error: no workspace context');
  return c;
}

export function maybeCtx(): Ctx | undefined {
  return als.getStore();
}
