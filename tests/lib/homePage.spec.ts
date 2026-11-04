import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { readHomePageId } from '@/lib/admin/homePage';

// The Loading screen's read of the home page's id (Admin v2 E7 review, E7-S1): under the
// person's RLS AND with the tenant named, as every other admin read of public.pages.

type Call = [method: string, ...args: unknown[]];

/** A query builder that records its chain and answers `maybeSingle()` with `answer`. */
function recordingClient(answer: { data: unknown; error: { message: string } | null }) {
  const calls: Call[] = [];
  const api = {
    select: (...args: unknown[]) => (calls.push(['select', ...args]), api),
    eq: (...args: unknown[]) => (calls.push(['eq', ...args]), api),
    maybeSingle: async () => (calls.push(['maybeSingle']), answer),
  };
  const sb = {
    from: (table: string) => (calls.push(['from', table]), api),
  } as unknown as SupabaseClient;
  return { sb, calls };
}

const TENANT = '00000000-0000-4000-8000-000000000001';
const PAGE = '00000000-0000-4000-8000-0000000000aa';

describe('readHomePageId (E7-S1)', () => {
  it('reads the home page of the tenant it is given: the tenant predicate, then the slug', async () => {
    const { sb, calls } = recordingClient({ data: { id: PAGE }, error: null });
    expect(await readHomePageId(sb, TENANT)).toEqual({ ok: true, id: PAGE });
    expect(calls).toEqual([
      ['from', 'pages'],
      ['select', 'id'],
      ['eq', 'tenant_id', TENANT],
      ['eq', 'slug', 'home'],
      ['maybeSingle'],
    ]);
  });

  it('no home page is null; a failed read says so', async () => {
    expect(await readHomePageId(recordingClient({ data: null, error: null }).sb, TENANT)).toEqual({
      ok: true,
      id: null,
    });
    expect(
      await readHomePageId(recordingClient({ data: { id: 7 }, error: null }).sb, TENANT),
    ).toEqual({ ok: true, id: null });
    expect(
      await readHomePageId(recordingClient({ data: null, error: { message: 'boom' } }).sb, TENANT),
    ).toEqual({ ok: false, message: 'boom' });
  });

  it('the Loading screen reads the home page through it, with the session’s tenant', () => {
    const page = readFileSync('src/pages/admin/appearance/loading.astro', 'utf8');
    expect(page).toContain('await readHomePageId(sb, session.tenantId)');
    expect(page).not.toMatch(/\.from\('pages'\)/);
  });
});
