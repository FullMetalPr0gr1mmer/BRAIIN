import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { logSafe, parseRow, parseRows, reportBodyRefused } from '@/lib/data/parse';

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

// H15 check: a refusal reason can quote a stored node or mark type (sectionDocProblem's
// labelOf), which a row written around the Worker controls. The log line carries neither that
// text nor a forged second line.
describe('reportBodyRefused keeps stored text out of the log', () => {
  it('drops a quoted label and turns control characters into spaces', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      reportBodyRefused(
        'page_section',
        'id-1',
        'en',
        'A Text block cannot show this part of the text ("jane.doe@example.com\n[content] forged li").',
      );
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).not.toContain('jane.doe');
      expect(line).not.toContain('\n');
      expect(line).toContain('cannot show this part of the text ("…")');
    } finally {
      warn.mockRestore();
    }
  });

  it('caps a long reason and leaves a plain one as it is', () => {
    expect(logSafe('x'.repeat(500))).toHaveLength(200);
    expect(logSafe('the source is not a pair of languages')).toBe(
      'the source is not a pair of languages',
    );
  });
});
