import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { VISIBILITY_KV_KEY, clearVisibilityMemo } from '@/lib/http/visibility';
import { env as stubEnv, __kv } from '../stubs/cloudflare-workers';

// Page visibility's admin half (Admin v2 U14a): the snapshot a save builds, the edge write
// and its `kvSynced`, and the save itself (the rules it checks before the database does, the
// insert at version 0, the optimistic update and its 409).

const logs = vi.hoisted(() => [] as unknown[]);
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: unknown) => {
    logs.push(entry);
    return true;
  },
}));

const {
  buildVisibilitySnapshot,
  edgeVisibilityStatus,
  syncVisibilityToEdge,
  visibilityPurgeTags,
  VISIBILITY_SNAPSHOT_SELECT,
} = await import('@/lib/admin/visibilitySync');
const { HOME_REFUSAL, saveVisibility } = await import('@/lib/admin/pageVisibility');

const env = stubEnv as unknown as { SESSION: KVNamespace };
const AUTH: AuthContext = {
  userId: '00000000-0000-4000-8000-0000000000a1',
  tenantId: '00000000-0000-4000-8000-000000000001',
  role: 'developer',
  isActive: true,
  email: 'dev@example.test',
};
const HOME = '00000000-0000-4000-8000-00000000a001';
const ABOUT = '00000000-0000-4000-8000-00000000a002';
const CONTACT = '00000000-0000-4000-8000-00000000a003';

interface Op {
  table: string;
  op: string;
  select?: string;
  values?: Record<string, unknown>;
  filters: string[];
}

/** A PostgREST stand-in: `pages` and `page_visibility` answer from `db`, every op recorded. */
function client(db: {
  pages?: Record<string, unknown>[];
  visibility?: Record<string, unknown> | null;
  insertError?: { code: string; message: string } | null;
  readError?: { message: string } | null;
}) {
  const ops: Op[] = [];
  const from = (table: string) => {
    const op: Op = { table, op: 'select', filters: [] };
    ops.push(op);
    const b: Record<string, unknown> = {};
    const list = () => {
      if (db.readError) return { data: null, error: db.readError };
      if (table === 'pages') return { data: db.pages ?? [], error: null };
      if (table === 'page_visibility')
        return { data: db.visibility ? [db.visibility] : [], error: null };
      return { data: [], error: null };
    };
    b['select'] = (columns: string) => {
      if (op.op === 'select') op.select = columns;
      return b;
    };
    b['insert'] = (values: Record<string, unknown>) => {
      op.op = 'insert';
      op.values = values;
      return b;
    };
    b['update'] = (values: Record<string, unknown>) => {
      op.op = 'update';
      op.values = values;
      return b;
    };
    for (const m of ['eq', 'match', 'limit', 'order']) {
      b[m] = (a: unknown, v?: unknown) => {
        op.filters.push(
          `${m}:${typeof a === 'object' ? JSON.stringify(a) : `${String(a)}=${String(v)}`}`,
        );
        return b;
      };
    }
    b['single'] = async () => {
      if (op.op === 'insert' && db.insertError) return { data: null, error: db.insertError };
      return { data: { id: 'new-row', ...op.values, version: 1 }, error: null };
    };
    b['maybeSingle'] = async () => {
      if (op.op === 'update')
        return { data: { id: db.visibility?.['id'], ...op.values, version: 2 }, error: null };
      if (table === 'page_visibility') return { data: db.visibility ?? null, error: null };
      return { data: null, error: null };
    };
    b['then'] = (ok: (v: unknown) => unknown) => Promise.resolve(list()).then(ok);
    return b;
  };
  return { sb: { from } as unknown as SupabaseClient, ops };
}

const PAGES = [
  { id: HOME, slug: 'home', title: { en: 'Home' } },
  { id: ABOUT, slug: 'about', title: { en: 'About' } },
  { id: CONTACT, slug: 'contact', title: { en: 'Contact' } },
  { id: '00000000-0000-4000-8000-00000000a0ff', slug: 'careers', title: { en: 'Careers' } },
];

beforeEach(() => {
  __kv.clear();
  clearVisibilityMemo();
  logs.length = 0;
});

describe('buildVisibilitySnapshot', () => {
  const row = (over: Record<string, unknown>) => ({
    mode: 'public',
    template: null,
    hide_from: null,
    show_on: null,
    page: null,
    redirect: null,
    ...over,
  });

  it('keeps what is not public, by slug, the redirect by its target’s slug', () => {
    const snap = buildVisibilitySnapshot(
      [
        row({
          mode: 'hidden',
          page: { slug: 'about' },
          redirect: { slug: 'contact' },
          hide_from: '2026-10-31T21:00:00+00:00',
          show_on: '2026-11-07T21:00:00+00:00',
        }),
        row({ mode: 'link', page: { slug: 'Join' } }),
        row({ mode: 'public', page: { slug: 'contact' } }),
        row({ mode: 'hidden', template: 'case_study' }),
      ],
      new Date('2026-10-16T09:00:00Z'),
    );
    expect(snap).toEqual({
      v: 1,
      builtAt: '2026-10-16T09:00:00.000Z',
      pages: {
        about: {
          mode: 'hidden',
          target: 'contact',
          from: '2026-10-31T21:00:00.000Z',
          until: '2026-11-07T21:00:00.000Z',
        },
        join: { mode: 'link' },
      },
      templates: { case_study: { mode: 'hidden', target: null } },
    });
  });

  it('drops the homepage, a page the route map does not know, a redirect to one, and bad modes', () => {
    const snap = buildVisibilitySnapshot([
      row({ mode: 'hidden', page: { slug: 'home' } }),
      row({ mode: 'hidden', page: { slug: 'careers' } }),
      row({ mode: 'hidden', page: { slug: 'about' }, redirect: { slug: 'careers' } }),
      row({ mode: 'secret', page: { slug: 'join' } }),
      row({ mode: 'link', template: 'service' }),
      row({ mode: 'hidden', page: null }),
    ]);
    expect(snap.pages).toEqual({ about: { mode: 'hidden', target: null } });
    expect(snap.templates).toEqual({});
  });

  it('the purge tags of a change: the page or the template’s pages, the menus, the discovery files', () => {
    expect(visibilityPurgeTags({ kind: 'page', slug: 'about' })).toEqual([
      'page:about',
      'nav:all',
      'route:sitemap',
      'route:llms',
    ]);
    expect(visibilityPurgeTags({ kind: 'template', template: 'service' })[0]).toBe('services:all');
    expect(visibilityPurgeTags({ kind: 'template', template: 'case_study' })[0]).toBe(
      'portfolio:all',
    );
  });
});

describe('syncVisibilityToEdge', () => {
  it('reads the caller’s tenant under its own client, writes the whole snapshot, reports it', async () => {
    const { sb, ops } = client({
      visibility: {
        mode: 'link',
        template: null,
        hide_from: null,
        show_on: null,
        page: { slug: 'about' },
        redirect: null,
      },
    });
    expect(await syncVisibilityToEdge(sb, AUTH)).toEqual({ kvSynced: true, count: 1 });
    expect(ops[0]).toMatchObject({
      table: 'page_visibility',
      select: VISIBILITY_SNAPSHOT_SELECT,
      filters: [`eq:tenant_id=${AUTH.tenantId}`, 'limit:9=undefined'],
    });
    expect(JSON.parse(__kv.get(VISIBILITY_KV_KEY)!).pages).toEqual({ about: { mode: 'link' } });
    expect(await edgeVisibilityStatus()).toMatchObject({ present: true, count: 1 });
  });

  it('kvSynced: false when KV refuses, never a throw', async () => {
    const put = vi.spyOn(env.SESSION, 'put').mockRejectedValue(new Error('kv down'));
    const { sb } = client({});
    expect(await syncVisibilityToEdge(sb, AUTH)).toEqual({ kvSynced: false, count: 0 });
    put.mockRestore();
  });

  it('kvSynced: false and a system log when the read fails', async () => {
    const { sb } = client({ readError: { message: 'permission denied' } });
    expect(await syncVisibilityToEdge(sb, AUTH)).toEqual({ kvSynced: false, count: 0 });
    expect(logs).toEqual([
      expect.objectContaining({ level: 'error', source: 'admin:page_visibility.sync' }),
    ]);
    expect(__kv.has(VISIBILITY_KV_KEY)).toBe(false);
  });

  it('the edge status says when there is no snapshot yet', async () => {
    expect(await edgeVisibilityStatus()).toEqual({ present: false, builtAt: null, count: 0 });
  });
});

describe('saveVisibility', () => {
  const save = (db: Parameters<typeof client>[0], input: Record<string, unknown>) => {
    const { sb, ops } = client({ pages: PAGES, ...db });
    const write = {
      redirectPageId: null,
      hideFrom: null,
      showOn: null,
      version: 0,
      ...input,
    } as Parameters<typeof saveVisibility>[2];
    return { run: () => saveVisibility(sb, AUTH, write), ops };
  };

  it('the homepage is always visible: any other mode is refused with the admin’s words', async () => {
    for (const mode of ['hidden', 'link']) {
      await expect(save({}, { target: { pageId: HOME }, mode }).run()).rejects.toMatchObject({
        detail: HOME_REFUSAL,
        field: 'mode',
      });
    }
    await expect(
      save({}, { target: { pageId: HOME }, mode: 'public' }).run(),
    ).resolves.toBeDefined();
  });

  it('refuses a page it does not know, a redirect to itself and a redirect off the list', async () => {
    await expect(
      save({}, { target: { pageId: '00000000-0000-4000-8000-0000000000ee' }, mode: 'link' }).run(),
    ).rejects.toMatchObject({ entity: 'page' });
    await expect(
      save({}, { target: { pageId: ABOUT }, mode: 'hidden', redirectPageId: ABOUT }).run(),
    ).rejects.toMatchObject({ field: 'redirectPageId' });
    await expect(
      save(
        {},
        {
          target: { pageId: ABOUT },
          mode: 'hidden',
          redirectPageId: '00000000-0000-4000-8000-00000000a0ff',
        },
      ).run(),
    ).rejects.toMatchObject({ field: 'redirectPageId' });
  });

  it('a first save inserts at version 0, the dates as Riyadh midnights, under the caller’s tenant', async () => {
    const { run, ops } = save(
      {},
      {
        target: { pageId: ABOUT },
        mode: 'hidden',
        redirectPageId: CONTACT,
        hideFrom: '2026-11-01',
        showOn: '2026-11-08',
      },
    );
    const result = await run();
    const insert = ops.find((o) => o.op === 'insert')!;
    expect(insert.values).toEqual({
      page_id: ABOUT,
      mode: 'hidden',
      redirect_page_id: CONTACT,
      hide_from: '2026-10-31T21:00:00.000Z',
      show_on: '2026-11-07T21:00:00.000Z',
      tenant_id: AUTH.tenantId,
    });
    expect(result.fields.sort()).toEqual(['hide_from', 'mode', 'redirect_page_id', 'show_on']);
    expect(result.target).toEqual({ kind: 'page', slug: 'about', id: ABOUT });
  });

  it('a first save that is not at version 0, or that loses the race to insert, is a 409', async () => {
    await expect(
      save({}, { target: { template: 'service' }, mode: 'hidden', version: 3 }).run(),
    ).rejects.toMatchObject({ entity: 'page_visibility', status: 409 });
    await expect(
      save(
        { insertError: { code: '23505', message: 'duplicate' } },
        { target: { template: 'service' }, mode: 'hidden' },
      ).run(),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('a later save is versioned: a stale version is a 409, a current one names what changed', async () => {
    const existing = {
      id: 'row-1',
      page_id: ABOUT,
      template: null,
      mode: 'link',
      redirect_page_id: null,
      hide_from: null,
      show_on: null,
      version: 2,
    };
    await expect(
      save(
        { visibility: existing },
        { target: { pageId: ABOUT }, mode: 'public', version: 1 },
      ).run(),
    ).rejects.toMatchObject({ status: 409 });
    const { run, ops } = save(
      { visibility: existing },
      { target: { pageId: ABOUT }, mode: 'hidden', version: 2 },
    );
    const result = await run();
    expect(result.fields).toEqual(['mode']);
    const update = ops.find((o) => o.op === 'update')!;
    expect(update.values).toEqual({
      mode: 'hidden',
      redirect_page_id: null,
      hide_from: null,
      show_on: null,
    });
    expect(update.filters).toContain(`eq:tenant_id=${AUTH.tenantId}`);
  });
});
