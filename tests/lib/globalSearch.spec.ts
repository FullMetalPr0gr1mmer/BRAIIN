import { readFileSync, readdirSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { AuthContext, Role } from '@/lib/auth/types';
import {
  cleanQuery,
  escapeLike,
  logSafeError,
  MAX_QUERY_LENGTH,
  searchAdmin,
  SEARCH_TARGETS,
} from '@/lib/admin/globalSearch';

const { systemLog } = vi.hoisted(() => ({
  systemLog: vi.fn(async (_entry: Record<string, unknown>) => true),
}));
vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: systemLog }));

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

// ── searchAdmin against a stand-in database ─────────────────────────────────────────
// Every table answers one row, unless `errors` names it; `tables` records what was asked.

type DbError = { message: string; code: string };

function fakeDb(errors: Record<string, DbError> = {}) {
  const tables: string[] = [];
  const sb = {
    from(table: string) {
      tables.push(table);
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'ilike', 'limit']) builder[method] = () => builder;
      builder['then'] = (resolve: (value: unknown) => unknown) =>
        resolve(
          errors[table]
            ? { data: null, error: errors[table] }
            : { data: [{ id: `${table}-1`, slug: 'logo', title: { en: 'Logo' } }], error: null },
        );
      return builder;
    },
  };
  return { sb: sb as unknown as SupabaseClient, tables };
}

const as = (role: Role): AuthContext => ({
  userId: 'u-1',
  tenantId: 't-1',
  role,
  isActive: true,
  email: 'someone@example.com',
});

describe('a search that cannot reach an entity (DoD #6)', () => {
  beforeEach(() => systemLog.mockClear());

  it('reports the group and writes one system_logs row, without what was typed', async () => {
    const query = 'jane.doe@example.com 50%';
    const { sb } = fakeDb({
      team_members: {
        message: `"failed to parse filter (ilike.%${escapeLike(query)}%)" for ${query}`,
        code: 'PGRST100',
      },
      certifications: { message: 'operator does not exist: jsonb ~~* unknown', code: '42883' },
    });
    const outcome = await searchAdmin(sb, as('admin'), query);

    expect(outcome.failed).toEqual(['Team & authors', 'Certifications']);
    expect(outcome.groups.map((g) => g.group)).not.toContain('Team & authors');
    expect(systemLog).toHaveBeenCalledTimes(1);
    const entry = systemLog.mock.calls[0]![0];
    expect(entry).toMatchObject({ level: 'error', source: 'admin:search' });
    expect(entry['message']).toBe('Search could not query team_members, certifications');
    expect(entry['detail']).toEqual({
      role: 'admin',
      failures: [
        {
          group: 'Team & authors',
          table: 'team_members',
          code: 'PGRST100',
          error: '"failed to parse filter (ilike.[query])" for [query]',
        },
        {
          group: 'Certifications',
          table: 'certifications',
          code: '42883',
          error: 'operator does not exist: jsonb ~~* unknown',
        },
      ],
    });
    expect(JSON.stringify(entry)).not.toContain('jane');
  });

  it('writes nothing when every entity answered', async () => {
    const { sb } = fakeDb();
    const outcome = await searchAdmin(sb, as('admin'), 'logo');
    expect(outcome.failed).toEqual([]);
    expect(systemLog).not.toHaveBeenCalled();
  });
});

describe('logSafeError', () => {
  it('takes out every form of the search text, longest first', () => {
    // '100%' is sent as '%100\%%': the escaped pattern goes first, or its inner forms
    // would be cut out of it and leave a fragment of the text behind.
    const q = '100%';
    const sent = `%${escapeLike(q)}%`;
    expect(logSafeError(`bad filter (ilike.${sent}) near ${q}`, [q, escapeLike(q), sent])).toBe(
      'bad filter (ilike.[query]) near [query]',
    );
  });

  it('scrubs an e-mail or phone the database echoed from elsewhere', () => {
    expect(logSafeError('key (email)=(a@b.co) phone +966 55 123 4567', [])).toBe(
      'key (email)=([email]) phone [phone]',
    );
  });
});
