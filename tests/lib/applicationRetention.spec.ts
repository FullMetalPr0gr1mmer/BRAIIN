import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SPAM_RETENTION_DAYS } from '@schemas/application';
import { runApplicationRetention, LIMITER_KEEP_HOURS } from '@/lib/applications/retention';
import { monthsFrom } from '@/lib/applications/create';

// The daily Join retention job: expired CVs out of Storage FIRST, then their rows; if the
// object delete fails, the rows stay for tomorrow's run (the reverse would orphan the file).

interface Fake {
  expired: { id: string; cv_path: string | null }[];
  removeFails?: boolean;
  calls: string[];
  deletedIds: string[];
  limiterCutoff?: string;
}

function client(f: Fake): SupabaseClient {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      let mode: 'select' | 'delete' = 'select';
      b['select'] = () => b;
      b['order'] = () => b;
      b['lt'] = (_col: string, v: string) => {
        if (table === 'public_write_attempts') {
          f.limiterCutoff = v;
          f.calls.push('delete-limiter');
          return Promise.resolve({ error: null, count: 3 });
        }
        return b;
      };
      b['limit'] = () => Promise.resolve({ data: f.expired, error: null });
      b['delete'] = () => {
        mode = 'delete';
        return b;
      };
      b['in'] = (_c: string, ids: string[]) => {
        if (mode === 'delete') {
          f.calls.push('delete-rows');
          f.deletedIds.push(...ids);
        }
        return Promise.resolve({ error: null, count: ids.length });
      };
      return b;
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          f.calls.push(`remove:${paths.length}`);
          return f.removeFails
            ? { data: null, error: { message: 'x' } }
            : { data: [], error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
}

describe('runApplicationRetention', () => {
  it('removes the CV objects, then the rows, then old limiter counters', async () => {
    const f: Fake = {
      expired: [
        { id: 'a', cv_path: 't/a/x.pdf' },
        { id: 'b', cv_path: null },
      ],
      calls: [],
      deletedIds: [],
    };
    const now = new Date('2026-10-01T03:23:00Z');
    const run = await runApplicationRetention(client(f), now);
    expect(f.calls).toEqual(['remove:1', 'delete-rows', 'delete-limiter']);
    expect(f.deletedIds).toEqual(['a', 'b']);
    expect(run).toEqual({
      applicationsDeleted: 2,
      cvsDeleted: 1,
      limiterRowsDeleted: 3,
      errors: [],
    });
    expect(Date.parse(f.limiterCutoff!)).toBe(now.getTime() - LIMITER_KEEP_HOURS * 3_600_000);
  });

  it('keeps the rows when the objects could not be deleted (tomorrow retries)', async () => {
    const f: Fake = {
      expired: [{ id: 'a', cv_path: 't/a/x.pdf' }],
      removeFails: true,
      calls: [],
      deletedIds: [],
    };
    const run = await runApplicationRetention(client(f));
    expect(f.deletedIds).toEqual([]);
    expect(run.errors).toContain('delete-objects');
  });

  it('nothing expired: only the limiter is swept', async () => {
    const f: Fake = { expired: [], calls: [], deletedIds: [] };
    await runApplicationRetention(client(f));
    expect(f.calls).toEqual(['delete-limiter']);
  });
});

describe('monthsFrom', () => {
  it('adds calendar months in UTC', () => {
    expect(monthsFrom(new Date('2026-09-30T10:00:00Z'), 12).toISOString()).toBe(
      '2027-09-30T10:00:00.000Z',
    );
    expect(monthsFrom(new Date('2026-09-30T10:00:00Z'), 24).toISOString()).toBe(
      '2028-09-30T10:00:00.000Z',
    );
  });
});

describe('one spam horizon', () => {
  it('the 0029 trigger caps a spam application at SPAM_RETENTION_DAYS', () => {
    // The number lives twice — in SQL (the trigger that applies it) and in the schema
    // package (the admin panel's "marking it spam deletes it within N days"). One number.
    const sql = readFileSync('supabase/migrations/0029_job_applications.sql', 'utf8');
    const trigger = sql.slice(sql.indexOf('tg_job_application_spam_retention'));
    const days = /now\(\) \+ interval '(\d+) days'/.exec(trigger)?.[1];
    expect(Number(days)).toBe(SPAM_RETENTION_DAYS);
  });
});
