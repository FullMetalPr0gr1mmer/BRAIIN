import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  TEAM_NOTES_MAX,
  TEAM_NOTE_CONTROL,
  TEAM_NOTE_EMAIL,
  TEAM_NOTE_MESSAGES,
  TEAM_NOTE_PHONE,
  TeamNotesPutSchema,
  teamNoteProblem,
  trimNote,
} from '@schemas/dashboard';
import type { AuthContext } from '@/lib/auth/types';
import { AuthorizationError } from '@/lib/authz/errors';
import { OptimisticLockError, ValidationError } from '@/lib/admin/errors';
import { saveTeamNotes } from '@/lib/admin/dashboard/teamNotes';

// Team notes (Admin v2 U1, README U1 D5): "no client contact details" is enforced twice, by the
// Worker's schema (packages/schemas/dashboard.ts) and by the database (app.team_note_problem,
// 0060). The two must refuse the same texts: here the schema's rule runs over the table of
// inputs supabase/tests/dashboard_layer.test.sql runs the SQL over (one table, both sides),
// the SQL's control-and-format class is compared with the schema's code point by code point,
// and the e-mail and phone patterns are the same text in both.

const MIGRATION = readFileSync('supabase/migrations/0060_dashboard_layer.sql', 'utf8');
const PGTAP = readFileSync('supabase/tests/dashboard_layer.test.sql', 'utf8');

/** A Postgres E'…' string's value: \uXXXX, \n, \t, \r and '' are what the table uses. */
function eString(body: string): string {
  return body
    .replace(/''/g, "'")
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r');
}

/** The shared table: each row's input and the refusal it must get (null: none). */
function sharedTable(): [string, string | null][] {
  const block = /-- team-note-table:begin([\s\S]*?)-- team-note-table:end/.exec(PGTAP)?.[1] ?? '';
  const rows = [...block.matchAll(/\(E'((?:[^']|'')*)', (null|'([a-z_]+)')\)/g)];
  return rows.map((m) => [eString(m[1] ?? ''), m[3] ?? null]);
}

describe('the Worker and the database refuse the same notes', () => {
  const table = sharedTable();

  it('reads the shared table (the check is not vacuous)', () => {
    expect(table.length).toBeGreaterThanOrEqual(20);
    expect(table.some(([, want]) => want === 'team_notes_contact')).toBe(true);
    expect(table.some(([, want]) => want === 'team_notes_chars')).toBe(true);
    expect(table.some(([, want]) => want === null)).toBe(true);
    // Both Arabic digit sets are in it.
    expect(table.some(([input]) => /[٠-٩]/.test(input))).toBe(true);
    expect(table.some(([input]) => /[۰-۹]/.test(input))).toBe(true);
  });

  it.each(sharedTable())('%j → %s', (input, want) => {
    expect(teamNoteProblem(input)).toBe(want);
    const parsed = TeamNotesPutSchema.safeParse({ version: 1, body: input });
    expect(parsed.success).toBe(want === null);
  });

  it('the e-mail and phone patterns are the same text in both', () => {
    const problem = MIGRATION.slice(
      MIGRATION.indexOf('create or replace function app.team_note_problem'),
      MIGRATION.indexOf('create or replace function app.team_note_ok'),
    );
    const patterns = [...problem.matchAll(/when p ~ '([^']+)'/g)].map((m) => m[1]);
    expect(patterns).toHaveLength(3);
    expect(patterns[1]).toBe(TEAM_NOTE_EMAIL.source);
    expect(patterns[2]).toBe(TEAM_NOTE_PHONE.source);
  });

  it('refuses exactly the control and format characters the schema refuses', () => {
    const source = /when p ~ '\[([^'\]]*)\]'/.exec(MIGRATION)?.[1] ?? '';
    const escape = String.raw`\\u([0-9A-F]{4})|\\U([0-9A-F]{8})`;
    const item = new RegExp(`(?:${escape})(?:-(?:${escape}))?`, 'gy');
    const ranges: [number, number][] = [];
    let consumed = 0;
    for (const m of source.matchAll(item)) {
      const from = parseInt(m[1] ?? m[2] ?? '', 16);
      const end = m[3] ?? m[4];
      ranges.push([from, end ? parseInt(end, 16) : from]);
      consumed += m[0].length;
    }
    expect(consumed, 'every character of the SQL class is an escape or a range').toBe(source.length);
    const mismatches: string[] = [];
    // From 1: NUL cannot reach a text value. Surrogates are not characters.
    for (let cp = 1; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const sql = ranges.some(([a, b]) => cp >= a && cp <= b);
      const js = TEAM_NOTE_CONTROL.test(String.fromCodePoint(cp));
      if (sql !== js) mismatches.push(cp.toString(16));
    }
    // Tab and line feed pass both; a new Unicode format character fails here: add it.
    expect(mismatches).toEqual([]);
    expect(TEAM_NOTE_CONTROL.test('\t') || TEAM_NOTE_CONTROL.test('\n')).toBe(false);
  });

  it('trims what the definer trims, and counts the length as it does (code points)', () => {
    expect(MIGRATION).toContain(
      "v_body := pg_catalog.regexp_replace(coalesce(p_body, ''), '[ \\t\\n\\v\\f\\r]+$', '');",
    );
    expect(trimNote('Note  \n\t \r\n')).toBe('Note');
    expect(trimNote('  kept in front')).toBe('  kept in front');
    expect(MIGRATION).toContain(`char_length(body) <= ${TEAM_NOTES_MAX}`);
    expect(MIGRATION).toContain(`if pg_catalog.char_length(v_body) > ${TEAM_NOTES_MAX} then`);
    expect(teamNoteProblem('x'.repeat(TEAM_NOTES_MAX))).toBeNull();
    expect(teamNoteProblem('x'.repeat(TEAM_NOTES_MAX + 1))).toBe('team_notes_length');
    // An astral character is one, as char_length counts it (two UTF-16 units in JS).
    expect(teamNoteProblem('😀'.repeat(TEAM_NOTES_MAX))).toBeNull();
    expect(TeamNotesPutSchema.parse({ version: 0, body: 'Hi \n' }).body).toBe('Hi');
  });
});

describe('the door’s refusals become the route’s answers', () => {
  const auth: AuthContext = {
    userId: 'u-1',
    tenantId: 't-1',
    role: 'seo',
    isActive: true,
    email: 'eli@example.test',
  };
  const db = (error: { code: string; message: string } | null, data: unknown = null) => {
    const calls: { fn: string; args: unknown }[] = [];
    const sb = {
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn, args });
        return { data, error };
      },
    } as unknown as SupabaseClient;
    return { sb, calls };
  };

  it('saves through save_team_notes for the session’s tenant, with the version read', async () => {
    const { sb, calls } = db(null, { version: 5, updated_at: '2026-10-16T09:00:00Z' });
    const saved = await saveTeamNotes(sb, auth, 'Shoot moved.', 4);
    expect(calls).toEqual([
      { fn: 'save_team_notes', args: { p_tenant: 't-1', p_body: 'Shoot moved.', p_version: 4 } },
    ]);
    expect(saved).toMatchObject({ body: 'Shoot moved.', version: 5, updatedAt: '2026-10-16T09:00:00Z' });
  });

  it.each([
    ['40001', 'team_notes: someone else saved first', OptimisticLockError],
    ['42501', 'save_team_notes: not allowed', AuthorizationError],
    ['22023', 'team_notes_contact', ValidationError],
  ] as const)('%s → %s', async (code, message, kind) => {
    const { sb } = db({ code, message });
    await expect(saveTeamNotes(sb, auth, 'x', 1)).rejects.toBeInstanceOf(kind);
  });

  it('a 22023 says the rule’s own sentence on the field', async () => {
    const { sb } = db({ code: '22023', message: 'team_notes_contact' });
    const err = await saveTeamNotes(sb, auth, 'x', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).field).toBe('body');
    expect((err as ValidationError).detail).toBe(TEAM_NOTE_MESSAGES.team_notes_contact);
  });
});
