import { describe, it, expect } from 'vitest';
import { StyleFinderInputSchema } from '@schemas/styleFinder';

const valid = {
  sessionId: 'abcd1234',
  answers: [
    { questionId: 'tone', value: 'bold' },
    { questionId: 'palette', value: 'neon-on-dark' },
  ],
};

describe('StyleFinderInputSchema (AI proxy input boundary)', () => {
  it('accepts a valid submission', () => {
    expect(StyleFinderInputSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a too-short or bad-charset sessionId', () => {
    expect(StyleFinderInputSchema.safeParse({ ...valid, sessionId: 'short' }).success).toBe(false);
    expect(StyleFinderInputSchema.safeParse({ ...valid, sessionId: 'has spaces!' }).success).toBe(
      false,
    );
  });

  it('rejects empty or oversized answer sets', () => {
    expect(StyleFinderInputSchema.safeParse({ ...valid, answers: [] }).success).toBe(false);
    const tooMany = Array.from({ length: 41 }, (_, i) => ({ questionId: `q${i}`, value: 'x' }));
    expect(StyleFinderInputSchema.safeParse({ ...valid, answers: tooMany }).success).toBe(false);
  });

  it('rejects an overlong answer value (cost bound)', () => {
    const long = [{ questionId: 'q', value: 'x'.repeat(281) }];
    expect(StyleFinderInputSchema.safeParse({ ...valid, answers: long }).success).toBe(false);
  });
});
