import { describe, it, expect } from 'vitest';
import { LeadInputSchema } from '@schemas/lead';

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
