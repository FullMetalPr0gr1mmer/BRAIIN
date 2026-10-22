import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RELEASE_CLAIM_LEASE_MINUTES,
  RELEASE_CLAIM_LIMIT,
  RELEASE_ORPHAN_AFTER_MINUTES,
} from '@/lib/cron/releases';
import { CACHE_PURGE_DAY_TAGS, CACHE_PURGE_MAX_TAGS, PURGE_SOURCES } from '@/lib/http/purge';
import { RELEASE_PURGE_MAX_ATTEMPTS } from '@/lib/release/afterEffects';
import {
  RELEASE_READ_IDS_MAX,
  RELEASE_READ_TOTAL_IDS_MAX,
  RELEASE_READS_MAX,
  RELEASE_SINGLETON_TABLES,
} from '@/lib/release/overlayDb';

// The literals the R7 migration holds (the purge ledger's budget, the minute cron's claim, the
// batched read for O-16) equal the Worker's constants, so neither side can move alone; and its
// functions set no setting, no role and never name the release token (R4's catalog rule:
// apply_release alone sets claims). The migration's number is assigned at merge, so it is
// found by its name.

const DIR = 'supabase/migrations';
const file = readdirSync(DIR).find((name) => /^\d{4}_release_purge_cron\.sql$/.test(name));
const sql = file ? readFileSync(`${DIR}/${file}`, 'utf8') : '';

/** The body of one function, from its CREATE to the end of its dollar quote. */
function fn(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$$', start);
  return sql.slice(start, sql.indexOf('$$', open + 2) + 2);
}

describe('the R7 migration', () => {
  it('exists, once', () => {
    expect(readdirSync(DIR).filter((n) => n.endsWith('_release_purge_cron.sql'))).toHaveLength(1);
  });

  it('the ledger: 1 to 30 tags a request, the sources the Worker sends', () => {
    expect(sql).toContain(`check (tag_count between 1 and ${CACHE_PURGE_MAX_TAGS})`);
    const list = PURGE_SOURCES.map((s) => `'${s}'`).join(', ');
    expect(sql).toContain(`check (source in (${list}))`);
    expect(fn('cache_purge_take')).toContain(`p_source not in (${list})`);
  });

  it('the budget: 30,000 tags in 24 hours, the ledger kept 48 hours', () => {
    const body = fn('cache_purge_take');
    expect(body).toContain(`p_tags > ${CACHE_PURGE_MAX_TAGS}`);
    expect(body).toContain(`v_used + p_tags > ${CACHE_PURGE_DAY_TAGS}`);
    expect(body).toContain(`interval '24 hours'`);
    expect(body).toContain(`interval '48 hours'`);
    expect(body).toContain('pg_advisory_xact_lock');
  });

  it('the claim: 10 attempts, an orphan after 2 minutes, a 5-minute lease, the limit allowed', () => {
    const body = fn('claim_release_purges');
    expect(
      body.match(new RegExp(`purge_attempts < ${RELEASE_PURGE_MAX_ATTEMPTS}\\b`, 'g')),
    ).toHaveLength(2);
    expect(body).toContain(`interval '${RELEASE_ORPHAN_AFTER_MINUTES} minutes'`);
    expect(body).toContain(`now() + interval '${RELEASE_CLAIM_LEASE_MINUTES} minutes'`);
    expect(body).toContain('skip locked');
    expect(body).toContain(`r.kind <> 'baseline'`);
    const max = Number(/p_limit > (\d+)/.exec(body)?.[1]);
    expect(RELEASE_CLAIM_LIMIT).toBeGreaterThanOrEqual(1);
    expect(RELEASE_CLAIM_LIMIT).toBeLessThanOrEqual(max);
  });

  it('the batched read: 40 reads of 500 ids, 2,000 ids in all, as the Worker splits them', () => {
    const body = fn('release_read_rows');
    expect(body).toContain(`jsonb_array_length(p_reads) > ${RELEASE_READS_MAX}`);
    expect(body).toContain(`jsonb_array_length(v_read -> 'ids') > ${RELEASE_READ_IDS_MAX}`);
    expect(body).toContain(`c_total_ids constant int := ${RELEASE_READ_TOTAL_IDS_MAX};`);
    expect(body).toMatch(/\) > c_total_ids then/);
    expect(body).toContain('security invoker');
    expect(body).toContain('app.is_staff()');
  });

  it('the batched read keys by tenant_id only a table the registry keys by its tenant', () => {
    // The Worker sends a tenant-keyed read only for RELEASE_SINGLETON_TABLES (held equal to the
    // registry in overlayDb.spec); the database refuses it for every other table, media_assets
    // included, so no read is a whole table.
    const body = fn('release_read_rows');
    expect(body).toMatch(
      /v_key = 'tenant_id'\s+and not exists \(select 1 from app\.release_entities e\s+where e\.table_name = v_table and e\.key_column = 'tenant_id'\)/,
    );
    expect(RELEASE_SINGLETON_TABLES.length).toBeGreaterThan(0);
  });

  it('names this spec as the one holding its literals equal (no other reads the migration)', () => {
    const named = [
      ...sql.matchAll(/tests\/lib\/([\w.]+)\.spec\.ts\s+(?:--\s+)?holds (?:them|the literals)/g),
    ].map((m) => m[1]);
    expect(named.length).toBeGreaterThanOrEqual(3);
    expect([...new Set(named)]).toEqual(['purgeCronSql']);
  });

  it('no function of it sets a setting or a role, or names the release token', () => {
    for (const name of ['cache_purge_take', 'claim_release_purges', 'release_read_rows']) {
      const body = fn(name).toLowerCase();
      expect(body, name).not.toMatch(/set_config|app\.release_apply|set\s+(local\s+)?role/);
    }
  });
});
