import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leadSignals, scoreFor } from '@/lib/crm/score';
import { DEFAULT_SCORING, LEAD_CHANNELS, LEAD_SOURCES, SCORE_SIGNALS } from '@schemas/crm';

// Score signals (Admin v2 C1b): worked out from the plaintext before it is encrypted, kept
// as keys only. The vocabularies live twice, in packages/schemas/crm.ts and in the SQL
// CHECKs of migration 0035, so this holds the two equal.

const sql = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0035_crm_ingest.sql'),
  'utf8',
);

const quoted = (text: string) => [...text.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]!);

describe('leadSignals', () => {
  it('names what was given, never the values', () => {
    expect(
      leadSignals({
        email: 'sara@acme.sa',
        serviceOfInterest: 'logo',
        budgetBand: 'gt_200k',
        company: 'Acme',
        timelineText: 'Before Ramadan',
      }).sort(),
    ).toEqual(
      [
        'budget_200k_plus',
        'budget_given',
        'company_email',
        'company_named',
        'named_service',
        'timeline_given',
      ].sort(),
    );
  });

  it('a free mailbox, "not sure" and nothing else score nothing', () => {
    expect(leadSignals({ email: 'sara@gmail.com', budgetBand: 'not_sure' })).toEqual([]);
    expect(leadSignals({ email: null, budgetBand: 'undisclosed', company: '  ' })).toEqual([]);
  });

  it('reads the legacy top band and the legacy timeline band', () => {
    expect(
      leadSignals({ email: null, budgetBand: 'gt_150k', timelineBand: 'asap' }).sort(),
    ).toEqual(['budget_200k_plus', 'budget_given', 'timeline_given']);
  });

  it('never claims `returning`: only the database can see earlier leads', () => {
    const all = leadSignals({
      email: 'sara@acme.sa',
      serviceOfInterest: 'logo',
      budgetBand: 'gt_200k',
      company: 'Acme',
      timelineText: 'Soon',
    });
    expect(all).not.toContain('returning');
    expect(all).not.toContain('service_page');
  });
});

describe('scoreFor (the twin of app.lead_score)', () => {
  it('adds the points, once per signal, and caps at 100', () => {
    expect(scoreFor(['named_service', 'company_email', 'company_named'])).toBe(25);
    expect(scoreFor(['named_service', 'named_service'])).toBe(10);
    expect(scoreFor([...SCORE_SIGNALS])).toBe(90);
    expect(scoreFor(['named_service'], { named_service: 50 })).toBe(50);
    expect(scoreFor([...SCORE_SIGNALS], { ...DEFAULT_SCORING, budget_200k_plus: 50 })).toBe(100);
  });
});

describe('the SQL says the same as the schema (0035)', () => {
  it('the scoring keys the CHECK accepts are SCORE_SIGNALS', () => {
    const body = /function app\.crm_scoring_ok[\s\S]*?e\.k in \(([^)]*)\)/.exec(sql)?.[1] ?? '';
    expect(quoted(body).sort()).toEqual([...SCORE_SIGNALS].sort());
  });

  it('the signals the column accepts are SCORE_SIGNALS', () => {
    const body = /score_signals <@ array\[([^\]]*)\]/.exec(sql)?.[1] ?? '';
    expect(quoted(body).sort()).toEqual([...SCORE_SIGNALS].sort());
  });

  it('the default points are DEFAULT_SCORING', () => {
    const body =
      /scoring jsonb not null default jsonb_build_object\(([\s\S]*?)\)\s*check/.exec(sql)?.[1] ??
      '';
    const pairs = [...body.matchAll(/'([a-z_0-9]+)',\s*(\d+)/g)].map((m) => [m[1]!, Number(m[2])]);
    expect(Object.fromEntries(pairs)).toEqual(DEFAULT_SCORING);
  });

  it('sources and channels match their CHECKs', () => {
    const sources =
      /source text not null default 'web_form'\s*check \(source in \(([^)]*)\)\)/.exec(sql)?.[1] ??
      '';
    const channels =
      /channel text not null default 'unknown'\s*check \(channel in \(([\s\S]*?)\)\)/.exec(
        sql,
      )?.[1] ?? '';
    expect(quoted(sources).sort()).toEqual([...LEAD_SOURCES].sort());
    expect(quoted(channels).sort()).toEqual([...LEAD_CHANNELS].sort());
  });
});
