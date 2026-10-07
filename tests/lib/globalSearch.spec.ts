import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { cleanQuery, escapeLike, MAX_QUERY_LENGTH, SEARCH_TARGETS } from '@/lib/admin/globalSearch';

// Search input is an input boundary (CLAUDE.md §9e — search safety is a blocking test
// class). These pin the two transforms every query passes through before it can reach
// PostgREST: control-char stripping + length cap, and ilike-wildcard escaping.

describe('cleanQuery', () => {
  it('strips control characters, including NUL and DEL', () => {
    // Control chars built from escapes: a literal control byte in a source file
    // makes git and grep treat it as binary, which is its own bug.
    expect(cleanQuery('cof\u0000fee\u001f bea\u007fns')).toBe('coffee beans');
  });

  it('trims and caps at MAX_QUERY_LENGTH', () => {
    const long = `  ${'a'.repeat(200)}  `;
    expect(cleanQuery(long)).toHaveLength(MAX_QUERY_LENGTH);
  });

  it('keeps Arabic text intact', () => {
    expect(cleanQuery('هوية بصرية')).toBe('هوية بصرية');
  });

  it('passes a query of exactly the cap through unchanged', () => {
    const exact = 'b'.repeat(MAX_QUERY_LENGTH);
    expect(cleanQuery(exact)).toBe(exact);
  });
});

describe('escapeLike', () => {
  it('escapes %, _ and backslash so they match literally', () => {
    expect(escapeLike('100%_done\\')).toBe('100\\%\\_done\\\\');
  });

  it('a wildcard-only query cannot become match-everything', () => {
    // Unescaped, '%' alone would ilike-match every row of every searchable table.
    expect(escapeLike('%')).toBe('\\%');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLike('branding')).toBe('branding');
  });
});

// ── Every search target matches a column the database can ilike ─────────────────────
// `.ilike()` on a jsonb column is an SQL error ("operator does not exist: jsonb ~~*"),
// and searchAdmin() reports an erroring entity as "could not be searched". That is how
// Team & authors and Certifications (bilingual `name jsonb`) failed for every search
// until the Admin v2 F0 sweep opened the results page as each role. The column types
// come from the migrations, so a new target, or a column changed to jsonb, is checked
// without anyone remembering to.

/** table → column → type, from every `create table` and `add column` in the migrations. */
function columnTypes(): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>();
  const set = (table: string, column: string, type: string) => {
    if (!tables.has(table)) tables.set(table, new Map());
    tables.get(table)!.set(column, type.toLowerCase());
  };
  const dir = 'supabase/migrations';
  for (const file of readdirSync(dir).sort()) {
    const sql = readFileSync(`${dir}/${file}`, 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(
      /create table (?:if not exists )?public\.(\w+) \(([\s\S]*?)\n\);/gi,
    )) {
      for (const line of (m[2] ?? '').split('\n')) {
        const col = /^\s+(\w+)\s+(\w+)/.exec(line);
        if (col && !/^(constraint|primary|unique|check|foreign|exclude)$/i.test(col[1]!)) {
          set(m[1]!, col[1]!, col[2]!);
        }
      }
    }
    for (const m of sql.matchAll(
      /alter table (?:only )?(?:if exists )?public\.(\w+)([\s\S]*?);/gi,
    )) {
      for (const add of (m[2] ?? '').matchAll(/add column (?:if not exists )?(\w+)\s+(\w+)/gi)) {
        set(m[1]!, add[1]!, add[2]!);
      }
      for (const alt of (m[2] ?? '').matchAll(/alter column (\w+) (?:set data )?type (\w+)/gi)) {
        set(m[1]!, alt[1]!, alt[2]!);
      }
    }
  }
  return tables;
}

describe('search targets', () => {
  const types = columnTypes();

  it('reads the schema it checks against', () => {
    expect(types.get('team_members')?.get('name')).toBe('jsonb');
    expect(types.get('redirects')?.get('source_path')).toBeDefined();
  });

  it.each(SEARCH_TARGETS.map((t) => [t.group, t] as const))(
    '%s matches a text column or a jsonb ->> text path',
    (_group, target) => {
      const [base, path] = target.column.split('->>');
      const type = types.get(target.config.table)?.get(base!);
      expect(type, `${target.config.table}.${base} exists`).toBeDefined();
      if (type === 'jsonb') {
        expect(path, `${target.config.table}.${base} is jsonb: match '${base}->>en'`).toBe('en');
      } else {
        expect(path, `${target.config.table}.${base} is ${type}: no ->> path`).toBeUndefined();
        expect(['text', 'citext', 'varchar']).toContain(type);
      }
    },
  );
});

describe('what search never touches', () => {
  // Personal data has its own pages and audit trail (leads: the audited reveal; job
  // applications: Admin only, CV downloads audited). A search box is a second, wider read
  // path, so these tables are never targets, for the results page or the palette.
  it('never searches leads, contacts or job applications', () => {
    const tables = SEARCH_TARGETS.map((target) => target.config.table);
    for (const table of ['leads', 'job_applications', 'contacts', 'crm_contacts']) {
      expect(tables).not.toContain(table);
    }
  });
});
