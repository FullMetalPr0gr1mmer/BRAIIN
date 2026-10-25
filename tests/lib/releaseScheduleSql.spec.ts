import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RELEASE_FAILURE_CODES,
  RELEASE_SCHEDULE_MAX_DAYS,
  RELEASE_SCHEDULE_MIN_MINUTES,
} from '@schemas/release';
import { RELEASE_FIRE_LEASE_MINUTES, RELEASE_FIRE_LIMIT } from '@/lib/cron/releases';

// What can be checked about R11's migration (scheduled releases and the two switches) without a
// database: its functions' settings and shape, and the literals the Worker holds too. pgTAP
// proves the behaviour in CI (supabase/tests/release_schedule.test.sql); this pins how the
// statements are built, so a later edit cannot quietly widen who calls a function, splice a value
// into SQL, or let the switches' table list drift from app.publish_scheduled()'s.

const DIR = join(process.cwd(), 'supabase', 'migrations');
const load = (file: string) => readFileSync(join(DIR, file), 'utf8').replace(/--[^\n]*/g, '');
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

/** The migration that adds the schedule functions (0107 until it is renumbered at merge). */
const R11 = FILES.find((f) => load(f).includes('create or replace function app.enable_releases('));
const SQL = load(R11 ?? '');

function bodyOf(text: string, name: string): string {
  const start = text.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const open = text.indexOf('$$', start);
  return text.slice(open + 2, text.indexOf('$$;', open + 2));
}
function headerOf(text: string, name: string): string {
  const start = text.indexOf(`create or replace function ${name}(`);
  return text.slice(start, text.indexOf('$$', start));
}

const SERVICE_FNS = [
  'public.claim_scheduled_releases',
  'public.fail_scheduled_release',
  'public.reschedule_release',
  'public.unschedule_release',
];
const OWNER_FNS = ['app.enable_releases', 'app.disable_releases'];

describe('the migration', () => {
  it('exists, and sets its lock timeout before any other statement', () => {
    expect(R11).toBeDefined();
    expect(SQL.trimStart().startsWith("set local lock_timeout = '5s';")).toBe(true);
  });
});

describe.each([...SERVICE_FNS, ...OWNER_FNS])('%s', (name) => {
  const head = headerOf(SQL, name);
  const fn = bodyOf(SQL, name);

  it('is SECURITY INVOKER with an empty search_path and its lock waits bounded', () => {
    expect(head).toMatch(/language plpgsql volatile security invoker set search_path = ''/);
    expect(head).toContain("set lock_timeout = '5s'");
    expect(head).not.toMatch(/security definer/);
  });

  it('sets no setting, switches no role and never names the release token (R4, R5)', () => {
    expect(fn).not.toMatch(/set_config/i);
    expect(fn).not.toMatch(/app\.release_apply/);
    expect(fn).not.toMatch(/set\s+(local|session)\s+role\b/i);
    expect(fn).not.toMatch(/\bset\s+role\s+(?!=)/i);
  });

  it('builds every dynamic statement with format() and %I/%L only, values bound', () => {
    for (const m of fn.matchAll(/\bexecute\s+([^;]+);/g)) {
      const target = m[1]!.trim();
      expect(target.startsWith('pg_catalog.format('), target).toBe(true);
      // The template's placeholders: identifiers and literals only, never %s.
      const template = target.slice(0, target.indexOf(', v_'));
      expect(template, target).not.toMatch(/%s/);
      expect(target, target).not.toMatch(/\|\|/);
    }
  });

  it('is revoked from every API role, then granted as stated', () => {
    const sig = new RegExp(
      String.raw`revoke all on function ${name.replace('.', String.raw`\.`)}\(`,
    );
    expect(SQL).toMatch(sig);
    const grants = [
      ...SQL.matchAll(
        new RegExp(
          String.raw`grant execute on function ${name.replace('.', String.raw`\.`)}\([^)]*\)\s+to (\w+)`,
          'g',
        ),
      ),
    ].map((g) => g[1]);
    expect(grants).toEqual(OWNER_FNS.includes(name) ? [] : ['service_role']);
  });
});

describe('the service-role functions', () => {
  it('refuse every caller but the service role, first', () => {
    for (const name of SERVICE_FNS) {
      const fn = bodyOf(SQL, name);
      const first = fn.indexOf('if ');
      expect(fn.slice(first, fn.indexOf('end if;', first)), name).toMatch(
        /current_user::text <> 'service_role'/,
      );
    }
  });

  it('a move and a cancel take the tenant from the person’s live profile and the tenant’s release lock', () => {
    for (const name of ['public.reschedule_release', 'public.unschedule_release']) {
      const fn = bodyOf(SQL, name);
      expect(fn, name).toMatch(
        /select p\.tenant_id into v_tenant\s+from public\.profiles p\s+where p\.id = p_actor and p\.is_active/,
      );
      expect(fn, name).toContain(
        "pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('release:' || v_tenant::text, 0))",
      );
      // Each change's author roles, and delete roles for a removal or an archive.
      expect(fn, name).toMatch(/p_role <> all \(e\.author_roles\)/);
      expect(fn, name).toMatch(/p_role <> all \(e\.delete_roles\)/);
      expect(fn, name).toContain('insert into public.audit_log');
    }
  });

  it('a failure leaves a release that is no longer scheduled or no longer due (moved since its claim)', () => {
    const fn = bodyOf(SQL, 'public.fail_scheduled_release');
    expect(fn).toContain('select r.status, r.scheduled_for into v_status, v_at');
    expect(fn).toMatch(/if v_status <> 'scheduled' or v_at > pg_catalog\.now\(\) then\s+return/);
    expect(fn.indexOf('v_at > pg_catalog.now()')).toBeLessThan(
      fn.indexOf('update public.content_drafts'),
    );
  });

  it('the failure codes are RELEASE_FAILURE_CODES', () => {
    const fn = bodyOf(SQL, 'public.fail_scheduled_release');
    const list = /p_code not in \(([^)]*)\)/.exec(fn)?.[1] ?? '';
    expect([...list.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...RELEASE_FAILURE_CODES]);
  });

  it('the claim’s lease and limit are the Worker’s', () => {
    const fn = bodyOf(SQL, 'public.claim_scheduled_releases');
    expect(fn).toContain(`pg_catalog.now() + interval '${RELEASE_FIRE_LEASE_MINUTES} minutes'`);
    expect(fn).toMatch(/for update of r skip locked/);
    expect(Number(/p_limit > (\d+)/.exec(fn)?.[1])).toBeGreaterThanOrEqual(RELEASE_FIRE_LIMIT);
    // What the Worker re-checks, never a patch's values.
    expect(fn).toContain("'status', x.value -> 'patch' ->> 'status'");
    expect(fn).not.toMatch(/'patch', x\.value -> 'patch'/);
  });
});

describe('the schedule bounds', () => {
  it('the database refuses outside one minute to RELEASE_SCHEDULE_MAX_DAYS; the Worker is tighter', () => {
    const apply = bodyOf(SQL, 'public.apply_release');
    const move = bodyOf(SQL, 'public.reschedule_release');
    for (const fn of [apply, move]) {
      expect(fn).toContain("pg_catalog.now() + interval '1 minute'");
      expect(fn).toContain(`pg_catalog.now() + interval '${RELEASE_SCHEDULE_MAX_DAYS} days'`);
    }
    expect(RELEASE_SCHEDULE_MIN_MINUTES).toBeGreaterThan(1);
  });
});

describe('the two switches', () => {
  it('are the owner’s alone: no API role, no switched role, no role claim', () => {
    for (const name of OWNER_FNS) {
      const fn = bodyOf(SQL, name);
      expect(fn, name).toMatch(
        /current_user::text in \('anon', 'authenticated', 'service_role'\)\s+or pg_catalog\.current_setting\('role'\) <> 'none'\s+or \(v_claims ->> 'role'\) is not null\s+or \(v_claims #>> '\{app_metadata,role\}'\) is not null/,
      );
    }
  });

  it('are refused while a release is publishing: the apply’s lock, without waiting', () => {
    for (const name of OWNER_FNS) {
      expect(bodyOf(SQL, name), name).toContain(
        "if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('release:' || p_tenant::text, 0)) then",
      );
    }
    // The key the apply takes.
    expect(bodyOf(SQL, 'public.apply_release')).toContain(
      "pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('release:' || v_tenant::text, 0))",
    );
  });

  it('enable converts exactly the tables the latest app.publish_scheduled() publishes', () => {
    const latest = [...FILES]
      .reverse()
      .map(load)
      .find((text) => text.includes('create or replace function app.publish_scheduled('));
    const publish = bodyOf(latest!, 'app.publish_scheduled');
    const theirs = /foreach t in array array\[([^\]]*)\]/.exec(publish)?.[1] ?? '';
    const ours = /c_tables constant text\[\] := array\[([^\]]*)\]/.exec(
      bodyOf(SQL, 'app.enable_releases'),
    )?.[1];
    const names = (list: string) => [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(names(ours ?? '')).toEqual(names(theirs));
    expect(names(theirs).length).toBeGreaterThan(0);
  });

  it('enable converts exactly the rows app.publish_scheduled() publishes: scheduled, with a time', () => {
    const latest = [...FILES]
      .reverse()
      .map(load)
      .find((text) => text.includes('create or replace function app.publish_scheduled('));
    expect(bodyOf(latest!, 'app.publish_scheduled')).toContain(
      "where status = ''scheduled'' and scheduled_for is not null",
    );
    const fn = bodyOf(SQL, 'app.enable_releases');
    // The read and the move to draft both name the time; a timeless row is only counted.
    expect(fn.match(/t\.status = ''scheduled'' and t\.scheduled_for is not null/g)).toHaveLength(2);
    expect(fn).toMatch(/t\.status = ''scheduled'' and t\.scheduled_for is null/);
    expect(fn).not.toMatch(/coalesce\(t\.scheduled_for/);
  });

  it('disable needs the discard named when anything is pending, and holds the draft writes while it counts', () => {
    const fn = bodyOf(SQL, 'app.disable_releases');
    expect(headerOf(SQL, 'app.disable_releases')).toContain(
      'p_discard_pending boolean default false',
    );
    expect(fn).toMatch(/if \(v_pending > 0 or v_scheduled > 0\) and not p_discard_pending then/);
    expect(fn.indexOf('lock table public.content_drafts in share row exclusive mode')).toBeLessThan(
      fn.indexOf('select count(*)::int into v_pending'),
    );
    // The flag goes before anything is put back or thrown away.
    expect(fn.indexOf('delete from app.release_tenants')).toBeLessThan(
      fn.indexOf("set status = ''scheduled''"),
    );
  });

  it('both write their audit row naming the operator', () => {
    expect(bodyOf(SQL, 'app.enable_releases')).toMatch(/'releases\.enable'/);
    expect(bodyOf(SQL, 'app.disable_releases')).toMatch(/'releases\.disable'/);
  });
});
