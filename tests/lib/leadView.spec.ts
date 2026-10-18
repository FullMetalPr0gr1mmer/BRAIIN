import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEAD_CHANNELS } from '@schemas/crm';
import {
  CHANNEL_LABELS,
  FORMER_MEMBER,
  LEAD_EVENT_KINDS,
  SLA_LABEL,
  actorName,
  eventSentence,
  formatSar,
  interestOf,
  rangeToInstants,
  scoreBand,
  scoreBucket,
  slaLabel,
  sourceLabel,
  sourceTone,
  stageTone,
} from '@/lib/crm/leadView';
import { previousPeriod } from '@/lib/crm/leadKpis';

// How a lead reads on the leads screens (Admin v2 C4a): src/lib/crm/leadView.ts. Pure, so a
// server-rendered page and its island print the same words. P-12: no em or en dash, digits
// exactly as typed (money in Latin digits, never a script's digits mapped to another's).

const DASHES = /[–—]/;
const ARABIC_DIGITS = /[٠-٩۰-۹]/;

const STAGES = new Map([
  ['new', { label: 'New' }],
  ['contacted', { label: 'Contacted' }],
  ['won', { label: 'Won' }],
]);
const SARA = '11111111-1111-4111-8111-111111111111';
const PEOPLE = new Map<string, string | null>([[SARA, 'Sara']]);
const GONE = '99999999-9999-4999-8999-999999999999';

describe('interestOf', () => {
  it('a service, else a discipline to help choose in, else "Not given"', () => {
    expect(interestOf({ service_of_interest: 'logo' })).toBe('logo');
    expect(
      interestOf({ service_of_interest: 'logo', service_label: { en: 'Logo Design', ar: 'x' } }),
    ).toBe('Logo Design');
    expect(interestOf({ service_of_interest: null, discipline_of_interest: 'events' })).toBe(
      'events (help me choose)',
    );
    expect(interestOf({ service_of_interest: null })).toBe('Not given');
    expect(interestOf({ service_of_interest: null }, 'Nothing')).toBe('Nothing');
  });
});

describe('source, stage, score and SLA', () => {
  it('names the source in words; a lead added by hand says how', () => {
    expect(sourceLabel('web_form', 'unknown')).toBe('Web form');
    expect(sourceLabel('manual', 'phone')).toBe('By hand · Phone');
    expect(sourceLabel('manual', 'walk_in')).toBe('By hand · Walk-in');
    expect(sourceLabel('manual', 'unknown')).toBe('By hand · Other');
    expect(sourceLabel('manual', 'nonsense')).toBe('By hand · Other');
    expect(sourceLabel('import', 'unknown')).toBe('Imported');
    expect(sourceLabel('style_finder', 'unknown')).toBe('Style finder');
    expect(sourceLabel('nonsense', 'phone')).toBe('Other');
  });

  it('every channel has words', () => {
    for (const channel of LEAD_CHANNELS) expect(CHANNEL_LABELS[channel], channel).toBeTruthy();
  });

  it('tones come from the badge palette only', () => {
    expect(sourceTone('web_form')).toBe('klein');
    expect(sourceTone('manual')).toBe('sky');
    expect(sourceTone('import')).toBe('gray');
    expect(stageTone({ tone: 'ok' })).toBe('ok');
    expect(stageTone({ tone: 'pink' })).toBe('gray');
    expect(stageTone(null)).toBe('gray');
  });

  it('scoreBand: 75 and up ok, 55 and up klein, else warn', () => {
    expect(scoreBand(54)).toBe('warn');
    expect(scoreBand(55)).toBe('klein');
    expect(scoreBand(74)).toBe('klein');
    expect(scoreBand(75)).toBe('ok');
    expect(scoreBand(0)).toBe('warn');
    expect(scoreBand(100)).toBe('ok');
  });

  it('scoreBucket: the nearest 5, held to 0..100 (admin.css has a rule per bucket)', () => {
    expect([0, 2, 3, 52, 53, 98, 100].map(scoreBucket)).toEqual([0, 0, 5, 50, 55, 100, 100]);
    expect(scoreBucket(-5)).toBe(0);
    expect(scoreBucket(140)).toBe(100);
    expect(scoreBucket(Number.NaN)).toBe(0);
    for (let score = 0; score <= 100; score += 1) expect(scoreBucket(score) % 5).toBe(0);
  });

  it('the SLA flag is words, never only a colour', () => {
    expect(slaLabel(true)).toBe(SLA_LABEL);
    expect(SLA_LABEL).toBe('Over response time');
    expect(slaLabel(false)).toBeNull();
    expect(slaLabel(null)).toBeNull();
  });
});

describe('formatSar', () => {
  it('groups thousands with Latin digits and no decimals', () => {
    expect(formatSar(50000)).toBe('50,000 SAR');
    expect(formatSar(0)).toBe('0 SAR');
    expect(formatSar(10_000_000)).toBe('10,000,000 SAR');
    for (const value of [1, 999, 1234567]) expect(formatSar(value)).not.toMatch(ARABIC_DIGITS);
  });
});

describe('the timeline', () => {
  it('knows every kind the database records (0041 CHECK lead_events_kind_check)', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0041_crm_leads_write.sql'),
      'utf8',
    );
    const check = /add constraint lead_events_kind_check check \(kind in \(([^)]+)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const kinds = [...check![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...LEAD_EVENT_KINDS].sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      const sentence = eventSentence({ kind: kind!, actor_id: null, detail: {} }, STAGES, PEOPLE);
      expect(sentence, kind).not.toBe('Updated');
      expect(sentence, kind).not.toMatch(DASHES);
    }
  });

  it('says what happened, in plain words', () => {
    const say = (kind: string, detail: Record<string, unknown> = {}, actor: string | null = SARA) =>
      eventSentence({ kind, actor_id: actor, detail }, STAGES, PEOPLE);
    expect(say('stage_changed', { from: 'new', to: 'contacted' })).toBe(
      'Moved from New to Contacted',
    );
    expect(say('stage_changed', { from: null, to: 'won' })).toBe('Moved to Won');
    expect(say('stage_changed', { from: 'new', to: 'gone' })).toBe(
      'Moved from New to a stage that was removed',
    );
    expect(say('assigned', { to: SARA, from: null })).toBe('Assigned to Sara');
    expect(say('assigned', { to: GONE })).toBe(`Assigned to ${FORMER_MEMBER}`);
    expect(say('unassigned', { from: SARA })).toBe('Unassigned');
    expect(say('value_set', { value_sar: 50000 })).toBe('Value set to 50,000 SAR');
    expect(say('value_set', { value_sar: null })).toBe('Value cleared');
    expect(say('spam_marked')).toBe('Marked as spam');
    expect(say('spam_cleared')).toBe('Marked as not spam');
    expect(say('contact_logged', { channel: 'call' })).toBe('Call logged');
    expect(say('contact_logged', { channel: 'whatsapp' })).toBe('WhatsApp message logged');
    expect(say('contact_logged', { channel: 'x' })).toBe('Contact logged');
    expect(say('note_added')).toBe('Note added');
    expect(say('note_deleted', { note_id: 'n', source: 'staff' })).toBe('Note deleted');
    expect(say('created', {}, null)).toBe('Arrived through the website form');
    expect(say('created', {}, SARA)).toBe('Added by hand by Sara');
    expect(say('something_new')).toBe('Updated');
  });

  it('names who did it: a person, a former member, or the system', () => {
    expect(actorName(SARA, PEOPLE)).toBe('Sara');
    expect(actorName(GONE, PEOPLE)).toBe(FORMER_MEMBER);
    expect(actorName(null, PEOPLE)).toBe('Automatically');
    expect(
      actorName(
        '22222222-2222-4222-8222-222222222222',
        new Map([['22222222-2222-4222-8222-222222222222', ' ']]),
      ),
    ).toBe(FORMER_MEMBER);
  });
});

describe('rangeToInstants: the studio calendar (Asia/Riyadh), half-open', () => {
  it('the last 7 days run from midnight six days ago in Riyadh to now, today included', () => {
    // 15:00 in Riyadh on 17 October.
    expect(rangeToInstants('7', new Date('2026-10-17T12:00:00Z'))).toEqual({
      from: '2026-10-10T21:00:00.000Z',
      to: '2026-10-17T12:00:00.000Z',
      // The same elapsed span a week earlier: midnight to 15:00 on the 10th (C4b).
      prevFrom: '2026-10-03T21:00:00.000Z',
      prevTo: '2026-10-10T12:00:00.000Z',
    });
  });

  it('turns over at Riyadh midnight, not UTC midnight', () => {
    // 23:59:59 in Riyadh on 17 October, then 00:30 on the 18th.
    expect(rangeToInstants('30', new Date('2026-10-17T20:59:59Z'))?.from).toBe(
      '2026-09-17T21:00:00.000Z',
    );
    expect(rangeToInstants('30', new Date('2026-10-17T21:30:00Z'))?.from).toBe(
      '2026-09-18T21:00:00.000Z',
    );
    const ninety = rangeToInstants('90', new Date('2026-10-17T12:00:00Z'))!;
    expect(ninety.to).toBe('2026-10-17T12:00:00.000Z');
    expect(Date.parse(ninety.from)).toBe(Date.parse('2026-07-19T21:00:00.000Z'));
  });

  it('compares the same elapsed span, never a part day with whole ones (C4b)', () => {
    for (const range of ['7', '30', '90'] as const) {
      const r = rangeToInstants(range, new Date('2026-10-17T06:15:00Z'))!;
      const span = Date.parse(r.to) - Date.parse(r.from);
      expect(Date.parse(r.prevTo) - Date.parse(r.prevFrom), range).toBe(span);
      expect(Date.parse(r.from) - Date.parse(r.prevFrom), range).toBe(Number(range) * 86_400_000);
      // The two never share an instant: the earlier one ends before this one starts.
      expect(Date.parse(r.prevTo), range).toBeLessThanOrEqual(Date.parse(r.from));
      // The route's own comparison moves the range the same way.
      expect(previousPeriod(r.from, r.to), range).toEqual({ from: r.prevFrom, to: r.prevTo });
    }
  });

  it('all time has no range, so no previous period (no invented deltas)', () => {
    expect(rangeToInstants('all', new Date('2026-10-17T12:00:00Z'))).toBeNull();
  });
});

describe('the copy (P-12)', () => {
  it('no label uses an em or en dash', () => {
    for (const label of Object.values(CHANNEL_LABELS)) expect(label).not.toMatch(DASHES);
    for (const source of ['web_form', 'manual', 'import', 'style_finder']) {
      expect(sourceLabel(source, 'phone')).not.toMatch(DASHES);
    }
    expect(interestOf({ service_of_interest: null })).not.toMatch(DASHES);
    expect(FORMER_MEMBER).not.toMatch(DASHES);
  });
});
