import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The columns `authenticated` holds a privilege on in public.leads after every migration,
// replayed in order: a table-level revoke clears them, a column grant adds, and a
// table-level grant means every column ('*'). Staff tokens reach leads through column
// grants only (0030, 0033, 0041), so the specs that stand in for PostgREST read the grant
// from here instead of keeping their own copy that a later migration would outdate.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

export function replayLeadGrant(privilege: 'select' | 'update'): Set<string> {
  let columns = new Set<string>();
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const statement =
    /\b(grant|revoke)\s+([a-z_, ]+?)(?:\s*\(([^)]*)\))?\s+on\s+(?:table\s+)?public\.leads\s+(?:to|from)\s+([a-z_, ]+)/gi;
  const touches = new RegExp(`\\b(${privilege}|all)\\b`, 'i');
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const match of sql.matchAll(statement)) {
      const [, verb, privileges, columnList, roles] = match;
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
