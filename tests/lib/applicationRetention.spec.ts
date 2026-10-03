import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SPAM_RETENTION_DAYS } from '@schemas/application';
import {
  runApplicationRetention,
  LIMITER_KEEP_HOURS,
  ORPHAN_GRACE_MINUTES,
} from '@/lib/applications/retention';
import { monthsFrom } from '@/lib/applications/create';

// The daily Join retention job: expired CVs out of Storage FIRST, then their rows; if the
// object delete fails, the rows stay for tomorrow's run (the reverse would orphan the file).
// Then the orphan sweep: objects no row names, older than the grace period.

interface Fake {
  expired: { id: string; cv_path: string | null }[];
  orphans?: string[];
  orphanError?: boolean;
  removeFails?: boolean;
  calls: string[];
  removed: string[][];
  deletedIds: string[];
  orphanArgs?: Record<string, unknown>;
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
    rpc: async (fn: string, args: Record<string, unknown>) => {
      f.calls.push(fn);
      f.orphanArgs = args;
      return f.orphanError
        ? { data: null, error: { message: 'x' } }
        : { data: (f.orphans ?? []).map((object_name) => ({ object_name })), error: null };
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          f.calls.push(`remove:${paths.length}`);
          f.removed.push(paths);
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
      removed: [],
      deletedIds: [],
    };
    const now = new Date('2026-10-01T03:23:00Z');
    const run = await runApplicationRetention(client(f), now);
    expect(f.calls).toEqual([
      'remove:1',
      'delete-rows',
      'application_orphan_cvs',
      'delete-limiter',
    ]);
    expect(f.deletedIds).toEqual(['a', 'b']);
    expect(run).toEqual({
      applicationsDeleted: 2,
      cvsDeleted: 1,
      orphansDeleted: 0,
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
      removed: [],
      deletedIds: [],
    };
    const run = await runApplicationRetention(client(f));
    expect(f.deletedIds).toEqual([]);
    expect(run.errors).toContain('delete-objects');
  });

  it('nothing expired: the orphan sweep and the limiter still run', async () => {
    const f: Fake = { expired: [], calls: [], removed: [], deletedIds: [] };
    await runApplicationRetention(client(f));
    expect(f.calls).toEqual(['application_orphan_cvs', 'delete-limiter']);
  });

  it('deletes CV objects no row names, after the grace period', async () => {
    const f: Fake = {
      expired: [],
      orphans: ['t/x/1.pdf', 't/y/2.docx'],
      calls: [],
      removed: [],
      deletedIds: [],
    };
    const run = await runApplicationRetention(client(f));
    expect(f.orphanArgs).toEqual({ p_older_than_minutes: ORPHAN_GRACE_MINUTES, p_limit: 200 });
    expect(ORPHAN_GRACE_MINUTES).toBeGreaterThanOrEqual(60);
    expect(f.removed).toEqual([['t/x/1.pdf', 't/y/2.docx']]);
    expect(run.orphansDeleted).toBe(2);
    expect(f.deletedIds).toEqual([]);
  });

  it('an unreachable sweep or a failed delete is reported, and the rest of the job runs', async () => {
    const down: Fake = { expired: [], orphanError: true, calls: [], removed: [], deletedIds: [] };
    expect((await runApplicationRetention(client(down))).errors).toEqual(['select-orphans']);
    expect(down.calls).toContain('delete-limiter');
    const stuck: Fake = {
      expired: [],
      orphans: ['t/x/1.pdf'],
      removeFails: true,
      calls: [],
      removed: [],
      deletedIds: [],
    };
    const run = await runApplicationRetention(client(stuck));
    expect(run.errors).toEqual(['delete-orphans']);
    expect(run.orphansDeleted).toBe(0);
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
