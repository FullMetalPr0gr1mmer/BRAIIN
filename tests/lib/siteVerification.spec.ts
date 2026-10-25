import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Search Console verification code a visitor's page carries (Admin v2 U11,
// src/lib/data/siteVerification.ts): anon's one column of site_integrations, through the
// content seam. It never throws and never fails the page: anything but a well-formed code
// is no tag, and every failure is reported.

let configured = true;
let answer: { data: unknown; error: unknown } = { data: null, error: null };
let thrown: Error | null = null;
const asked: { table: string; columns: string }[] = [];

vi.mock('@/lib/supabase/client', () => ({
  supabaseConfigured: () => configured,
  anonClient: () => ({
    from: (table: string) => {
      const entry = { table, columns: '' };
      asked.push(entry);
      const q = {
        select: (columns: string) => {
          entry.columns = columns;
          return q;
        },
        maybeSingle: async () => {
          if (thrown) throw thrown;
          return answer;
        },
      };
      return q;
    },
  }),
}));

const { getSearchConsoleToken, SEARCH_CONSOLE_COLUMN } =
  await import('@/lib/data/siteVerification');

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  configured = true;
  answer = { data: null, error: null };
  thrown = null;
  asked.length = 0;
  warn.mockClear();
});

describe('getSearchConsoleToken', () => {
  it('reads the one column anon may, of site_integrations, and answers the code', async () => {
    answer = { data: { search_console_token: 'abcDEF012_-xyz' }, error: null };
    expect(await getSearchConsoleToken()).toBe('abcDEF012_-xyz');
    expect(asked).toEqual([{ table: 'site_integrations', columns: 'search_console_token' }]);
    expect(SEARCH_CONSOLE_COLUMN).toBe('search_console_token');
    expect(warn).not.toHaveBeenCalled();
  });

  it('is null, quietly, with no row or no code set', async () => {
    expect(await getSearchConsoleToken()).toBeNull();
    answer = { data: { search_console_token: null }, error: null };
    expect(await getSearchConsoleToken()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('asks nothing when the database is not configured', async () => {
    configured = false;
    expect(await getSearchConsoleToken()).toBeNull();
    expect(asked).toEqual([]);
  });

  it('is null and reported on a refused read', async () => {
    answer = { data: null, error: { code: '42501', message: 'permission denied' } };
    expect(await getSearchConsoleToken()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('site_integrations load failed'));
  });

  it('is null and reported when the read throws', async () => {
    thrown = new Error('network');
    expect(await getSearchConsoleToken()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('site_integrations load failed'));
  });

  it.each([
    ['markup', 'abc"def<ghi>jkl'],
    ['a space', 'has a space in it'],
    ['too short', 'short'],
    ['too long', 'a'.repeat(101)],
    ['not text', 12345678901],
  ])('is null and reported for a stored value that is no code (%s)', async (_name, value) => {
    answer = { data: { search_console_token: value }, error: null };
    expect(await getSearchConsoleToken()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('site_integrations load failed'));
  });
});
