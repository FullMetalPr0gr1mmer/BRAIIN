import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The columns `authenticated` holds a privilege on in public.leads after every migration,
// replayed in order: a table-level revoke clears them, a column grant adds, a table-level
// grant means every column ('*'), and a dropped column takes its privileges with it (the
// leads contract, C14b, drops four). Staff tokens reach leads through column grants only
// (0030, 0033, 0041), so the specs that stand in for PostgREST read the grant from here
// instead of keeping their own copy that a later migration would outdate.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

/** The columns an `alter table public.leads` statement drops, in statement order. */
export function droppedLeadColumns(sql: string): string[] {
  const dropped: string[] = [];
  for (const alter of sql.matchAll(/\balter\s+table\s+(?:only\s+)?public\.leads\b([^;]*);/gi)) {
    for (const drop of (alter[1] ?? '').matchAll(
      /\bdrop\s+column\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)/gi,
    )) {
      dropped.push(drop[1]!.toLowerCase());
    }
  }
  return dropped;
}

export function replayLeadGrant(privilege: 'select' | 'update'): Set<string> {
  let columns = new Set<string>();
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const statement =
    /\b(grant|revoke)\s+([a-z_, ]+?)(?:\s*\(([^)]*)\))?\s+on\s+(?:table\s+)?public\.leads\s+(?:to|from)\s+([a-z_, ]+)|\balter\s+table\s+(?:only\s+)?public\.leads\b[^;]*;/gi;
  const touches = new RegExp(`\\b(${privilege}|all)\\b`, 'i');
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const match of sql.matchAll(statement)) {
      const [whole, verb, privileges, columnList, roles] = match;
      if (!verb) {
        // An ALTER TABLE: a dropped column's privileges go with it (Postgres).
        for (const column of droppedLeadColumns(whole)) columns.delete(column);
        continue;
      }
      if (!touches.test(privileges ?? '') || !/\bauthenticated\b/i.test(roles ?? '')) continue;
      const named = (columnList ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      if (verb!.toLowerCase() === 'revoke') {
        // Revoking the table privilege revokes the column privileges too (Postgres).
        if (named.length === 0) columns = new Set();
        else for (const c of named) columns.delete(c);
      } else if (named.length === 0) {
        columns = new Set(['*']);
      } else {
        for (const c of named) columns.add(c);
      }
    }
  }
  return columns;
}
