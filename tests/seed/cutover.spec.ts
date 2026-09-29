import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate } from '../../scripts/gen-seeds.mjs';
import * as C from '../../scripts/round2-cutover.mjs';
import { RENAMED_SERVICE_SLUGS, renamedServiceSlug } from '@/lib/services/retired';

// supabase/seeds/round2-cutover.sql — the Round 2 production data move (runbook §6d) — is
// GENERATED from the same seed data as production.sql. These tests make that true (a hand
// edit, or a seed change without regenerating, fails here) and pin the properties the
// runbook relies on: each writing step is ONE transaction that asserts exact slug sets
// before it commits, the rehearsal writes nothing, and the read-only steps are read-only.

type Cut = {
  OUTPUT: string;
  STEPS: string[];
  RENAMES: { from: string; to: string; titles: string[] }[];
  KEPT: string[];
  ARCHIVE: string[];
  OVERRIDE_REASON: string;
  OVERRIDE_TABLES: string[];
  generateCutover: () => string;
  stepSql: (name: string, text?: string) => string;
};
const cut = C as unknown as Cut;
const sql = cut.generateCutover();
const step = (name: string) => cut.stepSql(name, sql);

describe('the committed cut-over SQL', () => {
  it('is exactly what the generator produces (no hand edits, not stale)', () => {
    expect(readFileSync(cut.OUTPUT, 'utf8')).toBe(sql);
  });

  it('is regenerated with the seeds (npm run seed:gen runs both generators)', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['seed:gen']).toContain('scripts/gen-seeds.mjs');
    expect(pkg.scripts['seed:gen']).toContain('scripts/round2-cutover.mjs');
  });

  it('has every step, in the runbook order, and prints one on request', () => {
    expect(cut.STEPS).toEqual(['preflight', 'renames', 'rehearse', 'content', 'samples', 'verify']);
    let at = -1;
    for (const name of cut.STEPS) {
      const i = sql.indexOf(`step: ${name} ═`);
      expect(i, name).toBeGreaterThan(at);
      at = i;
      expect(step(name).length, name).toBeGreaterThan(100);
    }
    expect(() => cut.stepSql('everything', sql)).toThrow();
  });
});

describe('each step does only what it says', () => {
  const WRITES = /\b(insert\s+into|update\s+public\.|delete\s+from|truncate)\b/i;

  it('preflight and verify are read-only', () => {
    for (const name of ['preflight', 'verify']) {
      expect(step(name), name).not.toMatch(WRITES);
      expect(step(name), name).not.toMatch(/^\s*(begin|commit);/im);
    }
  });

  it('every writing step is ONE transaction that asserts before it commits', () => {
    for (const name of ['renames', 'content', 'samples']) {
      const s = step(name);
      expect(s.match(/^begin;$/gm), name).toHaveLength(1);
      expect(s.match(/^commit;$/gm), name).toHaveLength(1);
      expect(s.indexOf('begin;'), name).toBeLessThan(s.indexOf('raise exception'));
      // the last assertion comes before the commit, so a mismatch rolls the step back
      expect(s.lastIndexOf('raise exception'), name).toBeLessThan(s.lastIndexOf('commit;'));
      expect(s.match(/raise exception/g)!.length, name).toBeGreaterThanOrEqual(4);
    }
  });

  it('the rehearsal is production.sql, statement for statement, rolled back', () => {
    const s = step('rehearse');
    const full = generate('production');
    const body = full.slice(full.indexOf('\nbegin;\n') + 8, full.lastIndexOf('\ncommit;')).trim();
    expect(s).toContain(body);
    expect(s.trimEnd().endsWith('rollback;')).toBe(true);
    expect(s).not.toMatch(/^commit;$/m);
    expect(s).toContain('as this_round');
  });
});

describe('the renames (plan step 2)', () => {
  const s = step('renames');

  it('compare-and-set on slug and current title, never onto an existing slug, one row each', () => {
    expect(cut.RENAMES.map((r) => `${r.from}→${r.to}`)).toEqual([
      'animations→animation',
      'videography→photo-video',
      'montage→video-editing',
      'music→music-vo-sfx',
    ]);
    for (const r of cut.RENAMES) {
      const at = s.indexOf(`slug = '${r.to}'\n   where`);
      expect(at, r.from).toBeGreaterThan(-1);
      const stmt = s.slice(at, s.indexOf('end if;', at));
      expect(stmt).toContain(`and slug = '${r.from}'`);
      expect(stmt).toContain(`title ->> 'en' in (${r.titles.map((t) => `'${t}'`).join(', ')})`);
      expect(stmt).toContain(`not exists (select 1 from public.services`);
      expect(stmt).toContain('if n <> 1 then');
    }
  });

  it('is the same four renames the lead path converts (src/lib/services/retired.ts)', () => {
    // One truth: the cut-over's RENAMES and the code's rename map (Round 3 lead labels).
    expect(Object.keys(RENAMED_SERVICE_SLUGS)).toEqual(cut.RENAMES.map((r) => r.from));
    for (const r of cut.RENAMES) {
      expect(renamedServiceSlug(r.from), r.from).toBe(r.to);
      // the old EN title the label shows is one the cut-over's compare-and-set matched on
      expect(r.titles, r.from).toContain(RENAMED_SERVICE_SLUGS[r.from]?.en);
    }
    for (const slug of cut.ARCHIVE) expect(renamedServiceSlug(slug), slug).toBeNull();
  });

  it('archives exactly the six, and asserts exact slug sets (never counts)', () => {
    expect([...cut.ARCHIVE].sort()).toEqual([
      'branding',
      'event-planning',
      'gaming',
      'merchandise',
      'photography',
      'web-development',
    ]);
    expect(s).toContain("'branding,event-planning,gaming,merchandise,photography,web-development'");
    expect(s).toContain("'animation,music-vo-sfx,photo-video,video-editing'");
  });
});

describe('the content step (plan step 4) writes what the seed skips', () => {
  const s = step('content');

  it('re-files and re-copies the 8 kept or renamed services from the seed rows', () => {
    const eight = [...cut.RENAMES.map((r) => r.to), ...cut.KEPT];
    for (const slug of eight) {
      const at = s.indexOf(`slug = '${slug}';`);
      expect(at, slug).toBeGreaterThan(-1);
      const stmt = s.slice(s.lastIndexOf('update public.services set', at), at);
      for (const column of [
        'discipline_id',
        'poster_media_id',
        'preview_video_path',
        'sort_order',
        'body',
        'value_points',
      ])
        expect(stmt, `${slug}.${column}`).toContain(`${column} = `);
      expect(stmt).toContain('(select id from public.disciplines where tenant_id');
    }
  });

  it('rebuilds the 12 sample projects’ services, sets crafts = 28 and the header link', () => {
    expect(s).toContain('delete from public.portfolio_services ps');
    expect(s.match(/\(select id from public\.portfolio where tenant_id/g)).toHaveLength(23);
    expect(s).toContain("set value = '28', value_numeric = 28, value_suffix = null");
    expect(s).toContain("set href = '/services'");
    expect(s).toContain('the-rider=photo-video,advertising');
  });
});

describe('the samples step (plan step 5)', () => {
  const s = step('samples');

  it('grants the audited override for testimonials and service_cases, with the owner’s reason', () => {
    expect(cut.OVERRIDE_TABLES).toEqual(['testimonials', 'service_cases']);
    expect(cut.OVERRIDE_REASON).toBe(
      'Owner decision 2026-09-27: show the design samples until real content replaces them',
    );
    expect(s).toContain(`'${cut.OVERRIDE_REASON}'`);
    expect(s).toContain('insert into app.placeholder_live_override');
    expect(s).toContain("a.action = 'placeholder_override.grant'");
  });

  it('publishes only flagged drafts: the 9 quotes, the 28 cases, the 4 Services-page stats', () => {
    for (const table of ['testimonials', 'service_cases', 'statistics']) {
      expect(s).toMatch(new RegExp(`update public\\.${table}[\\s\\S]*?is_placeholder and`));
    }
    expect(s).toContain("'client-satisfaction'");
    expect(s).toContain("'quote-home-1'");
    // the end state it insists on
    expect(s).toContain("'branding,events,marketing,production,web'");
  });
});
