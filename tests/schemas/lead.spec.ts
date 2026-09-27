import { describe, it, expect } from 'vitest';
import {
  BUDGET_BANDS,
  BUDGET_BAND_LABELS,
  LEGACY_BUDGET_BANDS,
  LeadInputSchema,
  budgetBandLabel,
} from '@schemas/lead';

const base = { name: 'Sam', email: 'sam@example.com', message: 'Hello there.' };

describe('LeadInputSchema (server-side validation)', () => {
  it('accepts a minimal valid submission', () => {
    expect(LeadInputSchema.safeParse(base).success).toBe(true);
  });

  it('rejects a missing/invalid email', () => {
    expect(LeadInputSchema.safeParse({ ...base, email: 'not-an-email' }).success).toBe(false);
    expect(LeadInputSchema.safeParse({ name: 'Sam', message: 'hi' }).success).toBe(false);
  });

  it('rejects an over-length message', () => {
    expect(LeadInputSchema.safeParse({ ...base, message: 'x'.repeat(5001) }).success).toBe(false);
  });

  it('rejects a filled honeypot', () => {
    expect(LeadInputSchema.safeParse({ ...base, hp: 'i am a bot' }).success).toBe(false);
  });

  it('rejects an unknown budget band', () => {
    expect(LeadInputSchema.safeParse({ ...base, budgetBand: 'a-lot' }).success).toBe(false);
  });
});

describe('UI v2 contact fields', () => {
  it('accepts every v2 budget band', () => {
    for (const band of BUDGET_BANDS) {
      expect(LeadInputSchema.safeParse({ ...base, budgetBand: band }).success, band).toBe(true);
    }
  });

  it('STILL accepts every legacy band — a year-cached page may post the old form', () => {
    for (const band of LEGACY_BUDGET_BANDS) {
      expect(LeadInputSchema.safeParse({ ...base, budgetBand: band }).success, band).toBe(true);
    }
    // and the deprecated timeline select value
    expect(LeadInputSchema.safeParse({ ...base, timelineBand: 'asap' }).success).toBe(true);
  });

  it('bounds the free-text deadline (a §3 timeline field, encrypted downstream)', () => {
    expect(LeadInputSchema.safeParse({ ...base, timelineText: 'Before Ramadan' }).success).toBe(
      true,
    );
    expect(LeadInputSchema.safeParse({ ...base, timelineText: 'x'.repeat(121) }).success).toBe(
      false,
    );
    expect(LeadInputSchema.safeParse({ ...base, timelineText: '   ' }).success).toBe(false);
  });

  it('has a label, in both languages, for every key it accepts (new AND legacy)', () => {
    for (const band of [...BUDGET_BANDS, ...LEGACY_BUDGET_BANDS]) {
      expect(BUDGET_BAND_LABELS[band].en, band).toBeTruthy();
      expect(BUDGET_BAND_LABELS[band].ar, band).toBeTruthy();
    }
    expect(budgetBandLabel('lt_25k')).toBe('Under 25k SAR');
    expect(budgetBandLabel('lt_25k', 'ar')).toBe('أقل من ٢٥ ألف ريال');
    // A hand-edited row never crashes the admin — it shows the raw key.
    expect(budgetBandLabel('mystery')).toBe('mystery');
  });

  it('marks legacy labels so an editor can tell which form a lead came through', () => {
    for (const band of LEGACY_BUDGET_BANDS) expect(BUDGET_BAND_LABELS[band].en).toMatch(/legacy/i);
  });
});

describe('Round 2: "{Discipline}, help me choose"', () => {
  it('accepts a discipline slug, alone or beside a service', () => {
    const one = LeadInputSchema.safeParse({ ...base, disciplineOfInterest: 'branding' });
    expect(one.success && one.data.disciplineOfInterest).toBe('branding');
    expect(
      LeadInputSchema.safeParse({
        ...base,
        disciplineOfInterest: 'events',
        serviceOfInterest: 'logo',
      }).success,
    ).toBe(true);
  });

  it('holds it to the slug shape and the 0028 column bound (64)', () => {
    for (const bad of ['Branding', 'discipline:branding', 'web dev', '', 'a'.repeat(65)]) {
      expect(LeadInputSchema.safeParse({ ...base, disciplineOfInterest: bad }).success, bad).toBe(
        false,
      );
    }
    expect(
      LeadInputSchema.safeParse({ ...base, disciplineOfInterest: 'a'.repeat(64) }).success,
    ).toBe(true);
  });
});
