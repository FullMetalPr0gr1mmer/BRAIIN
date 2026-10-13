import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ROLES, type AuthContext, type Role } from '@/lib/auth/types';
import { CAPABILITIES } from '@/lib/authz/matrix';
import { reachableHrefs } from '@/lib/admin/nav';
import {
  HELP_CAP,
  HELP_LIMITS,
  HELP_SCREEN,
  HELP_SLUG,
  HELP_TAG,
  HelpArticleSeedSchema,
  HelpBodySchema,
  type HelpArticleRow,
} from '@schemas/help';
import {
  cleanHelpQuery,
  guideHref,
  helpHrefFor,
  isOnScreen,
  loadHelpArticle,
  loadHelpIndex,
  mayRead,
  PAGE_GUIDES,
  pageGuideFor,
  relatedTo,
  screenOf,
  searchHelp,
  type HelpGuide,
} from '@/lib/admin/help';
import { EXTRA_LINKS, pageFileFor } from '../admin/routes';

const { logs } = vi.hoisted(() => ({ logs: [] as unknown[] }));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: unknown) => {
    logs.push(entry);
    return true;
  },
}));

// The help centre (Admin v2 U16). Three things are held here:
//   1. The guides the migrations seed (app.help_article_set(), parsed out of the LAST
//      migration that defines it) keep the rules no CHECK can see: the schema the Worker
//      reads with, every capability one ROLE_CAPS names, every screen an admin page, each
//      reader of a guide able to open one of its screens, Arabic block for block with the
//      English, no dash the copy rules forbid (P-12), no brand spelled (CLAUDE.md §1).
//   2. Which guides each role is shown (the server's filter, from ROLE_CAPS), pinned role by
//      role, and the pure rules the drawer shares (the screen match, related, the query).
//   3. The loaders and routes: tenant-scoped, the role's guides only, a refused row logged.
// RLS and the CHECKs themselves are proven in supabase/tests/help_centre.test.sql.

// ── 1. The set ──────────────────────────────────────────────────────────────────────────

const MIGRATIONS = 'supabase/migrations';

function articleSet(): { file: string; set: unknown[] } {
  let found: { file: string; set: unknown[] } | null = null;
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(`${MIGRATIONS}/${file}`, 'utf8');
    if (!/create or replace function app\.help_article_set\(\)/.test(sql)) continue;
    const literal = /\$help\$([\s\S]*?)\$help\$/.exec(sql)?.[1];
    if (literal === undefined)
      throw new Error(`${file}: app.help_article_set() has no $help$ literal`);
    found = { file, set: JSON.parse(literal) as unknown[] };
  }
  if (!found) throw new Error('no migration defines app.help_article_set()');
  return found;
}

const { file: SET_FILE, set: RAW_SET } = articleSet();
const SET: HelpArticleRow[] = RAW_SET.map((raw) => HelpArticleSeedSchema.parse(raw));

/** Every text of a guide, in one language or both. */
function textsOf(article: HelpArticleRow, lang?: 'en' | 'ar'): string[] {
  const langs = lang ? [lang] : (['en', 'ar'] as const);
  return [
    ...(lang === 'ar' ? [] : [article.title]),
    ...(lang === 'en' ? [] : [article.title_ar]),
    ...langs.flatMap((l) =>
      article.body[l].flatMap((block) => (Array.isArray(block.x) ? block.x : [block.x])),
    ),
  ];
}

/** The screens every member reaches outside the menu: the sweep's extras and the help page. */
const MEMBER_SCREENS = new Set([
  ...EXTRA_LINKS.map((link) => link.href.split('?')[0] ?? link.href),
  '/admin/help',
]);
const reaches = (role: Role, screen: string) =>
  MEMBER_SCREENS.has(screen) || reachableHrefs(role).includes(screen);

describe(`the guides the migrations seed (${SET_FILE})`, () => {
  it('is read from the migration that defines the set last', () => {
    expect(SET_FILE).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    expect(SET.length).toBeGreaterThanOrEqual(12);
  });

  it('every guide keeps the schema the Worker reads with (strict: no unknown key)', () => {
    for (const raw of RAW_SET) expect(() => HelpArticleSeedSchema.parse(raw)).not.toThrow();
  });

  it('slugs and places in the list are unique', () => {
    expect(new Set(SET.map((a) => a.slug)).size).toBe(SET.length);
    expect(new Set(SET.map((a) => a.sort_order)).size).toBe(SET.length);
  });

  it('every capability a guide names is one ROLE_CAPS knows', () => {
    const known = new Set<string>(CAPABILITIES);
    for (const article of SET) {
      for (const cap of article.caps) expect(known.has(cap), `${article.slug}: ${cap}`).toBe(true);
    }
  });

  it('every screen a guide names is an admin page', () => {
    for (const article of SET) {
      for (const screen of article.screens) {
        expect(() => pageFileFor(screen), `${article.slug}: ${screen}`).not.toThrow();
      }
    }
  });

  it('nobody is sent to a screen they cannot open: each reader reaches one of its screens', () => {
    for (const article of SET) {
      for (const role of ROLES.filter((r) => mayRead(r, article.caps))) {
        expect(
          article.screens.some((screen) => reaches(role, screen)),
          `${role} reads ${article.slug} but opens none of ${article.screens.join(', ')}`,
        ).toBe(true);
      }
    }
  });

  it('every guide is read by some role, and Admin reads them all', () => {
    for (const article of SET) {
      expect(
        ROLES.some((role) => mayRead(role, article.caps)),
        article.slug,
      ).toBe(true);
      expect(mayRead('admin', article.caps), article.slug).toBe(true);
    }
  });

  it('the Arabic follows the English block for block (§8: both languages, first class)', () => {
    for (const article of SET) {
      const kinds = (lang: 'en' | 'ar') =>
        article.body[lang].map((b) => (b.t === 'ol' ? `ol${b.x.length}` : b.t)).join(',');
      expect(kinds('ar'), article.slug).toBe(kinds('en'));
      expect(
        textsOf(article, 'ar').every((t) => /[؀-ۿ]/.test(t)),
        article.slug,
      ).toBe(true);
    }
  });

  it('the copy keeps the client’s rules: no em or en dash, no brand spelled (P-12, §1)', () => {
    for (const article of SET) {
      for (const text of textsOf(article)) {
        expect(text, article.slug).not.toMatch(/[–—]/);
        expect(text.toLowerCase(), article.slug).not.toMatch(/braii?n|statii?on/);
      }
    }
  });

  it('no text holds markup or a control character (the CHECK refuses it too)', () => {
    for (const article of SET) {
      for (const text of textsOf(article))
        expect(text, article.slug).not.toMatch(/[<>\u0000-\u001f]/);
    }
  });

  it('the dollar-quote cannot end early: no text holds the literal’s tag', () => {
    for (const article of SET) {
      for (const text of textsOf(article)) expect(text.includes('$help$')).toBe(false);
    }
  });
});

describe('the schema and the migration state the same rules', () => {
  const sql = readFileSync(`${MIGRATIONS}/0046_help_centre.sql`, 'utf8');
  // PostgreSQL's regex has no `(?:` and needs no escaped `/`; otherwise the same text.
  const asSql = (re: RegExp) => re.source.replaceAll('(?:', '(').replaceAll('\\/', '/');

  it.each([
    ['slug', HELP_SLUG],
    ['tag', HELP_TAG],
    ['screen', HELP_SCREEN],
    ['capability', HELP_CAP],
  ])('the %s pattern', (_name, re) => {
    expect(sql).toContain(`'${asSql(re)}'`);
  });

  it('the limits', () => {
    expect(sql).toContain(`app.help_text_ok(title, ${HELP_LIMITS.title})`);
    expect(sql).toContain(
      `case when v_kind = 'h' then ${HELP_LIMITS.title} else ${HELP_LIMITS.text} end`,
    );
    expect(sql).toContain(`app.help_text_ok(v_item #>> '{}', ${HELP_LIMITS.item})`);
    expect(sql).toContain(`not between 1 and ${HELP_LIMITS.blocks}`);
    expect(sql).toContain(`not between 1 and ${HELP_LIMITS.items}`);
    expect(sql).toContain(`'^[a-z][a-z0-9-]{0,23}$', ${HELP_LIMITS.tags})`);
    expect(sql).toContain(`'^/admin(/[a-z0-9-]+)*$', ${HELP_LIMITS.screens})`);
    expect(sql).toContain(`'^[a-z][a-zA-Z]*\\.[a-z][a-zA-Z]*$', ${HELP_LIMITS.caps})`);
    expect(sql).toContain(`minutes between 1 and ${HELP_LIMITS.minutes}`);
    expect(sql).toContain(`char_length(p_q) > ${HELP_LIMITS.query}`);
  });

  it('the body schema refuses what the CHECK refuses', () => {
    const ok = { en: [{ t: 'p', x: 'a' }], ar: [{ t: 'p', x: 'ب' }] };
    expect(HelpBodySchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { en: [{ t: 'p', x: 'a' }] },
      { en: [{ t: 'html', x: 'a' }], ar: [{ t: 'p', x: 'ب' }] },
      { en: [{ t: 'p', x: 'a', y: 1 }], ar: [{ t: 'p', x: 'ب' }] },
      { en: [{ t: 'p', x: '<script>' }], ar: [{ t: 'p', x: 'ب' }] },
      { en: [{ t: 'p', x: '   ' }], ar: [{ t: 'p', x: 'ب' }] },
      { en: [{ t: 'ol', x: [] }], ar: [{ t: 'p', x: 'ب' }] },
      { en: [], ar: [{ t: 'p', x: 'ب' }] },
    ]) {
      expect(HelpBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

// ── 1b. The page heads' "Guide" (a copy of the set, held to it here) ─────────────────────

describe('the page heads’ guides (src/lib/admin/help/pageGuides.ts) follow the set', () => {
  const bySlug = new Map(SET.map((a) => [a.slug, a]));

  it('every page guide is a guide of the set, with the set’s capabilities', () => {
    for (const entry of PAGE_GUIDES) {
      const article = bySlug.get(entry.slug);
      expect(article, entry.slug).toBeDefined();
      expect([...entry.caps], entry.slug).toEqual(article?.caps);
    }
    expect(new Set(PAGE_GUIDES.map((g) => g.slug)).size).toBe(PAGE_GUIDES.length);
  });

  it('a page guide is offered only on screens its guide names, each screen once', () => {
    const seen = new Set<string>();
    for (const entry of PAGE_GUIDES) {
      for (const screen of entry.screens) {
        expect(bySlug.get(entry.slug)?.screens, `${entry.slug}: ${screen}`).toContain(screen);
        expect(seen.has(screen), screen).toBe(false);
        seen.add(screen);
      }
    }
  });

  it('every screen a guide names has a page guide, but the help page itself', () => {
    const offered = new Set(PAGE_GUIDES.flatMap((g) => g.screens));
    for (const article of SET) {
      for (const screen of article.screens) {
        if (screen === '/admin/help') continue;
        expect(offered.has(screen), `${article.slug}: ${screen}`).toBe(true);
      }
    }
  });

  it('a role is offered a screen’s guide only when it may read it', () => {
    for (const role of ROLES) {
      for (const entry of PAGE_GUIDES) {
        for (const screen of entry.screens) {
          expect(pageGuideFor(screen, role), `${role} ${screen}`).toBe(
            mayRead(role, entry.caps) ? entry.slug : null,
          );
        }
      }
    }
  });

  it('pages below a screen share its guide; the dashboard’s covers only itself', () => {
    expect(pageGuideFor('/admin/services/1234', 'content_creator')).toBe('saving-and-publishing');
    expect(pageGuideFor('/admin/pages/new', 'admin')).toBe('saving-and-publishing');
    expect(pageGuideFor('/admin/analytics/search', 'seo')).toBe('website-stats');
    expect(pageGuideFor('/admin/redirects/9', 'seo')).toBe('seo-and-redirects');
    expect(pageGuideFor('/admin', 'developer')).toBe('finding-your-way');
    expect(pageGuideFor('/admin/themes', 'admin')).toBeNull();
    expect(pageGuideFor('/admin/help', 'admin')).toBeNull();
  });

  it('SEO opens Pages and Posts without the content guide, which is for the writers', () => {
    expect(pageGuideFor('/admin/pages', 'seo')).toBeNull();
    expect(pageGuideFor('/admin/blog/1', 'seo')).toBeNull();
    expect(pageGuideFor('/admin/pages', 'content_creator')).toBe('saving-and-publishing');
  });
});

// ── 2. Who is shown what, and the shared rules ────────────────────────────────────────────

describe('which guides each role is shown (the server’s filter, from ROLE_CAPS)', () => {
  const shown = (role: Role) =>
    SET.filter((a) => mayRead(role, a.caps))
      .map((a) => a.slug)
      .sort();

  it('Admin: every guide', () => {
    expect(shown('admin')).toEqual(SET.map((a) => a.slug).sort());
  });

  it('Content Creator: the basics, content, media and stats; no leads, PII, hiring, settings or SEO', () => {
    expect(shown('content_creator')).toEqual([
      'finding-your-way',
      'media-library',
      'roles-and-access',
      'saving-and-publishing',
      'website-stats',
      'your-account',
    ]);
  });

  it('SEO: the basics, media details, SEO and redirects, and stats', () => {
    expect(shown('seo')).toEqual([
      'finding-your-way',
      'media-library',
      'roles-and-access',
      'seo-and-redirects',
      'website-stats',
      'your-account',
    ]);
  });

  it('Developer: the basics, media, leads and their personal data, maintenance, stats and site health; no hiring', () => {
    expect(shown('developer')).toEqual([
      'finding-your-way',
      'maintenance-mode',
      'media-library',
      'personal-data',
      'roles-and-access',
      'site-health-and-logs',
      'website-stats',
      'working-with-leads',
      'your-account',
    ]);
  });

  it('a guide naming no capability is every member’s; one naming only unknown ones is no one’s', () => {
    for (const role of ROLES) {
      expect(mayRead(role, [])).toBe(true);
      expect(mayRead(role, ['help.edit', 'nothing.here'])).toBe(false);
    }
    expect(mayRead('content_creator', ['nothing.here', 'blog.write'])).toBe(true);
  });

  it('a partial access counts: view (Content Creator, entity SEO) and meta (SEO, media)', () => {
    expect(mayRead('content_creator', ['seo.entityMeta'])).toBe(true);
    expect(mayRead('seo', ['media.write'])).toBe(true);
  });
});

describe('the shared rules', () => {
  it('a screen covers its own pages, never a sibling; the dashboard covers only itself', () => {
    expect(isOnScreen(['/admin/services'], '/admin/services')).toBe(true);
    expect(isOnScreen(['/admin/services'], '/admin/services/1234')).toBe(true);
    expect(isOnScreen(['/admin/services'], '/admin/service-cases')).toBe(false);
    expect(isOnScreen(['/admin'], '/admin')).toBe(true);
    expect(isOnScreen(['/admin'], '/admin/leads')).toBe(false);
  });

  it('a screen is an admin path or nothing', () => {
    expect(screenOf('/admin/leads')).toBe('/admin/leads');
    expect(screenOf('/admin/leads/')).toBe('/admin/leads');
    expect(screenOf('/admin')).toBe('/admin');
    expect(screenOf('/about')).toBeNull();
    expect(screenOf('/admin/../x')).toBeNull();
    expect(screenOf('https://example.test/admin')).toBeNull();
    expect(screenOf('/admin/x?y=1')).toBeNull();
    expect(screenOf(`/admin/${'a'.repeat(200)}`)).toBeNull();
    expect(screenOf(null)).toBeNull();
  });

  it('links carry the slug and the screen encoded', () => {
    expect(guideHref('your-account')).toBe('/admin/help?guide=your-account');
    expect(helpHrefFor('/admin/leads')).toBe('/admin/help?screen=%2Fadmin%2Fleads');
  });

  it('related: other guides sharing a tag, from the given list only, at most three', () => {
    const g = (slug: string, tags: string[]): HelpGuide => ({
      slug,
      title: slug,
      minutes: 1,
      tags,
    });
    const list = [
      g('a', ['x']),
      g('b', ['x', 'y']),
      g('c', ['z']),
      g('d', ['y']),
      g('e', ['x']),
      g('f', ['x']),
    ];
    expect(relatedTo({ slug: 'a', tags: ['x'] }, list).map((r) => r.slug)).toEqual(['b', 'e', 'f']);
    expect(relatedTo({ slug: 'c', tags: ['z'] }, list)).toEqual([]);
  });

  it('a query is cleaned as the header search cleans one', () => {
    expect(cleanHelpQuery('  pass\u0000word\n ')).toBe('password');
    expect(cleanHelpQuery('x'.repeat(100))).toHaveLength(HELP_LIMITS.query);
  });
});

// ── 3. The loaders and the routes ───────────────────────────────────────────────────────

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const auth = (role: Role): AuthContext => ({
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: TENANT,
  role,
  isActive: true,
  email: 'person@example.test',
});

const rowOf = (a: HelpArticleRow) => ({ ...a, id: `id-${a.slug}`, search_text: 'x' });

interface Calls {
  filters: [string, unknown][];
  rpc: { fn: string; args: Record<string, unknown> }[];
}

/** A Supabase stand-in: the table answers `rows` (or `row` for a single read), the RPC `rpc`. */
function fakeDb(answer: { rows?: unknown[]; row?: unknown; rpc?: unknown[]; error?: string }) {
  const calls: Calls = { filters: [], rpc: [] };
  const error = answer.error ? { message: answer.error, code: 'XX000' } : null;
  const builder: Record<string, unknown> = {};
  for (const op of ['select', 'order', 'limit']) builder[op] = () => builder;
  builder['eq'] = (column: string, value: unknown) => {
    calls.filters.push([column, value]);
    return builder;
  };
  builder['maybeSingle'] = async () => ({ data: error ? null : (answer.row ?? null), error });
  builder['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolve({ data: error ? null : (answer.rows ?? []), error }));
  const sb = {
    from: () => builder,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.rpc.push({ fn, args });
      return { data: error ? null : (answer.rpc ?? []), error };
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

describe('the loaders', () => {
  const ALL = SET.map(rowOf);

  it('the list is the role’s guides, read from the caller’s tenant, with the screen’s first', async () => {
    const { sb, calls } = fakeDb({ rows: ALL });
    const index = await loadHelpIndex(sb, auth('content_creator'), '/admin/services/123');
    expect(calls.filters).toEqual([['tenant_id', TENANT]]);
    expect(index.guides.map((g) => g.slug)).toEqual(
      SET.filter((a) => mayRead('content_creator', a.caps)).map((a) => a.slug),
    );
    expect(index.onScreen).toEqual(['saving-and-publishing']);
    // Nothing but what a list shows leaves the server.
    expect(Object.keys(index.guides[0] ?? {}).sort()).toEqual(['minutes', 'slug', 'tags', 'title']);
  });

  it('no screen, nothing on it', async () => {
    const { sb } = fakeDb({ rows: ALL });
    expect((await loadHelpIndex(sb, auth('admin'), null)).onScreen).toEqual([]);
  });

  it('a row the schema refuses is left out and logged by its slug', async () => {
    logs.length = 0;
    const broken = { ...rowOf(SET[0]!), slug: 'broken-row', body: '<p>html</p>' };
    const { sb } = fakeDb({
      rows: [broken, { ...rowOf(SET[0]!), title: '<b>x</b>', slug: 'bad-title' }],
    });
    // The list does not read bodies, so only the title breaks the list's schema.
    const index = await loadHelpIndex(sb, auth('admin'), null);
    expect(index.guides.map((g) => g.slug)).toEqual(['broken-row']);
    expect(JSON.stringify(logs)).toContain('bad-title');
  });

  it('a refused read is logged and thrown (the route answers 500)', async () => {
    logs.length = 0;
    const { sb } = fakeDb({ error: 'permission denied for table help_articles' });
    await expect(loadHelpIndex(sb, auth('admin'), null)).rejects.toThrow();
    expect(JSON.stringify(logs)).toContain('admin:help');
  });

  it('search: under two characters asks nothing; else the RPC with the caller’s tenant', async () => {
    const short = fakeDb({ rpc: ALL });
    expect(await searchHelp(short.sb, auth('admin'), ' a ')).toEqual([]);
    expect(short.calls.rpc).toEqual([]);

    const { sb, calls } = fakeDb({ rpc: ALL });
    const results = await searchHelp(sb, auth('seo'), '  redirect\u0007 ');
    expect(calls.rpc).toEqual([{ fn: 'help_search', args: { p_tenant: TENANT, p_q: 'redirect' } }]);
    // The RPC answered every guide; the role's filter still applies.
    expect(results.map((r) => r.slug)).toEqual(
      SET.filter((a) => mayRead('seo', a.caps)).map((a) => a.slug),
    );
  });

  it('a guide the role may not read is the same as no guide', async () => {
    const leads = SET.find((a) => a.slug === 'working-with-leads')!;
    const { sb, calls } = fakeDb({ row: rowOf(leads) });
    expect(await loadHelpArticle(sb, auth('content_creator'), leads.slug)).toBeNull();
    expect(calls.filters).toEqual([
      ['tenant_id', TENANT],
      ['slug', leads.slug],
    ]);
    const dev = fakeDb({ row: rowOf(leads) });
    const article = await loadHelpArticle(dev.sb, auth('developer'), leads.slug);
    expect(article?.titleAr).toBe(leads.title_ar);
    expect(article?.body).toEqual(leads.body);
    expect(await loadHelpArticle(fakeDb({}).sb, auth('admin'), 'nope')).toBeNull();
  });

  it('a guide whose body the schema refuses is not shown, and is logged', async () => {
    logs.length = 0;
    const { sb } = fakeDb({
      row: { ...rowOf(SET[0]!), body: { en: [{ t: 'html', x: 'a' }], ar: [] } },
    });
    expect(await loadHelpArticle(sb, auth('admin'), SET[0]!.slug)).toBeNull();
    expect(JSON.stringify(logs)).toContain(SET[0]!.slug);
  });
});

describe('the routes answer what the loaders decide', () => {
  async function call(
    route: () => Promise<Record<string, unknown>>,
    url: string,
    role: Role,
    sb: SupabaseClient,
  ) {
    const { GET } = (await route()) as { GET: APIRoute };
    const full = new URL(url, 'https://admin.example.test');
    const res = (await GET({
      request: new Request(full),
      url: full,
      params: {},
      locals: { session: auth(role), supabase: sb, csrfToken: 't', cspNonce: 't' },
    } as unknown as Parameters<APIRoute>[0])) as Response;
    return { status: res.status, body: (await res.json()) as { data?: unknown } };
  }

  it('GET /api/admin/help: the role’s guides and the screen’s', async () => {
    const { sb } = fakeDb({ rows: SET.map(rowOf) });
    const { status, body } = await call(
      () => import('@/pages/api/admin/help/index'),
      '/api/admin/help?screen=%2Fadmin%2Fleads',
      'developer',
      sb,
    );
    expect(status).toBe(200);
    const data = body.data as { guides: HelpGuide[]; onScreen: string[] };
    expect(data.onScreen).toEqual(['working-with-leads', 'personal-data']);
    expect(data.guides.some((g) => g.slug === 'job-applications')).toBe(false);
  });

  it('GET /api/admin/help/article: 404 for a guide the role may not read', async () => {
    const hiring = SET.find((a) => a.slug === 'job-applications')!;
    const asDev = await call(
      () => import('@/pages/api/admin/help/article'),
      '/api/admin/help/article?slug=job-applications',
      'developer',
      fakeDb({ row: rowOf(hiring) }).sb,
    );
    expect(asDev.status).toBe(404);
    const asAdmin = await call(
      () => import('@/pages/api/admin/help/article'),
      '/api/admin/help/article?slug=job-applications',
      'admin',
      fakeDb({ row: rowOf(hiring) }).sb,
    );
    expect(asAdmin.status).toBe(200);
  });

  it('GET /api/admin/help/article: a slug outside the pattern is a 422, never a read', async () => {
    const { sb, calls } = fakeDb({});
    const { status } = await call(
      () => import('@/pages/api/admin/help/article'),
      "/api/admin/help/article?slug=x'%20or%201=1",
      'admin',
      sb,
    );
    expect(status).toBe(422);
    expect(calls.filters).toEqual([]);
  });

  it('GET /api/admin/help/search: the role’s matches', async () => {
    const { sb } = fakeDb({ rpc: SET.map(rowOf) });
    const { status, body } = await call(
      () => import('@/pages/api/admin/help/search'),
      '/api/admin/help/search?q=lead',
      'content_creator',
      sb,
    );
    expect(status).toBe(200);
    const slugs = (body.data as { results: HelpGuide[] }).results.map((r) => r.slug);
    expect(slugs).not.toContain('working-with-leads');
    expect(slugs).not.toContain('personal-data');
  });
});

describe('the shell', () => {
  it('the topbar’s "?" is a link to the help page for this screen, before the bell', () => {
    const topbar = readFileSync('src/components/admin/ui/Topbar.astro', 'utf8');
    const help = topbar.indexOf('href={helpHrefFor(current)} data-open="help"');
    expect(help).toBeGreaterThan(-1);
    expect(help).toBeLessThan(topbar.indexOf('href="/admin/notifications"'));
  });

  it('the drawer is mounted in the shell’s one island', () => {
    const chrome = readFileSync('src/components/admin/islands/AdminChrome.tsx', 'utf8');
    expect(chrome).toContain('<HelpDrawer />');
  });

  it('the page head offers the screen’s guide, decided by the layout from the role', () => {
    const layout = readFileSync('src/layouts/AdminLayout.astro', 'utf8');
    expect(layout).toContain('pageGuideFor(path, session.role)');
    expect(layout).toContain('guide={guide}');
    const head = readFileSync('src/components/admin/ui/PageHead.astro', 'utf8');
    expect(head).toMatch(
      /href=\{guideHref\(guide\)\}\s+data-open="help"\s+data-help-guide=\{guide\}/,
    );
  });
});
