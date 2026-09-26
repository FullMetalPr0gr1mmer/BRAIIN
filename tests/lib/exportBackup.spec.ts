import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BACKUP_TABLES, FORBIDDEN_BACKUP_TABLES } from '@/lib/admin/backupTables';

// `export.backup` is held by Developer, who must never reach leads, job applications or
// consent records (§5, UI v2 decision 4). The backup list is checked against a list of
// tables that may never appear, and every column it names against the migrations — a
// column the database does not have makes that table's dump fail at runtime ("partial").

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const SQL = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
  .join('\n')
  .toLowerCase();

describe('content backup', () => {
  it('never lists a forbidden table', () => {
    const tables = BACKUP_TABLES.map((t) => t.table);
    for (const forbidden of FORBIDDEN_BACKUP_TABLES) expect(tables).not.toContain(forbidden);
  });

  it('dumps no column that looks like personal or secret data', () => {
    const suspicious = /(^|_)(email|phone|ip_inet|budget|internal_notes)$|_enc$|password|token/;
    for (const { table, columns } of BACKUP_TABLES) {
      for (const column of columns.split(',')) {
        // site_profile's contact_email is the studio's PUBLIC address, rendered on every page.
        if (table === 'site_profile' && column === 'contact_email') continue;
        expect(column, `${table}.${column}`).not.toMatch(suspicious);
      }
    }
  });

  it('names only columns some migration creates', () => {
    for (const { table, columns } of BACKUP_TABLES) {
      expect(SQL, `table ${table}`).toMatch(
        new RegExp(`table (if not exists )?public\\.${table}\\b`),
      );
      for (const column of columns.split(',')) {
        // A column appears as its own identifier in a CREATE TABLE or ADD COLUMN.
        expect(SQL, `${table}.${column}`).toMatch(new RegExp(`\\b${column}\\b`));
      }
    }
  });
});
