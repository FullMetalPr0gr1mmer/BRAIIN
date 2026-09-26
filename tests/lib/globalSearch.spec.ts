import { describe, it, expect } from 'vitest';
import { cleanQuery, escapeLike, MAX_QUERY_LENGTH } from '@/lib/admin/globalSearch';

// Search input is an input boundary (CLAUDE.md §9e — search safety is a blocking test
// class). These pin the two transforms every query passes through before it can reach
// PostgREST: control-char stripping + length cap, and ilike-wildcard escaping.

describe('cleanQuery', () => {
  it('strips control characters, including NUL and DEL', () => {
    // Control chars built from escapes: a literal control byte in a source file
    // makes git and grep treat it as binary, which is its own bug.
    expect(cleanQuery('cof\u0000fee\u001f bea\u007fns')).toBe('coffee beans');
  });

  it('trims and caps at MAX_QUERY_LENGTH', () => {
    const long = `  ${'a'.repeat(200)}  `;
    expect(cleanQuery(long)).toHaveLength(MAX_QUERY_LENGTH);
  });

  it('keeps Arabic text intact', () => {
    expect(cleanQuery('هوية بصرية')).toBe('هوية بصرية');
  });

  it('passes a query of exactly the cap through unchanged', () => {
    const exact = 'b'.repeat(MAX_QUERY_LENGTH);
    expect(cleanQuery(exact)).toBe(exact);
  });
});

describe('escapeLike', () => {
  it('escapes %, _ and backslash so they match literally', () => {
    expect(escapeLike('100%_done\\')).toBe('100\\%\\_done\\\\');
  });

  it('a wildcard-only query cannot become match-everything', () => {
    // Unescaped, '%' alone would ilike-match every row of every searchable table.
    expect(escapeLike('%')).toBe('\\%');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLike('branding')).toBe('branding');
  });
});
