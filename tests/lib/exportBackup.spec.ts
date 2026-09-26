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
  .toLowerCase()
  .replace(/--[^\n]*/g, ''); // comments are not schema

/**
 * The columns a table has after every migration: its CREATE TABLE body, plus each
 * `alter table … add / rename / drop column`. Per table — a column name that merely appears
 * somewhere else (profiles.role) must not satisfy statistics.role.
 */
function columnsOf(table: string): Set<string> {
  const cols = new Set<string>();
  const create = new RegExp(`create table (?:if not exists )?public\\.${table}\\s*\\(`, 'g');
  for (const m of SQL.matchAll(create)) {
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    let depth = 1;
    while (depth > 0 && i < SQL.length) {
      if (SQL[i] === '(') depth += 1;
      else if (SQL[i] === ')') depth -= 1;
      i += 1;
    }
    let d = 0;
    let current = '';
    for (const ch of `${SQL.slice(start, i - 1)},`) {
      if (ch === '(') d += 1;
      else if (ch === ')') d -= 1;
      if (ch === ',' && d === 0) {
        const word = current.trim().split(/\s+/)[0];
        if (word) cols.add(word.replace(/"/g, ''));
        current = '';
      } else {
        current += ch;
      }
    }
  }
  const alter = new RegExp(
    `alter table (?:if exists )?(?:only )?public\\.${table}\\b([^;]*);`,
    'g',
  );
  for (const m of SQL.matchAll(alter)) {
    const body = m[1] ?? '';
    for (const a of body.matchAll(/add column (?:if not exists )?([a-z_0-9]+)/g)) cols.add(a[1]!);
    for (const r of body.matchAll(/rename column ([a-z_0-9]+) to ([a-z_0-9]+)/g)) {
      cols.delete(r[1]!);
      cols.add(r[2]!);
    }
    for (const x of body.matchAll(/drop column (?:if exists )?([a-z_0-9]+)/g)) cols.delete(x[1]!);
  }
  return cols;
}

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

  it('names only columns its own table has (else that table is silently missing from every backup)', () => {
    for (const { table, columns } of BACKUP_TABLES) {
      const have = columnsOf(table);
      expect(have.size, `table ${table}`).toBeGreaterThan(0);
      for (const column of columns.split(',')) {
        expect(have.has(column), `${table}.${column}`).toBe(true);
      }
    }
  });

  it('the column check is not vacuous: a column of another table does not count', () => {
    expect(columnsOf('statistics').has('role')).toBe(false); // profiles.role exists
    expect(columnsOf('statistics').has('value_numeric')).toBe(true); // added by 0023
  });

  it("never dumps where a quote's consent record is kept", () => {
    const quotes = BACKUP_TABLES.find((t) => t.table === 'testimonials');
    expect(quotes?.columns.split(',')).toContain('consent_obtained_at');
    expect(quotes?.columns.split(',')).not.toContain('consent_reference');
  });
});
