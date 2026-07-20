import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { parseRow, parseRows } from '@/lib/data/parse';

// The point of this helper is that an invalid row is dropped LOUDLY. A silent drop makes
// a malformed case study indistinguishable from an unpublished one, with nothing to
// search for in the logs (DoD #6 — Observable).

const Row = z.object({ slug: z.string(), n: z.number() });

afterEach(() => vi.restoreAllMocks());

describe('parseRows', () => {
  it('keeps valid rows and drops invalid ones', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = parseRows(
      Row,
      [
        { slug: 'a', n: 1 },
        { slug: 'b', n: 'nope' },
        { slug: 'c', n: 3 },
      ],
      'thing',
    );
    expect(out.map((r) => r.slug)).toEqual(['a', 'c']);
  });

  it('logs the entity, the slug and the failing FIELD PATH', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseRows(Row, [{ slug: 'broken-case-study', n: 'nope' }], 'portfolio');
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]?.[0] as string;
    expect(msg).toContain('portfolio');
    expect(msg).toContain('broken-case-study');
    expect(msg).toContain('n');
  });

  it('never logs field VALUES — only paths (safe if pointed at a PII table)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The row must actually FAIL for anything to be logged — hence max(5) against a
    // longer address. (First draft of this test used a *valid* email, so nothing was
    // logged and it passed vacuously.)
    const Secret = z.object({ slug: z.string(), email: z.string().max(5) });
    parseRows(Secret, [{ slug: 's', email: 'kareem@example.com' }], 'lead');
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]?.[0] as string;
    expect(msg).not.toContain('kareem@example.com');
    expect(msg).toContain('email');
  });

  it('degrades to <no-slug> rather than throwing on a shapeless row', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseRows(Row, [null, 42, { slug: 7 }], 'thing')).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]?.[0]).toContain('<no-slug>');
  });

  it('is silent when every row is valid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseRows(Row, [{ slug: 'a', n: 1 }], 'thing')).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('parseRow', () => {
  it('returns the parsed row when valid', () => {
    expect(parseRow(Row, { slug: 'a', n: 1 }, 'thing')?.slug).toBe('a');
  });

  it('returns null and logs when invalid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseRow(Row, { slug: 'a', n: 'x' }, 'thing')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
