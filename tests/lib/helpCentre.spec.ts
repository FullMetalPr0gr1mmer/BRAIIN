import { readFileSync, readdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ROLES, type AuthContext, type Role } from '@/lib/auth/types';
import { CAPABILITIES, ROLE_CAPS } from '@/lib/authz/matrix';
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
  MAX_GUIDES,
  MAX_RESULTS,
  mayRead,
  PAGE_GUIDES,
  pageGuideFor,
  relatedTo,
  screenOf,
  searchHelp,
  type HelpGuide,
} from '@/lib/admin/help';
import HelpArticleBody from '@/components/admin/screens/help/HelpArticleBody';
import HelpGuideList from '@/components/admin/screens/help/HelpGuideList';
import { EXTRA_LINKS, pageFileFor } from '../admin/routes';
import { MAX_GOALS } from '@schemas/analyticsGoals';
import { DEFAULT_TIME_ZONE } from '@schemas/timeZones';
import {
  ACTIVE_MINUTES,
  REALTIME_AUTO_STOP_MS,
  REALTIME_KEEP_HOURS,
  REALTIME_POLL_MS,
} from '@/lib/admin/stats/realtimeView';
import {
  helpSet,
  helpSetViolations,
  literalSet,
  pinnedGuideCounts,
  readMigrations,
  readPgTapFiles,
} from '../fixtures/helpSet';

const { logs } = vi.hoisted(() => ({ logs: [] as unknown[] }));
vi.mock('@/lib/data/systemLog', () => ({
  writeSystemLog: async (entry: unknown) => {
    logs.push(entry);
    return true;
  },
}));

// The help centre (Admin v2 U16). Three things are held here:
//   1. The guides the migrations seed (app.help_article_set(): the last restatement before
//      H11's catalog plus every app.put_help_guide and app.drop_help_guide since) keep the rules no CHECK can see: the schema the Worker
//      reads with, every capability one ROLE_CAPS names, every screen an admin page, each
//      reader of a guide able to open one of its screens, Arabic block for block with the
//      English, no dash the copy rules forbid (P-12), no brand spelled (CLAUDE.md §1).
//   2. Which guides each role is shown (the server's filter, from ROLE_CAPS), pinned role by
//      role, and the pure rules the drawer shares (the screen match, related, the query).
//   3. The loaders and routes: tenant-scoped, the role's guides only, a refused row logged.
// RLS and the CHECKs themselves are proven in supabase/tests/help_centre.test.sql.

// ── 1. The set ──────────────────────────────────────────────────────────────────────────

const MIGRATIONS = 'supabase/migrations';

// The guides the migrations leave (tests/fixtures/helpSet.ts): the last restatement of
// app.help_article_set() before H11's catalog, then every app.put_help_guide and
// app.drop_help_guide after it, in order. SET_FILE is that restatement.
const MIGRATION_FILES = readMigrations();
const HELP = helpSet(MIGRATION_FILES);
const { base: SET_FILE, set: RAW_SET } = HELP;

/**
 * The restatement G2's 0067 was built from (w3 corrections rule 1): the latest set on main
 * when it merges. Re-based with scratchpad/hs_rebase.py when a sibling restates it first.
 */
const G2_PREVIOUS_SET = '0065_help_leads_v2.sql';

/**
 * Guides written as files and not yet put by a migration (docs/admin-v2/guides/<slug>.json):
 * a slice built before H11's catalog (app.put_help_guide) reached main writes its guide there,
 * and its migration carries a TODO where the put goes. Until then the file is held to every
 * rule below as if seeded. A new guide's file joins the set; an edited guide's file
 * (PENDING_EDITS) replaces the seeded text, which still describes the old screen. Once a
 * migration puts the slug, the file must equal what it seeds (`filed guides` below), and an
 * edit leaves PENDING_EDITS.
 */
const GUIDE_FILES = 'docs/admin-v2/guides';
const FILED: { file: string; raw: { slug?: unknown } }[] = readdirSync(GUIDE_FILES)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => ({
    file,
    raw: JSON.parse(readFileSync(`${GUIDE_FILES}/${file}`, 'utf8')) as { slug?: unknown },
  }));
/**
 * Edited guides filed but not yet put: none. (Admin v2 U10's seo-and-redirects is put by 0073
 * now that H11's catalog is on main; its file equals what the migration seeds.)
 */
const PENDING_EDITS = new Set<unknown>([]);
const seededSlugs = new Set(RAW_SET.map((raw) => (raw as { slug?: unknown }).slug));
const PENDING_RAW: unknown[] = FILED.filter(
  (f) => !seededSlugs.has(f.raw.slug) || PENDING_EDITS.has(f.raw.slug),
).map((f) => f.raw);
const SET: HelpArticleRow[] = [
  ...RAW_SET.filter((raw) => !PENDING_EDITS.has((raw as { slug?: unknown }).slug)),
  ...PENDING_RAW,
]
  .map((raw) => HelpArticleSeedSchema.parse(raw))
  .sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug));

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

/**
 * The screens every member reaches outside the menu: the sweep's extras that need no
 * capability, and the help page. An extra that needs one (a filtered view of a menu screen)
 * is reached by its holders through the menu already.
 */
const MEMBER_SCREENS = new Set([
  ...EXTRA_LINKS.filter((link) => link.caps.length === 0).map(
    (link) => link.href.split('?')[0] ?? link.href,
  ),
  '/admin/help',
]);
const reaches = (role: Role, screen: string) =>
  MEMBER_SCREENS.has(screen) || reachableHrefs(role).includes(screen);

describe(`the guides the migrations seed (${SET_FILE})`, () => {
  it('is read from the last restatement before the catalog, plus every put and drop since', () => {
    expect(SET_FILE).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    expect(SET.length).toBeGreaterThanOrEqual(12);
  });

  it('the set stays under the read cap, so the role filter always sees every guide', () => {
    // The list and the search read at most MAX_GUIDES rows and filter them by role after;
    // a set past the cap would let other roles' guides push a role's own out of the read.
    expect(SET.length).toBeLessThanOrEqual(MAX_GUIDES);
  });

  it('every guide keeps the schema the Worker reads with (strict: no unknown key)', () => {
    for (const raw of [...RAW_SET, ...PENDING_RAW]) {
      expect(() => HelpArticleSeedSchema.parse(raw)).not.toThrow();
    }
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

  it('the roles guide says what a role change ends at once, and the hour that remains', () => {
    // CLAUDE.md §2 (session invalidation) and §3, as Admin v2 U12a (0055) leaves them: a role
    // change or a switched-off account ends every session of that person in the database
    // (profiles_revoke_sessions), so the admin turns them away at their next click; but an
    // access token already issued keeps its role at the database directly until it expires
    // (an hour) on the tables with no live check. People and roles (0050, 0055), the security
    // settings (0055), leads and the CRM (app.live_role()), job applications
    // (app.is_live_admin()) and the activity log (0054, U13's audit_log_live_read, applied
    // before 0055) close at once. The guide an Admin reads says exactly that, and never
    // promises the database forgets an issued pass at once.
    const roles = SET.find((a) => a.slug === 'roles-and-access')!;
    const en = textsOf(roles, 'en').join('\n');
    const ar = textsOf(roles, 'ar').join('\n');
    expect(en).toContain('ends every sign-in the person has, on every device');
    expect(en).toContain('the admin turns them away at their next click');
    expect(en).toContain(
      'a sign-in pass already handed out keeps working for up to an hour when someone uses it directly against the database',
    );
    expect(en).toContain('On settings, media, the system logs and content');
    expect(en).toContain(
      'People and their roles, the security settings, leads, job applications and the activity log check',
    );
    expect(ar).toContain('وطلبات التوظيف، وسجل النشاط فتتحقق من حساب الشخص');
    expect(ar).toContain('وسجلات النظام');
    expect(en).toContain('Make account owner');
    expect(en).toContain('1 day or 7 days');
    for (const text of textsOf(roles, 'en')) {
      // The database is never said to drop an issued pass at once.
      expect(text).not.toMatch(/\b(pass|token)\b[^.]*\b(at once|immediately|straight away)\b/i);
    }
    expect(ar).toContain('يُنهي ذلك كل جلسات دخول الشخص على كل أجهزته');
    expect(ar).toContain('يبقى صالحًا حتى ساعة');
    expect(ar).toContain('Make account owner');
    expect(ar).not.toContain('يسجّل خروجه فورًا');
  });

  it('the dollar-quote cannot end early: no text holds the literal’s tag', () => {
    for (const article of SET) {
      for (const text of textsOf(article)) expect(text.includes('$help$')).toBe(false);
    }
  });

  it('nor the tag of a put’s literal ($guide$, H11)', () => {
    for (const article of SET) {
      for (const text of textsOf(article)) expect(text.includes('$guide$')).toBe(false);
    }
  });
});

// ── 1b. The catalog (H11): a slice puts its own guide; nobody restates the set ────────────
// 0069 (numbered at merge) moved the guides into app.help_guide_catalog, filled from the set
// as the database held it. A later migration adds or changes one guide with a top-level
// `select app.put_help_guide($guide$ {...} $guide$::jsonb, N);` and retires one with
// `select app.drop_help_guide('slug', N);`, N the guide's revision (0 for a new guide). The
// reader (tests/fixtures/helpSet.ts) is held here.

describe('the help-guide catalog (H11)', () => {
  const restatement = (name: string, guides: object[]) => ({
    name,
    sql: [
      'create or replace function app.help_article_set() returns jsonb',
      "  language sql immutable set search_path = '' as $fn$",
      '  select $help$',
      JSON.stringify(guides),
      '$help$::jsonb',
      '$fn$;',
      '',
    ].join('\n'),
  });
  const catalog = {
    name: '0003_help_catalog.sql',
    sql: [
      'create table if not exists app.help_guide_catalog (slug text primary key);',
      'create or replace function app.help_article_set() returns jsonb language sql stable as $$ select 1 $$;',
      'create or replace function app.put_help_guide(p_guide jsonb, p_revision int) returns void as $$ $$;',
      "  perform app.put_help_guide('{}'::jsonb, 0);",
      '',
    ].join('\n'),
  };
  const guide = (slug: string, sort_order: number, title = slug) => ({ slug, sort_order, title });
  const put = (g: object, revision: number) =>
    [
      'select app.put_help_guide($guide$',
      JSON.stringify(g, null, 2),
      `$guide$::jsonb, ${revision});`,
      '',
    ].join('\n');
  const fileNamed = (name: string | null) => {
    const file = MIGRATION_FILES.find((f) => f.name === name);
    if (!file) throw new Error(`no migration ${String(name)}`);
    return file;
  };

  it('the catalog is made once, after the last restatement, from the set as it stood', () => {
    expect(HELP.catalog).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    expect(HELP.base < (HELP.catalog ?? '')).toBe(true);
    const sql = fileNamed(HELP.catalog).sql;
    // Filled from the function, so it is right after whichever restatement landed last.
    expect(sql).toContain('from jsonb_to_recordset(app.help_article_set())');
    expect(sql).not.toContain('$help$');
    expect(
      MIGRATION_FILES.filter((f) =>
        /create table if not exists app\.help_guide_catalog\b/.test(f.sql),
      ),
    ).toHaveLength(1);
  });

  it('no migration after it restates the set, or writes the catalog but through put and drop', () => {
    expect(helpSetViolations(MIGRATION_FILES)).toEqual([]);
  });

  it('no pgTAP file pins how many guides there are: a count is a floor (rule 7)', () => {
    // A pinned count fails CI for the next slice that puts a guide (G2's health_probes did).
    expect(pinnedGuideCounts(readPgTapFiles())).toEqual([]);
    // What the scan sees, and what it leaves alone.
    const files = [
      {
        name: 'a.test.sql',
        sql: [
          'select is((select count(*)::int from jsonb_array_elements(app.help_article_set())), 15,',
          "  'the set holds 0061''s fifteen (guides)');",
          'select is(jsonb_array_length(app.help_article_set()), 16, $$x, (y)$$);',
          "select is(_set_size(), 15, 'a helper of the set');",
          'select is((select count(*) from app.help_guide_catalog), 15, null);',
          "-- select is(_set_size(), 15, 'a comment');",
          "select ok(_set_size() >= 15, 'a floor');",
          "select is(_set_size(), _seen(), 'a count against a count');",
          "select is((select count(*)::int from app.help_guide_catalog where revision < 1), 0, 'x');",
          "select is(app.help_article_set() -> -1 ->> 'slug', 'h11-test-guide', 'a slug');",
          "select is(_rev('website-stats'), 1, 'a revision');",
        ].join('\n'),
      },
    ];
    expect(pinnedGuideCounts(files)).toEqual([
      'a.test.sql:1: pins the number of guides at 15; count them as a floor (>=)',
      'a.test.sql:3: pins the number of guides at 16; count them as a floor (>=)',
      'a.test.sql:4: pins the number of guides at 15; count them as a floor (>=)',
      'a.test.sql:5: pins the number of guides at 15; count them as a floor (>=)',
    ]);
  });

  it('a guide no put or drop has named since is the base set’s, byte for byte', () => {
    const base = literalSet(fileNamed(HELP.base));
    const edited = new Set(HELP.edits.map((e) => e.slug));
    for (const g of base.filter((b) => !edited.has(b.slug))) {
      expect(
        RAW_SET.find((a) => (a as { slug: string }).slug === g.slug),
        g.slug,
      ).toEqual(g);
    }
    // And a guide the base did not hold is one a put added.
    for (const article of SET.filter((a) => !base.some((g) => g.slug === a.slug))) {
      expect(edited.has(article.slug), article.slug).toBe(true);
    }
  });

  it('put’s nine keys are the keys the seed schema holds a guide to', () => {
    const sql = fileNamed(HELP.catalog).sql;
    const keys = /v_keys constant text\[\] := array\[([^\]]*)\]/.exec(sql)?.[1] ?? '';
    expect(keys.match(/'[a-z_]+'/g)?.map((k) => k.slice(1, -1))).toEqual(
      Object.keys(HelpArticleSeedSchema.shape).sort(),
    );
  });

  it('the reader follows puts and drops in order, and lists the set by place', () => {
    const files = [
      restatement('0001_a.sql', [guide('alpha', 10), guide('beta', 20), guide('gamma', 30)]),
      restatement('0002_b.sql', [guide('alpha', 10), guide('beta', 20, 'Beta 2')]),
      catalog,
      {
        name: '0004_c.sql',
        // A new guide at 0; alpha changed at 1, then put again unchanged at 2.
        sql:
          put(guide('delta', 15), 0) +
          put(guide('alpha', 10, 'Alpha 2'), 1) +
          put(guide('alpha', 10, 'Alpha 2'), 2),
      },
      {
        name: '0005_d.sql',
        sql: "-- select app.drop_help_guide('alpha', 9);\nselect app.drop_help_guide('beta', 1);\n",
      },
      // Back after its drop: a new guide again, at 0.
      { name: '0006_e.sql', sql: put(guide('beta', 25, 'Beta 3'), 0) },
    ];
    const read = helpSet(files);
    expect(read.base).toBe('0002_b.sql');
    expect(read.catalog).toBe('0003_help_catalog.sql');
    expect(read.edits).toEqual([
      { file: '0004_c.sql', op: 'put', slug: 'delta', revision: 0 },
      { file: '0004_c.sql', op: 'put', slug: 'alpha', revision: 1 },
      { file: '0004_c.sql', op: 'put', slug: 'alpha', revision: 2 },
      { file: '0005_d.sql', op: 'drop', slug: 'beta', revision: 1 },
      { file: '0006_e.sql', op: 'put', slug: 'beta', revision: 0 },
    ]);
    expect(Object.fromEntries(read.revisions)).toEqual({ alpha: 2, delta: 1, beta: 1 });
    expect(read.set).toEqual([
      guide('alpha', 10, 'Alpha 2'),
      guide('delta', 15),
      guide('beta', 25, 'Beta 3'),
    ]);
    expect(helpSetViolations(files)).toEqual([]);
    // Before the catalog, the last restatement is the set.
    expect(helpSet(files.slice(0, 2)).set).toEqual([
      guide('alpha', 10),
      guide('beta', 20, 'Beta 2'),
    ]);
    expect(helpSet(files.slice(0, 2)).catalog).toBeNull();
  });

  it('a drop of a guide the set does not hold fails, as the database refuses it (P0002)', () => {
    const files = [
      restatement('0001_a.sql', [guide('alpha', 10)]),
      catalog,
      { name: '0004_c.sql', sql: "select app.drop_help_guide('beta', 1);\n" },
    ];
    expect(() => helpSet(files)).toThrow(/drops beta/);
  });

  it('two slices that edit one guide: the second names a revision the guide has left, and fails (55000)', () => {
    // What scratchpad/hs_rebase.py refused before the catalog: a slice built on a guide's
    // older text would otherwise revert the sibling's edit that landed first.
    const base = [restatement('0001_a.sql', [guide('alpha', 10)]), catalog];
    const first = { name: '0004_first.sql', sql: put(guide('alpha', 10, 'First'), 1) };
    const second = { name: '0005_second.sql', sql: put(guide('alpha', 10, 'Second'), 1) };
    expect(() => helpSet([...base, first, second])).toThrow(
      /0005_second\.sql: puts alpha at revision 1, but the migrations before it leave it at 2/,
    );
    // Re-based on the first (its text, revision 2), it lands.
    const rebased = {
      name: '0005_second.sql',
      sql: put(guide('alpha', 10, 'First, then second'), 2),
    };
    expect(helpSet([...base, first, rebased]).set).toEqual([
      guide('alpha', 10, 'First, then second'),
    ]);
    // A new guide must be new (0), and a drop names the revision it retires.
    expect(() =>
      helpSet([...base, { name: '0004_x.sql', sql: put(guide('alpha', 20), 0) }]),
    ).toThrow(/puts alpha at revision 0/);
    expect(() =>
      helpSet([
        ...base,
        first,
        { name: '0005_x.sql', sql: "select app.drop_help_guide('alpha', 1);\n" },
      ]),
    ).toThrow(/drops alpha at revision 1/);
  });

  it('every guide is at the revision the catalog holds it at, and the next edit of it must name', () => {
    for (const article of SET) {
      expect(HELP.revisions.get(article.slug), article.slug).toBeGreaterThanOrEqual(1);
    }
    expect(HELP.revisions.size).toBe(SET.length);
  });

  it('what the reader cannot follow is named, never skipped', () => {
    const files = [
      restatement('0001_a.sql', [guide('alpha', 10)]),
      catalog,
      restatement('0004_restates.sql', [guide('alpha', 10)]),
      {
        name: '0005_shapes.sql',
        sql: [
          '-- A comment may name app.put_help_guide( freely.',
          'do $$ begin',
          `  perform app.put_help_guide('{"slug": "x"}'::jsonb, 0);`,
          'end $$;',
          "  select app.drop_help_guide('alpha', 1);",
          "insert into app.help_guide_catalog (slug) values ('x');",
          "update app.help_guide_catalog set title = 'y';",
          "select app.drop_help_guide('alpha');",
          "select app.drop_help_guide('alpha', 1);",
        ].join('\n'),
      },
    ];
    expect(helpSetViolations(files)).toEqual([
      '0004_restates.sql: restates app.help_article_set(); use app.put_help_guide',
      '0004_restates.sql: holds a $help$ literal',
      '0005_shapes.sql:3: calls put/drop in a shape the reader cannot follow',
      '0005_shapes.sql:5: calls put/drop in a shape the reader cannot follow',
      '0005_shapes.sql:6: writes app.help_guide_catalog other than through put/drop',
      '0005_shapes.sql:7: writes app.help_guide_catalog other than through put/drop',
      // A drop without its revision is not read as one.
      '0005_shapes.sql:8: calls put/drop in a shape the reader cannot follow',
    ]);
  });
});

// ── 1c. The guides say only what the admin does ──────────────────────────────────────────
// Each claim a guide makes about the admin is held to the code that makes it true (U16's
// pre-merge review), so a change to that code fails here until the guide is rewritten.

describe('the guides say only what the admin does', () => {
  const guide = (slug: string, lang: 'en' | 'ar') => {
    const article = SET.find((a) => a.slug === slug);
    if (!article) throw new Error(`no guide ${slug}`);
    return textsOf(article, lang).join('\n');
  };
  const everything = (lang: 'en' | 'ar') => SET.map((a) => textsOf(a, lang).join('\n')).join('\n');
  const source = (path: string) => readFileSync(path, 'utf8');
  /** U17's migration, found by its name: its number is assigned at merge. */
  const twoStepMigration = () => {
    const file = MIGRATION_FILES.find((f) => f.name.endsWith('_two_step_sign_in.sql'));
    if (!file) throw new Error('no two-step migration');
    return file;
  };
  /** Every .ts, .tsx and .astro file below a directory, as paths from the repository root. */
  const codeIn = (dir: string) =>
    (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
      .map((f) => f.replaceAll('\\', '/'))
      .filter((f) => /\.(ts|tsx|astro)$/.test(f))
      .map((f) => `${dir}/${f}`);

  it('two factor authentication (U17): the guides say what /admin/2fa and Users & roles do', () => {
    const en = guide('your-account', 'en');
    const panel = source('src/components/admin/screens/twoStep/TwoStepPanel.astro');
    const account = source('src/components/admin/screens/chrome/AccountPanel.tsx');
    // The row in the account, its two links, and the setup step's words.
    expect(account).toContain('<span className="li__t">Two factor authentication</span>');
    expect(account).toContain("{view.twoStep.on ? 'Manage' : 'Set up'}");
    expect(en).toContain('open Two factor authentication in your account and choose Set up');
    expect(en).toContain('choose Manage and type a current code');
    for (const words of ['Add it to the app', 'Turn on 2FA', 'Set up']) {
      expect(panel, words).toContain(words);
      expect(en, words).toContain(words);
    }
    // The setup step shows a key and a link, never a QR code (as-built U17): the guide too.
    expect(panel).not.toContain('<svg');
    expect(en).toContain('type the key the page shows');
    expect(en).not.toMatch(/\bQR\b|scan/i);
    // Wrong codes count as wrong passwords do (src/lib/auth/twoStepFlow.ts, lockout.ts).
    const lockout = source('src/lib/auth/lockout.ts');
    expect(lockout).toContain('LOCKOUT_THRESHOLD = 5;');
    expect(lockout).toContain('LOCKOUT_WINDOW_MINUTES = 15;');
    expect(lockout).toContain('LOCKOUT_DURATION_MINUTES = 15;');
    expect(source('src/lib/auth/twoStepFlow.ts')).toContain('registerFailure(email, input.ip)');
    expect(en).toContain(
      'Five wrong codes within 15 minutes lock your account for 15 minutes, as wrong passwords do.',
    );
    // Turning it off is refused while the team requires it.
    expect(panel).toContain("view.mode === 'manage' && !view.required");
    expect(en).toContain('If your team requires 2FA, it stays on.');
    // A lost phone: an Admin's Reset 2FA, which signs the person out everywhere.
    expect(en).toContain('Ask an Admin to reset your 2FA in Users & roles');
    const migration = twoStepMigration().sql;
    expect(migration).toContain('delete from auth.sessions where user_id = p_user;');
    const roles = guide('roles-and-access', 'en');
    const card = source('src/components/admin/screens/users/SecurityCard.tsx');
    expect(card).toContain('Require 2FA for everyone');
    expect(card).toContain('People without it are asked to set it up at their next click.');
    expect(roles).toContain('Require 2FA for everyone, on the same card, asks everyone');
    expect(roles).toContain('to set it up at their next click');
    expect(source('src/lib/admin/userModel.ts')).toContain(
      "REQUIRE_MFA_SELF_FIRST = 'Turn on 2FA for your own account first.'",
    );
    expect(roles).toContain('Turn on 2FA for your own account first');
    expect(source('src/components/admin/screens/users/EditUserDrawer.tsx')).toContain('Reset 2FA');
    expect(roles).toContain('chooses Reset 2FA');
    expect(roles).toContain('they are signed out on every device');
    expect(migration).toContain("message = 'owner_protected'");
    expect(migration).toContain("message = 'self'");
    expect(roles).toContain("nor the account owner's");
    // Both languages say it: the Arabic names the same screens and buttons.
    for (const words of ['Two factor authentication', 'Set up', 'Turn on 2FA', 'Manage']) {
      expect(guide('your-account', 'ar'), words).toContain(words);
    }
    for (const words of ['Require 2FA for everyone', 'Reset 2FA', 'Users & roles']) {
      expect(guide('roles-and-access', 'ar'), words).toContain(words);
    }
  });

  it('U17 puts only its two guides, and keeps their place, title, caps and tags', () => {
    // The two-step migration (numbered at merge) changes your-account and roles-and-access
    // with app.put_help_guide (H11) and adds no guide.
    const name = twoStepMigration().name;
    expect(HELP.edits.filter((e) => e.file === name)).toEqual([
      { file: name, op: 'put', slug: 'your-account', revision: 1 },
      { file: name, op: 'put', slug: 'roles-and-access', revision: 1 },
    ]);
    const base = new Map(
      literalSet(MIGRATION_FILES.find((f) => f.name === SET_FILE)!)
        .map((raw) => HelpArticleSeedSchema.parse(raw))
        .map((a) => [a.slug, a]),
    );
    // The set as the two-step migration leaves it: a later slice (C10a's 0097) puts
    // roles-and-access again on top of these blocks, and its own test holds that.
    const throughU17 = helpSet(
      MIGRATION_FILES.slice(0, MIGRATION_FILES.indexOf(twoStepMigration()) + 1),
    ).set.map((raw) => HelpArticleSeedSchema.parse(raw));
    for (const slug of ['your-account', 'roles-and-access']) {
      const before = base.get(slug)!;
      const after = throughU17.find((a) => a.slug === slug)!;
      const keep = ({ slug: s, sort_order, title, title_ar, caps, tags }: HelpArticleRow) => ({
        s,
        sort_order,
        title,
        title_ar,
        caps,
        tags,
      });
      expect(keep(after), slug).toEqual(keep(before));
      // Only blocks added: every block the guide had stays, in order.
      for (const lang of ['en', 'ar'] as const) {
        const kept = after.body[lang].filter((block) =>
          before.body[lang].some((b) => JSON.stringify(b) === JSON.stringify(block)),
        );
        expect(kept, `${slug} ${lang}`).toEqual(before.body[lang]);
      }
    }
    // /admin/2fa is your-account's screen (corrections rule 4), offered by its page head.
    expect(SET.find((a) => a.slug === 'your-account')?.screens).toEqual([
      '/admin/account',
      '/admin/notifications',
      '/admin/2fa',
    ]);
    expect(pageGuideFor('/admin/2fa', 'seo')).toBe('your-account');
  });

  it('the activity log names who acted, filters and exports: the guide says what the screen does', () => {
    // Since U13 (0054) the screen names the person (public.audit_people, former members
    // included) beside the role, filters by kind, person and day, and exports a CSV under
    // the lockdown; the database binds who and when (0050).
    const audit = source('src/pages/admin/audit.astro');
    expect(audit).toContain("{ key: 'who', label: 'Who', kind: 'person' }");
    expect(source('src/lib/admin/activity.ts')).toContain("sb.rpc('audit_people'");
    expect(audit).toContain('/api/admin/audit/export');
    const en = guide('site-health-and-logs', 'en');
    expect(en).toContain('each against the account that made it');
    expect(en).toContain('names the person, former members included');
    expect(en).toContain('so nobody can record something in someone else');
    expect(en).toContain('a kind of activity, a person or a range of days');
    expect(en).toContain('up to three times an hour');
    expect(en).toContain('never what they hold');
    expect(en).not.toContain('The screen lists the time, the role');
    expect(guide('site-health-and-logs', 'ar')).toContain('اسم الشخص');
    expect(guide('personal-data', 'en')).toContain('recorded against your account, with the time');
  });

  it('the activity log export allows what the guide says: three an hour, recorded', async () => {
    const { EXPORT_LIMITS } = await import('@/lib/admin/rateLimit');
    expect(EXPORT_LIMITS.perUser).toBe(3);
    expect(EXPORT_LIMITS.windowMinutes).toBe(60);
    const route = source('src/pages/api/admin/audit/export.ts');
    expect(route).toContain("claimPrivilegedOp(auth, 'export-activity')");
    expect(route).toContain("action: 'export.activity.attempt'");
  });

  it('media: every role edits alt text and tags; uploading, replacing and deleting depend on the role (U4)', () => {
    // SEO holds media.write at 'meta': since U4 the library's drawer saves through the meta
    // door for every role, and only the drawer calls it.
    expect(ROLE_CAPS.seo['media.write']).toBe('meta');
    const callers = [...codeIn('src/components'), ...codeIn('src/lib/admin')].filter((file) =>
      /`\/api\/admin\/media\/meta\/\$\{/.test(source(file)),
    );
    expect(callers).toEqual(['src/components/admin/screens/media/MediaDrawer.tsx']);
    expect(source('src/pages/api/admin/media/meta/[id].ts')).toContain("access: ['full', 'meta']");
    const en = guide('media-library', 'en');
    expect(en).toContain('If you do not see Upload, you can still change alt text and tags.');
    expect(en).toContain('Uploading, replacing and deleting depend on your role.');
    expect(en).toContain('Only an Admin can delete a picture');
    expect(ROLES.filter((role) => ROLE_CAPS[role]['media.hardDelete'] === 'full')).toEqual([
      'admin',
    ]);
    expect(guide('media-library', 'ar')).toContain('الرفع والاستبدال والحذف بحسب دورك');
  });

  it('media: the numbers the guide gives are the code’s (U4)', async () => {
    const media = await import('@schemas/media');
    const { MEDIA_UPLOAD_LIMITS } = await import('@/lib/admin/rateLimit');
    const en = guide('media-library', 'en');
    const ar = guide('media-library', 'ar');
    expect(media.MEDIA_UPLOAD_MAX_BYTES).toBe(20_000_000);
    expect(en).toContain('up to 20 MB each');
    expect(ar).toContain('حتى 20 MB');
    expect(media.MEDIA_LONG_EDGE_PX).toBe(2560);
    expect(en).toContain('at most 2,560 pixels');
    expect(ar).toContain('2,560 بكسل');
    expect([MEDIA_UPLOAD_LIMITS.perUser, MEDIA_UPLOAD_LIMITS.perTenant]).toEqual([50, 100]);
    expect(MEDIA_UPLOAD_LIMITS.windowMinutes).toBe(24 * 60);
    expect(en).toContain('50 pictures a day, and the whole team 100');
    expect(ar).toContain('50 صورة');
    // The refusals the guide names are the sniffer's (src/lib/media/sniff.ts).
    for (const kind of ['SVG', 'GIF', 'HEIC', 'AVIF']) expect(en).toContain(kind);
    // The labels it names are the screen's.
    const screen = [
      source('src/components/admin/screens/media/MediaLibrary.tsx'),
      source('src/components/admin/screens/media/MediaDrawer.tsx'),
      source('src/components/admin/fields/MediaField.tsx'),
      source('src/pages/admin/media/index.astro'),
    ].join('\n');
    for (const label of ['Upload', 'Replace file', 'Used in', 'Needs alt text', 'Choose…']) {
      expect(screen, label).toContain(label);
    }
    expect(en).toContain('about two hours');
  });

  it('the help button is drawn as an i in a circle, and the guides call it that', () => {
    expect(source('src/components/admin/ui/Topbar.astro')).toMatch(
      /data-open="help" aria-label="Help centre">\s*<Icon name="info"/,
    );
    expect(everything('en')).not.toMatch(/question mark/i);
    expect(everything('ar')).not.toContain('علامة الاستفهام');
    expect(guide('finding-your-way', 'en')).toContain(
      'The Help centre button at the top, an i in a circle',
    );
  });

  it('a display name is said to show where it shows: the menu, and Users & roles', () => {
    // The sidebar's account chip and the users list render it; nothing shows it beside a
    // person's work yet.
    expect(source('src/components/admin/ui/Sidebar.astro')).toContain('shell.displayName');
    // Users & roles (U12a) names each person by personName(): the display name first.
    expect(source('src/components/admin/screens/users/UsersPanel.tsx')).toContain(
      'personName(row)',
    );
    expect(source('src/lib/admin/userModel.ts')).toContain('row.displayName?.trim() ||');
    expect(everything('en')).not.toMatch(/beside your work/i);
    expect(everything('ar')).not.toContain('بجانب عملك');
    expect(guide('your-account', 'en')).toContain('to Admins, in Users & roles');
    const panel = source('src/components/admin/screens/chrome/AccountPanel.tsx');
    expect(panel).not.toContain('beside your changes');
    expect(panel).toContain('Shown at the bottom of the menu and, to Admins, in Users & roles.');
  });

  it('SEO defaults are not said to hold organisation details, which the site no longer reads', () => {
    // U10 (D11): the form no longer offers the field at all; its column stays.
    expect(source('src/lib/admin/ui/seo.ts')).not.toMatch(/name: 'organization'/);
    expect(everything('en')).not.toMatch(/organi[sz]ation/i);
    expect(everything('ar')).not.toContain('المؤسسة');
  });

  it('maintenance takes effect within about a minute: the flag is read from KV', () => {
    // KV is eventually consistent: a write reaches every location within about a minute.
    expect(source('src/lib/http/maintenance.ts')).toContain(
      "MAINTENANCE_KV_KEY = 'site:maintenance'",
    );
    const en = guide('maintenance-mode', 'en');
    expect(en).toContain('within about a minute');
    expect(en).not.toMatch(/at once/);
    expect(guide('maintenance-mode', 'ar')).toContain('خلال دقيقة تقريبًا');
  });

  it('page visibility is described as the gate, the menus and the admin do it (U14a)', () => {
    // A few minutes: the isolate memo over KV's edge cache and propagation (about three at
    // worst, src/lib/http/visibility.ts); Riyadh days, [from, until); the homepage
    // refused with these words; templates hidden whole; link only unlisted, not private;
    // a crawler's sitemap copy up to an hour (max-age=3600).
    expect(source('src/lib/http/visibility.ts')).toContain('VISIBILITY_MEMO_MS = 60_000');
    expect(source('packages/schemas/visibility.ts')).toContain('T00:00:00+03:00');
    expect(source('src/lib/admin/visibilityCopy.ts')).toContain(
      "'The homepage cannot be hidden. Use maintenance mode instead.'",
    );
    expect(source('src/pages/sitemap.xml.ts')).toContain("'cache-control': 'public, max-age=3600'");
    expect(source('src/lib/admin/visibilityCopy.ts')).toContain("badge: 'Link only'");
    const en = guide('page-visibility', 'en');
    expect(en).toContain('applies to the live site within a few minutes');
    expect(en).not.toMatch(/within a minute/);
    expect(en).toContain('Riyadh time');
    expect(en).toContain('unlisted, not private');
    // Hiding is not deleting, and a hidden page's form stays open (/api is never gated).
    expect(source('src/middleware.ts')).toMatch(/\/api/);
    expect(en).toContain("Hiding is not deleting: the page's words stay published.");
    expect(en).toContain('still takes what its form sends');
    expect(en).toContain('Accepting job applications');
    expect(en).toContain('The homepage is always visible');
    expect(en).toContain('up to an hour');
    expect(en).toContain('Sync to edge');
    // U14b: the fourth mode, and what the admin must know about it — a password cannot be
    // read back, a new one closes the page again, and the words are closed too.
    expect(en).toContain('Behind a password');
    expect(en).toContain('stored scrambled');
    expect(en).toContain('not readable through the site');
    expect(source('src/lib/admin/visibilityCopy.ts')).toContain("badge: 'Password'");
    const ar = guide('page-visibility', 'ar');
    expect(ar).toContain('خلال بضع دقائق');
    expect(ar).not.toContain('خلال دقيقة');
    expect(ar).toContain('بتوقيت الرياض');
    expect(ar).toContain('غير مدرجة وليست خاصة');
    expect(ar).toContain('الإخفاء ليس حذفًا');
    expect(ar).toContain('Accepting job applications');
    expect(ar).toContain('Behind a password');
    expect(ar).toContain('مشفّرة');
  });

  it('U14a (0057) restates U12b’s set (0056) and only adds the page-visibility guide', () => {
    // Production applies 0056 before 0057, so 0057's set must carry every guide 0056 seeds
    // (U12a's roles guide, U12b's invites guide) as 0056 left it, or it would revert them.
    const setOf = (file: string) => {
      const sql = source(`${MIGRATIONS}/${file}`);
      return JSON.parse(/\$help\$([\s\S]*?)\$help\$/.exec(sql)![1]!) as HelpArticleRow[];
    };
    const u12b = setOf('0056_invites.sql');
    const u14 = setOf('0057_page_visibility.sql');
    expect(u14.filter((a) => a.slug !== 'page-visibility')).toEqual(u12b);
    const added = u14.find((a) => a.slug === 'page-visibility')!;
    expect(added.caps).toEqual(['maintenance.manage']);
    expect(added.screens).toEqual(['/admin/visibility']);
    // Listed after maintenance mode.
    const maintenance = u14.find((a) => a.slug === 'maintenance-mode')!;
    expect(added.sort_order).toBeGreaterThan(maintenance.sort_order);
  });

  it('scheduling is described as the editors and the job do it', () => {
    // The job runs every five minutes (0010) over app.publish_scheduled()'s tables, which are
    // exactly the editors with a Scheduled for field.
    expect(source('supabase/migrations/0010_launch_readiness.sql')).toMatch(
      /cron\.schedule\('publish-scheduled', '\*\/5 \* \* \* \*'/,
    );
    // The editors that offer the status with no Scheduled for field: the guide names them.
    const LABELS: Record<string, string | null> = {
      team: 'Team',
      statistics: 'Statistics',
      certifications: 'Certifications',
      aiQuestions: null, // the Style-Finder's editors: not this guide's screens
      aiStyles: null,
    };
    const dir = 'src/lib/admin/ui';
    const noTime = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'fields.ts')
      .filter((f) => {
        const ui = source(`${dir}/${f}`);
        return ui.includes('STATUS_FIELD') && !ui.includes('SCHEDULED_FIELD');
      })
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();
    expect(noTime).toEqual(Object.keys(LABELS).sort());
    const en = guide('saving-and-publishing', 'en');
    expect(en).toContain('within five minutes of its Scheduled for time');
    for (const label of Object.values(LABELS)) if (label) expect(en).toContain(label);
    expect(guide('saving-and-publishing', 'ar')).toContain('خلال خمس دقائق');
  });

  it('the placeholder tip names both boxes and the owner’s allowance', () => {
    expect(source('src/lib/admin/ui/fields.ts')).toContain("label: 'Placeholder (design sample)'");
    expect(source('src/lib/admin/ui/sections.ts')).toContain("label: 'Design placeholder'");
    // 0027: the owner's audited allowance that lets flagged rows of a table go live.
    const override = readdirSync(MIGRATIONS).find((f) => f.startsWith('0027_'));
    expect(source(`${MIGRATIONS}/${override}`)).toContain('placeholder_live_override');
    const en = guide('saving-and-publishing', 'en');
    expect(en).toContain('Placeholder (design sample), or Design placeholder on a page section');
    expect(en).toContain("unless the site's owner has allowed design samples");
  });

  it('the bell is described per role, as its sources decide', () => {
    expect(source('src/lib/admin/notifications/scheduled.ts')).toContain(
      "visible: (role) => can(role, 'services.write') === 'full' || can(role, 'blog.write') === 'full'",
    );
    expect(source('src/lib/admin/notifications/maintenance.ts')).toContain('visible: () => true');
    const types = source('src/lib/admin/notifications/types.ts');
    expect(types).toContain('WINDOW_DAYS = 14');
    expect(types).toContain('MAX_ITEMS = 30');
    const en = guide('your-account', 'en');
    expect(en).toContain('up to 30 items from the last 14 days');
    expect(en).toContain('going live today for the roles that write them');
    expect(en).toContain('maintenance switched on or off for everyone');
  });

  it('the theme editor is not said to change the site: no public code reads a saved theme', () => {
    // Applying a theme to the site is E4's; until then only the admin reads custom_themes.
    for (const file of codeIn('src').filter((f) => !/\/admin(\/|$)/.test(f))) {
      expect(source(file), file).not.toContain('custom_themes');
    }
    expect(guide('roles-and-access', 'en')).toContain(
      'the theme editor (saved themes do not change the site yet)',
    );
  });

  it('clearing the error log is described beside the nightly purge it runs alongside', () => {
    expect(source('supabase/migrations/0008_retention_jobs.sql')).toContain(
      "'system_logs_days')::int, 30)",
    );
    // Clear logs is site health's since U2: older than 7 days, older than 30, or all.
    const clear = source('src/components/admin/screens/logs/ClearLogs.tsx');
    expect(clear).toContain("{ value: '7', label: 'Older than 7 days' }");
    expect(clear).toContain("{ value: '30', label: 'Older than 30 days' }");
    expect(clear).toContain("{ value: 'all', label: 'All entries' }");
    expect(clear).toContain('Clear logs');
    const en = guide('site-health-and-logs', 'en');
    expect(en).toContain('Every night, entries older than 30 days are deleted by themselves');
    expect(en).toContain(
      'clear them sooner with Clear logs, choosing entries older than 7 days, older than 30 days, or all of them',
    );
  });

  it('website stats are described as the screen and the rollups do them (U2)', () => {
    // The range links, the 15-minute page-view rollup (0010) and its UTC days, the raw horizon.
    expect(source('src/lib/admin/stats/range.ts')).toContain('STAT_RANGES = [7, 30, 90] as const');
    expect(source('supabase/migrations/0010_launch_readiness.sql')).toMatch(
      /cron\.schedule\('rollup-pageviews', '\*\/15 \* \* \* \*'/,
    );
    const en = guide('website-stats', 'en');
    expect(en).toContain('Pick 7, 30 or 90 days at the top');
    expect(en).toContain('Counts are added up every 15 minutes');
    expect(en).toContain('midnight to midnight UTC (3 am in Riyadh)');
    expect(en).toContain('Raw visit records are kept 90 days');
    expect(guide('website-stats', 'ar')).toContain('كل 15 دقيقة');
  });

  it('site health is described as the score, the rollup and the tabs do it (U2, G2)', () => {
    expect(source('src/lib/admin/health/vitals.ts')).toContain('HEALTH_WINDOW_DAYS = 28');
    // U2's "Uptime is not measured here yet." left with G2: the score says why uptime is out.
    expect(source('src/lib/admin/health/score.ts')).not.toContain('Uptime is not measured');
    expect(everything('en')).not.toContain('Uptime is not measured here yet.');
    const migration = source('supabase/migrations/0052_stats_health_rollups.sql');
    expect(migration).toContain("cron.schedule('rollup-vitals', '7 * * * *'");
    expect(migration).toMatch(/v\.day < \(pg_catalog\.now\(\) at time zone 'UTC'\)::date - 400;/);
    const en = guide('site-health-and-logs', 'en');
    expect(en).toContain('until then it is half speed and half checklist');
    expect(en).toContain('real visits over the last 28 days');
    expect(en).toContain('added up every hour and kept 400 days');
    expect(en).toContain('Lab scores run in CI on every change');
    expect(guide('site-health-and-logs', 'ar')).toContain('آخر 28 يومًا');
    expect(guide('site-health-and-logs', 'ar')).toContain('400 يوم');
  });

  it('U13 (0054) restates U2’s set (0052) and changes only the activity log’s part', () => {
    // Production applies 0052 then 0054, so 0054's set must carry U2's guides as 0052 left
    // them: every guide but site-health-and-logs byte for byte (website-stats among them),
    // and in that one, only the activity log's item, the new filters item and the tip.
    const setOf = (file: string) => {
      const sql = source(`${MIGRATIONS}/${file}`);
      return JSON.parse(/\$help\$([\s\S]*?)\$help\$/.exec(sql)![1]!) as HelpArticleRow[];
    };
    const u2 = setOf('0052_stats_health_rollups.sql');
    const u13 = setOf('0054_activity_log.sql');
    expect(u13.map((a) => a.slug)).toEqual(u2.map((a) => a.slug));
    for (const article of u2.filter((a) => a.slug !== 'site-health-and-logs')) {
      expect(
        u13.find((a) => a.slug === article.slug),
        article.slug,
      ).toEqual(article);
    }
    const before = u2.find((a) => a.slug === 'site-health-and-logs')!;
    const after = u13.find((a) => a.slug === 'site-health-and-logs')!;
    expect({ ...after, body: null }).toEqual({ ...before, body: null });
    for (const lang of ['en', 'ar'] as const) {
      const [p0, ol0] = before.body[lang];
      const [p1, ol1, tip1] = after.body[lang];
      expect(p1, lang).toEqual(p0);
      const items0 = ol0!.x as string[];
      const items1 = ol1!.x as string[];
      // U2's four items first, unchanged; then U13's two in place of the old activity item.
      expect(items1.slice(0, 4), lang).toEqual(items0.slice(0, 4));
      expect(items1).toHaveLength(6);
      expect(items0).toHaveLength(5);
      expect(tip1!.t).toBe('tip');
    }
    expect(guide('site-health-and-logs', 'en')).toContain(
      'until then it is half speed and half checklist',
    );
    expect(guide('site-health-and-logs', 'en')).toContain(
      'names the person, former members included',
    );
    expect(guide('website-stats', 'en')).toContain('Counts are added up every 15 minutes');
  });

  it('U12a (0055) restates U13’s set (0054) and changes only the roles guide', () => {
    // Production applies 0052, 0054, then 0055, so 0055's set must carry U2's and U13's
    // guides as 0054 left them (website-stats, site-health-and-logs) or it would revert them:
    // every guide but roles-and-access byte for byte, and that one keeps its slug, title,
    // screens and capabilities.
    const setOf = (file: string) => {
      const sql = source(`${MIGRATIONS}/${file}`);
      return JSON.parse(/\$help\$([\s\S]*?)\$help\$/.exec(sql)![1]!) as HelpArticleRow[];
    };
    const u13 = setOf('0054_activity_log.sql');
    const u12a = setOf('0055_users_v2.sql');
    expect(u12a.map((a) => a.slug)).toEqual(u13.map((a) => a.slug));
    for (const article of u13.filter((a) => a.slug !== 'roles-and-access')) {
      expect(
        u12a.find((a) => a.slug === article.slug),
        article.slug,
      ).toEqual(article);
    }
    const before = u13.find((a) => a.slug === 'roles-and-access')!;
    const after = u12a.find((a) => a.slug === 'roles-and-access')!;
    expect({ ...after, body: null, minutes: null }).toEqual({
      ...before,
      body: null,
      minutes: null,
    });
    expect(after.body).not.toEqual(before.body);
    // U2's and U13's words, as the guides now seeded carry them.
    expect(guide('website-stats', 'en')).toContain('Pick 7, 30 or 90 days at the top');
    expect(guide('website-stats', 'en')).toContain('Raw visit records are kept 90 days');
    expect(guide('site-health-and-logs', 'en')).toContain(
      'until then it is half speed and half checklist',
    );
    expect(guide('site-health-and-logs', 'en')).toContain(
      'names the person, former members included',
    );
    expect(guide('site-health-and-logs', 'ar')).toContain('400 يوم');
  });

  it('U12b (0056) restates U12a’s set (0055) and only adds the invites guide', () => {
    // Production applies 0055, then 0056: every guide 0055 seeds stays byte for byte, and the
    // one new guide sits after the roles guide, for Admin alone, on the users screen.
    const setOf = (file: string) => {
      const sql = source(`${MIGRATIONS}/${file}`);
      return JSON.parse(/\$help\$([\s\S]*?)\$help\$/.exec(sql)![1]!) as HelpArticleRow[];
    };
    const u12a = setOf('0055_users_v2.sql');
    const u12b = setOf('0056_invites.sql');
    expect(u12b.filter((a) => a.slug !== 'inviting-people')).toEqual(u12a);
    const at = u12b.findIndex((a) => a.slug === 'inviting-people');
    expect(u12b[at - 1]?.slug).toBe('roles-and-access');
    const invites = u12b[at]!;
    expect(invites.caps).toEqual(['users.manage']);
    expect(invites.screens).toEqual(['/admin/users']);
    expect(ROLES.filter((role) => mayRead(role, invites.caps))).toEqual(['admin']);
    // The users screen's head keeps the roles guide, which every member may read.
    expect(pageGuideFor('/admin/users', 'admin')).toBe('roles-and-access');
    // Cancel works while the invite is pending (isPendingInvite: never confirmed, never
    // signed in), and a spent link confirms the address whether or not a password was set:
    // so the guide ties Cancel to accepting the invite, not to setting a password.
    const cancelLine = textsOf(invites, 'en').join('\n');
    expect(cancelLine).toContain('Until they have accepted the invite, you can Cancel it');
    expect(cancelLine).not.toContain('set a password, you can Cancel');
    expect(textsOf(invites, 'ar').join('\n')).toContain('ما دام لم يقبل الدعوة بعد');
  });

  it('U1 (0060) restates U14a’s set (0057): adds your-dashboard, takes /admin off finding-your-way', () => {
    // Production applies 0057 then 0060, so 0060's set must carry the guides as 0057 left
    // them (0055's twelve, U12b's invites guide and U14a's page-visibility guide): every guide but finding-your-way byte for byte, that one with only its screens
    // changed (the dashboard has its own guide now), and your-dashboard after it.
    const setOf = (file: string) => {
      const sql = source(`${MIGRATIONS}/${file}`);
      return JSON.parse(/\$help\$([\s\S]*?)\$help\$/.exec(sql)![1]!) as HelpArticleRow[];
    };
    const base = setOf('0057_page_visibility.sql');
    const u1 = setOf('0060_dashboard_layer.sql');
    expect(u1.map((a) => a.slug)).toEqual([
      'finding-your-way',
      'your-dashboard',
      ...base.map((a) => a.slug).filter((slug) => slug !== 'finding-your-way'),
    ]);
    for (const article of base.filter((a) => a.slug !== 'finding-your-way')) {
      expect(
        u1.find((a) => a.slug === article.slug),
        article.slug,
      ).toEqual(article);
    }
    const before = base.find((a) => a.slug === 'finding-your-way')!;
    const after = u1.find((a) => a.slug === 'finding-your-way')!;
    expect({ ...after, screens: null }).toEqual({ ...before, screens: null });
    expect(after.screens).toEqual(before.screens.filter((s) => s !== '/admin'));
    const dash = u1.find((a) => a.slug === 'your-dashboard')!;
    expect(dash.screens).toEqual(['/admin']);
    expect(dash.caps).toEqual([]);
  });

  it('U4 (0064) restates U14b’s set (0061) and changes only the media-library guide', () => {
    // Production applies 0061 then 0064, so 0064's set must carry every guide 0061 seeds,
    // byte for byte, but the one U4 rewrote (the library as it now is), in the same place.
    const setOf = (file: string) => {
      const sql = source(`${MIGRATIONS}/${file}`);
      return JSON.parse(/\$help\$([\s\S]*?)\$help\$/.exec(sql)![1]!) as HelpArticleRow[];
    };
    const base = setOf('0061_page_password.sql');
    const u4 = setOf('0064_media_library.sql');
    expect(u4.map((a) => a.slug)).toEqual(base.map((a) => a.slug));
    for (const article of base.filter((a) => a.slug !== 'media-library')) {
      expect(
        u4.find((a) => a.slug === article.slug),
        article.slug,
      ).toEqual(article);
    }
    const before = base.find((a) => a.slug === 'media-library')!;
    const after = u4.find((a) => a.slug === 'media-library')!;
    expect(after.body).not.toEqual(before.body);
    expect({ ...after, body: null, minutes: null }).toEqual({
      ...before,
      body: null,
      minutes: null,
    });
    expect(after.minutes).toBe(3);
  });

  it('C4b (0065) restates U4’s set (0064) and changes only the working-with-leads guide', () => {
    // Production applies 0064 then 0065, so 0065's set must carry every guide 0064 seeds,
    // byte for byte, but the one C4b rewrote (the leads screens), in the same place.
    const setOf = (file: string) => {
      const sql = source(`${MIGRATIONS}/${file}`);
      return JSON.parse(/\$help\$([\s\S]*?)\$help\$/.exec(sql)![1]!) as HelpArticleRow[];
    };
    const base = setOf('0064_media_library.sql');
    const c4b = setOf('0065_help_leads_v2.sql');
    expect(c4b.map((a) => a.slug)).toEqual(base.map((a) => a.slug));
    for (const article of base.filter((a) => a.slug !== 'working-with-leads')) {
      expect(
        c4b.find((a) => a.slug === article.slug),
        article.slug,
      ).toEqual(article);
    }
    const before = base.find((a) => a.slug === 'working-with-leads')!;
    const after = c4b.find((a) => a.slug === 'working-with-leads')!;
    expect(after.body).not.toEqual(before.body);
    expect({ ...after, body: null, minutes: null }).toEqual({
      ...before,
      body: null,
      minutes: null,
    });
    expect(after.minutes).toBe(4);
  });

  it('C4c (0068) restates G2’s set (0067) and changes only the working-with-leads guide', () => {
    // Production applies 0067 then 0068: every guide 0067 seeds, byte for byte, but the leads
    // guide, which gains the Pipeline board's line (the board was carved out of C4b by size).
    const setOf = (file: string) => {
      const sql = source(`${MIGRATIONS}/${file}`);
      return JSON.parse(/\$help\$([\s\S]*?)\$help\$/.exec(sql)![1]!) as HelpArticleRow[];
    };
    const base = setOf('0067_health_probes.sql');
    const c4c = setOf('0068_help_leads_board.sql');
    expect(c4c.map((a) => a.slug)).toEqual(base.map((a) => a.slug));
    for (const article of base.filter((a) => a.slug !== 'working-with-leads')) {
      expect(
        c4c.find((a) => a.slug === article.slug),
        article.slug,
      ).toEqual(article);
    }
    const before = base.find((a) => a.slug === 'working-with-leads')!;
    const after = c4c.find((a) => a.slug === 'working-with-leads')!;
    expect({ ...after, body: null }).toEqual({ ...before, body: null });
    // One line added to the first list, in each language; nothing else moves.
    for (const lang of ['en', 'ar'] as const) {
      const lists = (body: HelpArticleRow['body']) =>
        body[lang].filter((b) => b.t === 'ol').map((b) => b.x as string[]);
      const [was, now] = [lists(before.body), lists(after.body)];
      expect(now[0]!.slice(0, -1), lang).toEqual(was[0]);
      expect(now[0]!.at(-1), lang).toContain('Pipeline');
      expect(now.slice(1), lang).toEqual(was.slice(1));
    }
  });

  it('C4c (0068) refuses to revert a guide it does not own: it keeps the set before and compares', () => {
    // A sibling's restatement that reaches production before C4c (as G2's 0067 did, onto which
    // 0068 is re-based) would be reverted by a 0068 not re-based on it; the migration keeps the
    // set it found and its postcondition refuses any other guide that changed, so the push
    // fails instead.
    const sql = source(`${MIGRATIONS}/0068_help_leads_board.sql`);
    const keep = sql.indexOf(
      'create temporary table _help_set_before_0068 on commit drop as\n  select app.help_article_set() as guides;',
    );
    expect(keep).toBeGreaterThan(-1);
    expect(keep).toBeLessThan(sql.indexOf('create or replace function app.help_article_set()'));
    expect(sql).toContain('from _help_set_before_0068 h');
    expect(sql).toContain("raise exception '0068: the set changes guides it does not own (%)");
    // The one guide the guard lets change is the one the file changes against its base.
    const setOf = (file: string) =>
      JSON.parse(
        /\$help\$([\s\S]*?)\$help\$/.exec(source(`${MIGRATIONS}/${file}`))![1]!,
      ) as HelpArticleRow[];
    const base = setOf('0067_health_probes.sql');
    const changed = setOf('0068_help_leads_board.sql')
      .filter(
        (a) =>
          !isDeepStrictEqual(
            a,
            base.find((b) => b.slug === a.slug),
          ),
      )
      .map((a) => a.slug);
    const owned = [...sql.matchAll(/<> '([a-z-]+)'\n\s+and a\.g is distinct from b\.g;/g)].map(
      (m) => m[1],
    );
    expect(owned).toEqual(changed);
    expect(owned).toEqual(['working-with-leads']);
  });

  it('the leads guide names the controls the leads screens draw (C4b)', () => {
    const en = guide('working-with-leads', 'en');
    const screens = codeIn('src/components/admin/screens/leads').map(source).join('\n');
    const pages = ['index.astro', 'board.astro', '[id].astro']
      .map((page) => source(`src/pages/admin/leads/${page}`))
      .join('\n');
    const drawn = [
      screens,
      pages,
      source('src/lib/admin/nav/crm.ts'),
      source('src/lib/crm/leadView.ts'),
    ].join('\n');
    for (const control of [
      'Over response time',
      'Unread',
      'Spam',
      'Pipeline',
      'Move to…',
      'Previous',
      'Next',
      'Reveal contact details',
      'Email',
      'Call',
      'WhatsApp',
      'Log contact',
      'Add lead manually',
      'Export CSV',
      'More actions',
    ]) {
      expect(en, control).toContain(control);
      expect(drawn, control).toContain(control);
    }
    // The over-response words are the list's own (leadView.ts), and the limits are the routes'.
    expect(source('src/lib/crm/leadView.ts')).toContain("SLA_LABEL = 'Over response time'");
    expect(en).toContain('up to 60 an hour');
    expect(source('src/lib/admin/rateLimit.ts')).toMatch(/PII_REVEAL_LIMITS[^}]*perUser: 60,/);
    expect(en).toContain('at most 80 leads with contact details');
    expect(source('src/lib/crm/exportRead.ts')).toContain('EXPORT_ROW_CAP = { pii: 80,');
    // Not the old panel's words any more, in either language.
    expect(en).not.toContain('Reveal contact details and notes');
    expect(guide('working-with-leads', 'ar')).not.toContain('Reveal contact details and notes');
    expect(guide('working-with-leads', 'ar')).toContain('Move to…');
  });

  it('G2 (0067) restates C4b’s set (0065) and changes only site-health-and-logs', () => {
    // Production applies 0065 then 0067, so 0067's set must carry every other guide as 0065
    // left it, byte for byte; the site health guide keeps its slug, title, caps and screens.
    const setOf = (file: string) => {
      const sql = source(`${MIGRATIONS}/${file}`);
      return JSON.parse(/\$help\$([\s\S]*?)\$help\$/.exec(sql)![1]!) as HelpArticleRow[];
    };
    const base = setOf(G2_PREVIOUS_SET);
    const g2 = setOf('0067_health_probes.sql');
    expect(g2.map((a) => a.slug)).toEqual(base.map((a) => a.slug));
    for (const article of base.filter((a) => a.slug !== 'site-health-and-logs')) {
      expect(
        g2.find((a) => a.slug === article.slug),
        article.slug,
      ).toEqual(article);
    }
    const before = base.find((a) => a.slug === 'site-health-and-logs')!;
    const after = g2.find((a) => a.slug === 'site-health-and-logs')!;
    expect({ ...after, body: null, minutes: null }).toEqual({
      ...before,
      body: null,
      minutes: null,
    });
    expect(after.caps).toEqual(['siteHealth.view', 'logs.view', 'audit.view']);
    expect(after.screens).toEqual(['/admin/site-health', '/admin/audit']);
    for (const lang of ['en', 'ar'] as const) {
      const [p0, ol0, tip0] = before.body[lang];
      const [p1, ol1, tip1] = after.body[lang];
      expect(p1, lang).toEqual(p0);
      expect(tip1, lang).toEqual(tip0);
      const items0 = ol0!.x as string[];
      const items1 = ol1!.x as string[];
      // The score's item rewritten, the checklist's kept; then the Uptime card, the Security
      // tab and the bell; then Speed, Errors and the activity log's two, as 0065 left them.
      expect(items1).toHaveLength(9);
      expect(items1[1], lang).toBe(items0[1]);
      expect(items1.slice(5), lang).toEqual(items0.slice(2));
      expect(items1[0], lang).not.toBe(items0[0]);
    }
  });

  it('site health v2 is described as the score, the schedule and the probes do it (G2)', async () => {
    const { SCORE_WEIGHTS, uptimePoints } = await import('@/lib/admin/health/score');
    const { THRESHOLDS } = await import('@/lib/health/thresholds');
    const { TIMING } = await import('@/lib/health/probes');
    const { SCHEDULES } = await import('@/lib/cron/schedules');
    const { HEALTH_JOBS } = await import('@/lib/cron/health');
    const { HEALTH_CHECK_LIMITS } = await import('@/lib/admin/rateLimit');
    const { dayState } = await import('@/lib/admin/health/uptime');
    expect(SCORE_WEIGHTS).toEqual({ speed: 40, checks: 40, uptime: 20 });
    expect(uptimePoints(100)).toBe(100);
    expect(uptimePoints(99)).toBe(0);
    // The health probes run every 10 minutes (Admin v2 U9b's reconcile shares the trigger).
    expect(SCHEDULES['*/10 * * * *']).toContain(HEALTH_JOBS[0]);
    expect(THRESHOLDS.domainFailDays).toBe(30);
    expect(THRESHOLDS.certificateFailDays).toBe(14);
    // Six failed reads at 10 minutes: an hour.
    expect(THRESHOLDS.staleAfter * 10).toBe(60);
    expect(TIMING.domainEveryMs).toBeLessThanOrEqual(24 * 3_600_000);
    expect(HEALTH_CHECK_LIMITS).toMatchObject({ perUser: 6, windowMinutes: 60 });
    // The strip: up all day, down a few minutes (at most 1% of a day, 14.4 minutes), longer.
    expect([dayState(100), dayState(99), dayState(98.99), dayState(null)]).toEqual([
      'ok',
      'dip',
      'down',
      'none',
    ]);
    const css = source('public/styles/admin/health.css');
    expect(css).toMatch(/\.up__d\[data-state='ok'\] \{\s*background: var\(--ad-ok-text\)/);
    expect(css).toMatch(/\.up__d\[data-state='dip'\] \{\s*background: var\(--ad-warn-text\)/);
    expect(css).toMatch(/\.up__d\[data-state='down'\] \{\s*background: var\(--ad-err-text\)/);
    // The screen's words the guide names.
    expect(source('src/components/admin/screens/health/CheckNow.tsx')).toContain("'Check now'");
    expect(source('src/components/admin/screens/health/UptimeCard.astro')).toContain(
      'Card title="Uptime"',
    );
    expect(source('src/components/admin/ui/charts/ChartFigure.astro')).toContain('View as table');
    expect(source('src/pages/admin/site-health.astro')).toContain("label: 'Security'");
    expect(source('src/components/admin/screens/health/UptimeCard.astro')).toContain('Not set up.');
    const en = guide('site-health-and-logs', 'en');
    expect(en).toContain('the score weighs speed 40%, the checklist 40% and uptime 20%');
    expect(en).toContain('counts in full at 100% and not at all at 99% or less');
    expect(en).toContain('its readings arrive here every 10 minutes');
    expect(en).toContain('green when the site was up all day');
    expect(en).toContain('red when it was down for more than 14 minutes');
    // The strip's days are the studio's (Admin v2 U9): the probe asks for them in its zone and
    // the card names the zone's city.
    expect(en).toContain("Days follow the studio's time zone");
    expect(en).not.toContain('midnight to midnight in Riyadh');
    expect(source('src/lib/health/probes.ts')).toContain('provider.read(now, tz)');
    expect(source('src/components/admin/screens/health/UptimeStrip.astro')).toContain(
      'by ${timeZoneCity(tz)} day',
    );
    expect(en).toContain('Check now asks for a fresh reading at once, up to 6 times an hour');
    expect(en).toContain('the card says Not set up and the score leaves uptime out');
    expect(en).toContain('about once a day');
    expect(en).toContain('when 30 days or fewer are left');
    expect(en).toContain('when 14 days or fewer are left');
    expect(en).toContain('has not answered for an hour');
    const ar = guide('site-health-and-logs', 'ar');
    for (const fact of [
      '40%',
      '20%',
      '10 دقائق',
      '90 يومًا',
      '14 دقيقة',
      '6 مرات',
      '30 يومًا',
      '14 يومًا',
    ])
      expect(ar, fact).toContain(fact);
    // The studio's days since Admin v2 U9, as the English says.
    expect(ar).toContain('تتبع الأيام المنطقة الزمنية للاستوديو');
    expect(ar).not.toContain('بتوقيت الرياض');
  });

  it('the dashboard guide says what the dashboard does (U1)', async () => {
    const schema = await import('@schemas/dashboard');
    const sql = source(`${MIGRATIONS}/0060_dashboard_layer.sql`);
    expect(sql).toContain(
      "cron.schedule('team-notes-retention', '25 3 * * *', $job$ select app.expire_team_notes() $job$)",
    );
    expect(sql).toContain("n.updated_at < pg_catalog.now() - interval '180 days'");
    expect(schema.TEAM_NOTES_RETENTION_DAYS).toBe(180);
    expect(schema.QUICK_MAX).toBe(12);
    expect(schema.QUICK_CUSTOM_MAX).toBe(8);
    expect(schema.TEAM_NOTE_PHONE.source).toContain('{8,}');
    // The Customize bar and the editors name these controls.
    const island = source('src/components/admin/screens/dashboard/Dashboard.tsx');
    for (const label of ['Add widget', 'Reset', 'Done', 'Customize'])
      expect(island).toContain(label);
    expect(source('src/components/admin/ui/dashboard/Widget.astro')).toContain('Edit notes');
    expect(source('src/lib/admin/ui/teamNotes.ts')).toContain("title: 'Team notes'");
    const en = guide('your-dashboard', 'en');
    expect(en).toContain('Every change is saved as you make it');
    expect(en).toContain('add up to 8 links of your own');
    expect(en).toContain('You can have 12 in all');
    expect(en).toContain('A note is cleared 180 days after its last edit');
    expect(en).toContain('any run of 8 or more digits');
    expect(en).toContain('Save team notes');
    expect(en).toContain('An Admin can save a layout and a set of quick actions as the default');
    const ar = guide('your-dashboard', 'ar');
    expect(ar).toContain('180 يومًا');
    expect(ar).toContain('8 أرقام');
  });

  it('the Arabic says what it means', () => {
    expect(everything('ar')).not.toContain('شوركت');
    expect(guide('seo-and-redirects', 'ar')).toContain('الروابط التي تمت مشاركتها');
    expect(guide('personal-data', 'ar')).toContain('تُعرض بيانات شخص واحد');
  });
});

describe('the CRM settings guide says what the screen does (C9a)', () => {
  const source = (path: string) => readFileSync(path, 'utf8');
  const guide = () => SET.find((a) => a.slug === 'crm-settings')!;
  const en = () => textsOf(guide(), 'en').join('\n');

  it('is Admin’s (crm.settings), on its screen, in the place after the leads guide', () => {
    expect(guide().caps).toEqual(['crm.settings']);
    expect(guide().screens).toEqual(['/admin/crm/settings']);
    expect(guide().sort_order).toBe(75);
    for (const role of ROLES) {
      expect(mayRead(role, guide().caps), role).toBe(ROLE_CAPS[role]['crm.settings'] === 'full');
    }
  });

  it('gives the limits the schema and the database hold', async () => {
    const crm = await import('@schemas/crm');
    expect(en()).toContain(`${crm.MIN_STAGES} to ${crm.MAX_STAGES} stages`);
    expect(en()).toContain(`0 to ${crm.MAX_SIGNAL_POINTS} points`);
    expect(en()).toContain(`never goes above ${crm.MAX_LEAD_SCORE}`);
  });

  it('names the controls the screen draws, in both languages', () => {
    const screen = ['StagesCard', 'ScoringCard', 'ResponseCard']
      .map((f) => source(`src/components/admin/screens/crmSettings/${f}.tsx`))
      .join('\n');
    const copy = source('src/components/admin/screens/crmSettings/copy.ts');
    for (const control of [
      'Add stage',
      'Move up',
      'Move down',
      'Save stages',
      'Save scoring',
      'Answer new leads within',
      'New leads go to',
    ]) {
      expect(screen, control).toContain(control);
      expect(en(), control).toContain(control);
      expect(textsOf(guide(), 'ar').join('\n'), control).toContain(control);
    }
    for (const rule of ['Manual', 'Round robin', 'Always to one person']) {
      expect(copy, rule).toContain(`label: '${rule}'`);
      expect(en(), rule).toContain(rule);
    }
    // The flag the leads list shows past the response time, in its words.
    expect(source('src/lib/crm/leadView.ts')).toContain('Over response time');
    expect(en()).toContain('Over response time');
  });
});

// ── 1d. A guide put through H11's catalog (Admin v2 G1) ────────────────────────────────
// G1 rewrites website-stats for the tabs it adds, with one top-level app.put_help_guide in its
// migration (no slice restates app.help_article_set() since H11). The guide's text is
// docs/admin-v2/guides/website-stats.json, held here to every rule the set's guides keep, to the
// code behind each sentence, and to the put that ships it (the set above reads it through it).

describe('website-stats as G1 rewrites it (docs/admin-v2/guides/website-stats.json)', () => {
  const RAW_GUIDE = JSON.parse(
    readFileSync('docs/admin-v2/guides/website-stats.json', 'utf8'),
  ) as unknown;
  const guide = HelpArticleSeedSchema.parse(RAW_GUIDE);
  const G1_FILE = '0071_stats_v2.sql';
  // The guide as main left it before 0071: the migrations that sort before it (the put's
  // revision guard and the place, screens and capabilities it keeps are read against it), and
  // as 0071 left it. By file order, not "all but 0071": a later put of the guide (Admin v2 U9's
  // 0098, one sentence) names the revision 0071 left, which reads as stale without 0071.
  const BEFORE = helpSet(MIGRATION_FILES.filter((f) => f.name < G1_FILE));
  const AT_G1 = helpSet(MIGRATION_FILES.filter((f) => f.name <= G1_FILE));
  const base = HelpArticleSeedSchema.parse(BEFORE.set.find((a) => a.slug === 'website-stats')!);
  const en = textsOf(guide, 'en').join('\n');
  const ar = textsOf(guide, 'ar').join('\n');
  const source = (path: string) => readFileSync(path, 'utf8');
  const MIGRATION = source(`${MIGRATIONS}/${G1_FILE}`);

  it('keeps the schema (the nine keys put takes), its place, screens and capabilities', () => {
    expect(Object.keys(RAW_GUIDE as object).sort()).toEqual([
      'body',
      'caps',
      'minutes',
      'screens',
      'slug',
      'sort_order',
      'tags',
      'title',
      'title_ar',
    ]);
    expect(guide.slug).toBe(base.slug);
    expect(guide.sort_order).toBe(base.sort_order);
    expect(guide.screens).toEqual(base.screens);
    expect(guide.caps).toEqual(base.caps);
    expect(guide.title).toBe(base.title);
    expect(guide.title_ar).toBe(base.title_ar);
    // Its screens are still the page heads' (no new screen: the tabs are ?tab= links).
    expect(PAGE_GUIDES.find((g) => g.slug === 'website-stats')?.screens).toEqual(guide.screens);
  });

  it('the Arabic follows the English block for block; no dash, brand, markup or $guide$', () => {
    const kinds = (lang: 'en' | 'ar') =>
      guide.body[lang].map((b) => (b.t === 'ol' ? `ol${b.x.length}` : b.t)).join(',');
    expect(kinds('ar')).toBe(kinds('en'));
    expect(textsOf(guide, 'ar').every((t) => /[؀-ۿ]/.test(t))).toBe(true);
    for (const text of textsOf(guide)) {
      expect(text).not.toMatch(/[–—]/);
      expect(text.toLowerCase()).not.toMatch(/braii?n|statii?on/);
      expect(text).not.toMatch(/[<>\u0000-\u001f]/);
      expect(text.includes('$guide$')).toBe(false);
      expect(text.includes('$help$')).toBe(false);
    }
  });

  it('keeps every sentence of U2’s that stays true', () => {
    expect(source('src/lib/admin/stats/range.ts')).toContain('STAT_RANGES = [7, 30, 90] as const');
    expect(en).toContain('Pick 7, 30 or 90 days at the top');
    expect(en).toContain('Counts are added up every 15 minutes');
    expect(en).toContain('midnight to midnight UTC (3 am in Riyadh)');
    expect(en).toContain('Raw visit records are kept 90 days');
    expect(ar).toContain('كل 15 دقيقة');
    // The visits rollup runs every 15 minutes too, offset from the page views'.
    expect(MIGRATION).toContain(
      "cron.schedule('rollup-visits', '4-59/15 * * * *', $job$ select app.rollup_visits(3) $job$)",
    );
  });

  it('says what a visit is, as the rollup counts it', () => {
    expect(en).toContain('A visit is one browser tab on one day');
    expect(en).toContain('counts again the next day');
    expect(MIGRATION).toMatch(
      /group by e\.tenant_id, \(e\.occurred_at at time zone 'UTC'\)::date, e\.session_id/,
    );
    expect(source('src/lib/client/analytics.ts')).toContain("sessionStorage.getItem('bs_sid')");
  });

  it('says the funnel’s steps and why inquiries are apart, and for whom', () => {
    expect(en).toContain('then the visits that opened a service page');
    expect(en).toContain('only to people who work with leads');
    expect(source('src/lib/admin/stats/leads.ts')).toContain(
      "if (can(auth.role, 'leads.manage') !== 'full') return null;",
    );
    expect(en).toContain('Devices, countries and sources are not collected.');
  });

  it('says the busiest hours are in the studio’s time zone, which the card names (Admin v2 U9)', () => {
    expect(en).toContain(
      "busiest hours of the day in the studio's time zone, which the card names",
    );
    expect(en).not.toContain('busiest hours of the day in Riyadh');
    expect(ar).toContain('بتوقيت المنطقة الزمنية للاستوديو، كما تذكرها البطاقة');
    // The page groups them in the studio's zone; the card names its city.
    const page = source('src/pages/admin/analytics/index.astro');
    expect(page).toContain('const studioTz = await studioTimeZone(Astro.locals);');
    expect(page).toContain('loadBusyHours(sb, session, range, studioTz)');
    const card = source('src/components/admin/screens/stats/StatsAudience.astro');
    expect(card).toContain('const zoneWords = `${timeZoneCity(zone)} time`;');
    expect(card).toContain('sub={`${zoneWords}. Good to know when to post and when to answer.`}');
    // "3 am in Riyadh" for the UTC day stays a fact of Riyadh's zone, the default one.
    expect(DEFAULT_TIME_ZONE).toBe('Asia/Riyadh');
  });

  it('says what realtime counts, how often it updates, when it stops and how long minutes are kept', () => {
    expect(ACTIVE_MINUTES).toBe(5);
    expect(REALTIME_POLL_MS).toBe(60_000);
    expect(REALTIME_AUTO_STOP_MS).toBe(30 * 60_000);
    expect(REALTIME_KEEP_HOURS).toBe(48);
    expect(MIGRATION).toContain("cron.schedule('rollup-realtime', '* * * * *'");
    expect(MIGRATION).toContain("r.minute < pg_catalog.now() - interval '48 hours'");
    // Active: the five minutes ending with the minute (it, and the four before it).
    expect(MIGRATION).toContain("ev.occurred_at >= g.m - interval '4 minutes'");
    expect(en).toContain('in the last 5 minutes');
    expect(en).toContain('It updates every minute while the tab is open');
    expect(en).toContain('stops by itself after 30 minutes');
    expect(en).toContain('Minute counts are kept 48 hours.');
    expect(source('src/components/admin/screens/realtime/Realtime.tsx')).toContain('Pause updates');
    expect(en).toContain('Pause updates stops it');
    expect(ar).toContain('آخر 5 دقائق');
    expect(ar).toContain('48 ساعة');
  });

  it('says who sets goals, how progress is counted and how many there can be', () => {
    const setters = ROLES.filter((r) => ROLE_CAPS[r]['analytics.goals'] === 'full');
    expect(setters).toEqual(['admin', 'seo']);
    expect(en).toContain('Admins and the SEO role can add goals');
    expect(en).toContain('Progress counts this calendar month, from the first, in UTC days.');
    expect(MIGRATION).toContain(
      "v_month date := date_trunc('month', (pg_catalog.now() at time zone 'UTC'))::date;",
    );
    expect(MAX_GOALS).toBe(20);
    // Counted after the row is in (an AFTER trigger), so more than 20 is the refusal.
    expect(MIGRATION).toMatch(/g\.tenant_id = new\.tenant_id\) > 20 then/);
    expect(en).toContain('You can keep up to 20 goals.');
    expect(ar).toContain('20 هدفًا');
  });

  it('0071 puts it through the catalog at the revision main leaves, and the set holds it', () => {
    // One put, of this guide, naming the revision the guide is at before 0071.
    const mine = HELP.edits.filter((e) => e.file === G1_FILE);
    expect(mine).toEqual([
      {
        file: G1_FILE,
        op: 'put',
        slug: 'website-stats',
        revision: BEFORE.revisions.get('website-stats'),
      },
    ]);
    // It changes the guide, so the catalog moves it by one.
    expect(AT_G1.revisions.get('website-stats')).toBe(
      (BEFORE.revisions.get('website-stats') ?? 0) + 1,
    );
    // The set the migrations leave holds the file's guide exactly, and 0071 moved nothing else.
    expect(SET.find((a) => a.slug === 'website-stats')).toEqual(guide);
    expect(AT_G1.set.filter((g) => g.slug !== 'website-stats')).toEqual(
      BEFORE.set.filter((g) => g.slug !== 'website-stats'),
    );
    // 0071's literal is the guide as 0071 left it; the LATEST put of the guide is the file
    // byte for byte (only its trailing newline dropped): Admin v2 U9's 0098 changed a sentence.
    const PUT =
      /^select app\.put_help_guide\(\$guide\$\r?\n([\s\S]*?)\r?\n\$guide\$::jsonb, \d+\);/gm;
    const literalsOf = (sql: string) => [...sql.matchAll(PUT)].map((m) => m[1] ?? '');
    expect(JSON.parse(literalsOf(MIGRATION)[0] ?? 'null')).toEqual(
      AT_G1.set.find((g) => g.slug === 'website-stats'),
    );
    const latest = MIGRATION_FILES.flatMap((f) => literalsOf(f.sql))
      .filter((l) => (JSON.parse(l) as { slug?: unknown }).slug === 'website-stats')
      .at(-1);
    expect(latest).toBe(
      readFileSync('docs/admin-v2/guides/website-stats.json', 'utf8').replace(/\r?\n$/, ''),
    );
    expect(helpSetViolations(MIGRATION_FILES)).toEqual([]);
    expect(MIGRATION).not.toContain('TODO(H11)');
    expect(MIGRATION).not.toMatch(/create or replace function app\.help_article_set\(\)/);
    // The migration's own postcondition checks the catalog row and every tenant's copy.
    expect(MIGRATION).toContain("c.tags = array['stats', 'goals']");
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
    // The search answers the list's cap, never the drawer's 20: the role filter comes first.
    expect(sql).toContain(`limit ${MAX_GUIDES};`);
    expect(sql).not.toContain(`limit ${MAX_RESULTS};`);
  });

  it('the standard describes the search’s fold as the migration does it', () => {
    // help_search folds with app.normalize_ar_q only (a contains search strips no article);
    // CLAUDE.md's U16 bullet must not claim the FTS rule (app.ar_fts_text) for it.
    const search = /function public\.help_search\([\s\S]*?\nend \$\$;/.exec(sql)?.[0] ?? '';
    expect(search).toContain('app.normalize_ar_q(');
    expect(search).not.toContain('ar_fts_text');
    const bullet =
      readFileSync('CLAUDE.md', 'utf8')
        .split('\n')
        .find((line) => line.startsWith('- U16, the help centre (0046)')) ?? '';
    expect(bullet).toContain('with `app.normalize_ar_q` on both sides');
    expect(bullet).not.toMatch(/as the Arabic FTS rule above folds/);
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
    expect(pageGuideFor('/admin', 'developer')).toBe('your-dashboard');
    expect(pageGuideFor('/admin/search', 'developer')).toBe('finding-your-way');
    expect(pageGuideFor('/admin/themes', 'admin')).toBeNull();
    expect(pageGuideFor('/admin/help', 'admin')).toBeNull();
  });

  it('SEO opens Pages and Posts without the content guide, which is for the writers', () => {
    expect(pageGuideFor('/admin/pages', 'seo')).toBeNull();
    expect(pageGuideFor('/admin/blog/1', 'seo')).toBeNull();
    expect(pageGuideFor('/admin/pages', 'content_creator')).toBe('saving-and-publishing');
  });
});

// ── 1c. Guides filed before the catalog puts them ──────────────────────────────────────

describe('filed guides (docs/admin-v2/guides)', () => {
  it('each file is named after its slug, and equals what a migration seeds once one does', () => {
    for (const { file, raw } of FILED) {
      expect(file).toBe(`${String(raw.slug)}.json`);
      const seeded = RAW_SET.find((r) => (r as { slug?: unknown }).slug === raw.slug);
      if (!seeded) continue;
      if (PENDING_EDITS.has(raw.slug)) {
        // Still waiting for its put: once the catalog seeds this text, drop it from the list.
        expect(seeded, `${file}: seeded now, so leave PENDING_EDITS`).not.toEqual(raw);
      } else {
        expect(seeded, `${file}: the seeded text differs from the file`).toEqual(raw);
      }
    }
  });
});

describe('seo-and-redirects says what the SEO screen does (Admin v2 U10)', () => {
  const article = () => SET.find((a) => a.slug === 'seo-and-redirects')!;
  const text = (lang: 'en' | 'ar') => textsOf(article(), lang).join(' ');
  const source = (path: string) => readFileSync(path, 'utf8');

  it('keeps its place, caps and screens: no one is sent to a screen they cannot open', () => {
    expect(article()).toMatchObject({
      sort_order: 60,
      title: 'SEO, share images and redirects',
      caps: ['seo.globalDefaults', 'redirects.manage'],
      screens: ['/admin/seo', '/admin/redirects'],
    });
    // Content Creator holds seo.entityMeta at view only, and /admin/seo refuses them.
    expect(ROLES.filter((r) => mayRead(r, article().caps))).toEqual(['admin', 'seo']);
  });

  it('every number and label it states is the code’s', async () => {
    const en = text('en');
    const ar = text('ar');
    const { SEO_TITLE_MAX, SEO_DESCRIPTION_MAX } = await import('@schemas/seoRules');
    const { SHARE_IMAGE_MAX_WIDTH } = await import('@/lib/seo/shareImage');
    expect(en).toContain(`the boxes stop at ${SEO_TITLE_MAX} and ${SEO_DESCRIPTION_MAX}`);
    expect(ar).toContain(`عند ${SEO_TITLE_MAX} و${SEO_DESCRIPTION_MAX}`);
    expect(en).toContain(`at most ${SHARE_IMAGE_MAX_WIDTH.toLocaleString('en')} pixels wide`);
    expect(ar).toContain(`${SHARE_IMAGE_MAX_WIDTH.toLocaleString('en')} بكسل`);
    // The panel's own words, and the confirmation's.
    const panel = source('src/components/admin/screens/seo/SeoPanel.tsx');
    expect(panel).toContain("INDEX_LABEL = 'Let search engines index this page'");
    expect(panel).toContain('50 to 60 characters works best');
    expect(panel).toContain('150 to 160 characters works best');
    for (const label of ['Let search engines index this page', 'Advanced', 'Edit SEO']) {
      expect(en).toContain(label);
      expect(ar).toContain(label);
    }
    expect(source('src/components/admin/screens/seo/PagesTab.tsx')).toContain(
      'aria-label={`Edit SEO for ${row.label}`}',
    );
    expect(source('src/components/admin/screens/seo/SiteWideForm.tsx')).toContain(
      "CONFIRM_WORD = 'noindex'",
    );
    expect(en).toContain('asks you to type noindex first');
    expect(ar).toContain('أن تكتب noindex أولًا');
    // The sitemap's lag: llms.txt and the sitemap are cached for an hour.
    expect(en).toContain('at most an hour behind');
    expect(source('src/pages/sitemap.xml.ts')).toContain('max-age=3600');
    // Redirects: the edge's minute, and Sync to edge.
    expect(en).toContain('within a minute of saving');
    expect(source('src/lib/admin/ui/redirects.ts')).toContain(
      'Takes effect at the edge within a minute of saving.',
    );
    expect(en).toContain('Sync to edge');
  });

  it('names the share image’s fallbacks in the order the head resolves them', () => {
    const en = text('en');
    const order = [
      'a picture from the media library',
      'the page’s own image is used',
      'the site’s default share image',
      'the built-in logo card',
    ];
    const at = order.map((words) => en.indexOf(words));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(source('src/lib/data/seo.ts')).toContain(
      'share image  entity override (its media-library picture, else its legacy URL) → the',
    );
  });
});

describe('U9’s guides say what General settings and maintenance do (Admin v2 U9)', () => {
  const source = (path: string) => readFileSync(path, 'utf8');
  const article = (slug: string) => SET.find((a) => a.slug === slug)!;
  const text = (slug: string, lang: 'en' | 'ar') => textsOf(article(slug), lang).join('\n');
  // By its name, not its number: the number is assigned at merge (renumber-migration.mjs).
  const U9 = MIGRATION_FILES.find((f) => f.name.endsWith('_general_maintenance.sql'))!;
  const PRIOR = helpSet(MIGRATION_FILES.filter((f) => f.name < U9.name));
  const PUT =
    /^select app\.put_help_guide\(\$guide\$\r?\n([\s\S]*?)\r?\n\$guide\$::jsonb, \d+\);/gm;
  const filed = (slug: string) =>
    readFileSync(`docs/admin-v2/guides/${slug}.json`, 'utf8').replace(/\r?\n$/, '');

  it('general-settings is settings.general’s, on its screen, just before maintenance-mode', () => {
    expect(article('general-settings')).toMatchObject({
      sort_order: 98,
      title: 'General settings',
      caps: ['settings.general'],
      screens: ['/admin/settings'],
    });
    expect(article('maintenance-mode')).toMatchObject({
      sort_order: 100,
      caps: ['maintenance.manage'],
      screens: ['/admin/maintenance'],
    });
    for (const role of ROLES) {
      expect(mayRead(role, ['settings.general']), role).toBe(
        ROLE_CAPS[role]['settings.general'] === 'full',
      );
    }
  });

  it('general-settings states the rules the code and the database hold', async () => {
    const en = text('general-settings', 'en');
    const ar = text('general-settings', 'ar');
    // Icons: square uploads of at least 512 px (the trigger, the public read, the hints).
    const { ICON_MIN_PX } = await import('@/lib/data/siteProfile');
    expect(ICON_MIN_PX).toBe(512);
    expect(U9.sql).toContain('m.width = m.height and m.width >= 512');
    expect(source('src/lib/admin/ui/profile.ts')).toContain('Square, at least 512 px');
    expect(en).toContain(`a square picture at least ${ICON_MIN_PX} pixels wide`);
    expect(ar).toContain(`${ICON_MIN_PX} بكسل`);
    expect(en).toContain('Until one is chosen, the site links no icon.');
    // The map link's hosts.
    const { isMapLink } = await import('@schemas/siteProfile');
    expect(isMapLink('https://maps.app.goo.gl/abc')).toBe(true);
    expect(isMapLink('https://maps.apple.com/?q=x')).toBe(true);
    expect(isMapLink('https://www.google.com/maps/place/x')).toBe(true);
    expect(isMapLink('https://example.com/maps')).toBe(false);
    expect(en).toContain('must be a Google Maps or Apple Maps link');
    // "Show on the site" is the repeater's label, in both languages' text.
    expect(source('src/lib/admin/ui/profile.ts')).toContain("label: 'Show on the site'");
    expect(en).toContain('Show on the site off');
    expect(ar).toContain('Show on the site');
    // Only an admin opens or closes job applications: the switch's note.
    expect(source('src/components/admin/screens/general/ApplicationsSwitch.tsx')).toContain(
      "LOCKED_NOTE = 'Only an admin can open or close job applications.'",
    );
    expect(en).toContain('Only an admin can open or close job applications.');
    // Retention: shortened, never extended (the field's own hint).
    expect(source('src/lib/admin/ui/settings.ts')).toContain(
      'Each can be shortened, never extended',
    );
    expect(en).toContain('can be shortened but never extended');
    // What the zone moves, and what keeps Riyadh days.
    expect(en).toContain('the busiest hours in website stats, the uptime days in site health');
    expect(en).toContain('Page visibility keeps Riyadh days.');
    expect(source('src/components/admin/screens/visibility/VisibilityList.tsx')).toContain(
      "clockFor('Asia/Riyadh')",
    );
    expect(text('page-visibility', 'en')).toContain('Riyadh time');
  });

  it('maintenance-mode states what the panel and the edge do', async () => {
    const en = text('maintenance-mode', 'en');
    const ar = text('maintenance-mode', 'ar');
    const ui = source('src/lib/admin/ui/maintenance.ts');
    for (const label of [
      'Show email and WhatsApp buttons',
      'Show the date to visitors',
      'Signed in team still sees the site',
    ]) {
      expect(ui, label).toContain(`label: '${label}'`);
      expect(en, label).toContain(label);
      expect(ar, label).toContain(label);
    }
    expect(ui).toContain("label: 'Back on (optional)'");
    expect(en).toContain('Back on ends maintenance by itself at midnight');
    expect(ui).toContain("{ value: 'image', label: 'The hero image' }");
    expect(ui).toContain("{ value: 'black', label: 'Plain black' }");
    expect(en).toContain('the hero image or plain black');
    const { MAINTENANCE_MAX_DAYS_AHEAD } = await import('@schemas/maintenance');
    expect(en).toContain(`Pick a day up to ${MAINTENANCE_MAX_DAYS_AHEAD} days ahead.`);
    expect(ar).toContain(`خلال ${MAINTENANCE_MAX_DAYS_AHEAD} يومًا`);
    expect(source('src/components/admin/screens/maintenance/TurnOnDialog.tsx')).toContain(
      'Turn on',
    );
    expect(en).toContain('Choose Turn on and confirm.');
    expect(source('src/components/admin/screens/maintenance/MaintenancePanel.tsx')).toContain(
      'Preview full screen',
    );
    expect(en).toContain('Preview full screen opens the page as visitors see it');
    expect(source('src/components/admin/ui/Topbar.astro')).toContain('Maintenance on');
    expect(en).toContain('the top bar says Maintenance on');
    // Fail-closed: a sign in that cannot be checked sees the page (the bypass's own header).
    expect(source('src/lib/http/maintenanceBypass.ts')).toContain('FAIL CLOSED, every way');
    expect(en).toContain(
      'If their sign in cannot be checked, they see the maintenance page like everyone else.',
    );
    // Temporary to search engines: a 503 with Retry-After.
    expect(source('src/lib/http/maintenance.ts')).toContain("'retry-after': String(");
    expect(en).toContain('Search engines are told the break is temporary');
  });

  it('puts its four guides at the revisions main left, each literal its filed text', () => {
    const literals = [...U9.sql.matchAll(PUT)].map((m) => m[1] ?? '');
    const slugs = ['general-settings', 'maintenance-mode', 'website-stats', 'site-health-and-logs'];
    expect(HELP.edits.filter((e) => e.file === U9.name)).toEqual(
      slugs.map((slug) => ({
        file: U9.name,
        op: 'put',
        slug,
        revision: PRIOR.revisions.get(slug) ?? 0,
      })),
    );
    expect(literals).toEqual(slugs.map(filed));
    // The two guides of other slices change one sentence each, in both languages.
    for (const slug of ['website-stats', 'site-health-and-logs']) {
      const before = PRIOR.set.find((g) => g.slug === slug)!;
      const after = HELP.set.find((g) => g.slug === slug)!;
      const { body: b0, ...rest0 } = before as unknown as { body: Record<string, unknown[]> };
      const { body: b1, ...rest1 } = after as unknown as { body: Record<string, unknown[]> };
      expect(rest1, slug).toEqual(rest0);
      for (const lang of ['en', 'ar'] as const) {
        const flat = (blocks: unknown[]) =>
          blocks.flatMap((b) => {
            const x = (b as { x: unknown }).x;
            return Array.isArray(x) ? x : [x];
          });
        const changed = flat(b1[lang]!).filter((x, i) => x !== flat(b0[lang]!)[i]);
        expect(changed.length, `${slug} ${lang}`).toBe(1);
      }
    }
  });
});

// ── 1e. The Sales guides (C10a) ─────────────────────────────────────────────────────────

describe('the Sales guides (C10a): the-sales-role, and roles-and-access with five roles', () => {
  const article = () => SET.find((a) => a.slug === 'the-sales-role')!;
  const text = (lang: 'en' | 'ar') => textsOf(article(), lang).join(' ');
  const source = (path: string) => readFileSync(path, 'utf8');

  it('0097 puts the new guide at revision 0 and the roles guide at the revision the migrations before it leave', () => {
    const at = MIGRATION_FILES.findIndex((f) => /_sales_role\.sql$/.test(f.name));
    const before = helpSet(MIGRATION_FILES.slice(0, at));
    const c10a = HELP.edits.filter((e) => /_sales_role\.sql$/.test(e.file));
    expect(c10a.map((e) => `${e.op} ${e.slug} ${e.revision}`)).toEqual([
      `put the-sales-role ${before.revisions.get('the-sales-role') ?? 0}`,
      `put roles-and-access ${before.revisions.get('roles-and-access') ?? 0}`,
    ]);
    // The new guide is new; the roles guide was last put by U17 (0072, two-step sign-in), and
    // this put moves it by one.
    expect(before.revisions.has('the-sales-role')).toBe(false);
    expect(
      before.edits
        .filter((e) => e.slug === 'roles-and-access')
        .map((e) => e.file)
        .at(-1),
    ).toMatch(/_two_step_sign_in\.sql$/);
    expect(HELP.revisions.get('roles-and-access')).toBe(
      (before.revisions.get('roles-and-access') ?? 0) + 1,
    );
  });

  it("the roles guide is U17's text with the five roles: every block U17 left stays but the two C10a rewrites", () => {
    const at = MIGRATION_FILES.findIndex((f) => /_sales_role\.sql$/.test(f.name));
    const parse = (raw: unknown) => HelpArticleSeedSchema.parse(raw);
    const before = parse(
      helpSet(MIGRATION_FILES.slice(0, at)).set.find((g) => g.slug === 'roles-and-access'),
    );
    const after = SET.find((a) => a.slug === 'roles-and-access')!;
    const { body: beforeBody, ...beforeRest } = before;
    const { body: afterBody, ...afterRest } = after;
    expect(afterRest).toEqual(beforeRest);
    for (const lang of ['en', 'ar'] as const) {
      expect(afterBody[lang], lang).toHaveLength(beforeBody[lang].length);
      // Blocks 0 (the count) and 1 (the list) gain Sales; the rest is U17's, block for block.
      expect(afterBody[lang].slice(2), lang).toEqual(beforeBody[lang].slice(2));
    }
    const en = textsOf(after, 'en').join(' ');
    const ar = textsOf(after, 'ar').join(' ');
    expect(en).toContain("Resetting someone's 2FA");
    expect(en).toContain('Require 2FA for everyone, on the same card');
    expect(ar).toContain('إعادة ضبط 2FA لشخص ما');
  });

  it('the roles guide names the five roles ROLES has, Sales among them, in both languages', () => {
    const roles = SET.find((a) => a.slug === 'roles-and-access')!;
    expect(ROLES).toHaveLength(5);
    const en = textsOf(roles, 'en').join(' ');
    const ar = textsOf(roles, 'ar').join(' ');
    expect(en).toContain('There are five roles.');
    expect(en).not.toContain('four roles');
    expect(en).toContain("Sales: works leads, reveals one lead's contact details at a time");
    expect(ar).toContain('هناك خمسة أدوار.');
    expect(ar).toContain('Sales (المبيعات)');
  });

  it('says the notes thread is limited like the reveal, as the route has it', () => {
    expect(text('en')).toContain(
      "Opening a lead's notes is logged too, within a limit of the same size.",
    );
    expect(source('src/pages/api/admin/leads/[id]/notes.ts')).toContain(
      "claimPrivilegedOp(auth, 'lead-notes-read', PII_REVEAL_LIMITS)",
    );
  });

  it('takes its assigned place 65 (between SEO 60 and leads 70), for the lead workers', () => {
    expect(article().sort_order).toBe(65);
    expect(article().tags).toEqual(['leads', 'team']);
    expect(ROLES.filter((r) => mayRead(r, article().caps))).toEqual([
      'admin',
      'developer',
      'sales',
    ]);
    // /admin/leads opens working-with-leads from its head: one guide per screen.
    expect(pageGuideFor('/admin/leads', 'sales')).toBe('working-with-leads');
  });

  it('says what Sales holds, as ROLE_CAPS and the routes have it', () => {
    const en = text('en');
    for (const cap of ['leads.manage', 'leads.pii', 'analytics.read'] as const) {
      expect(ROLE_CAPS.sales[cap]).toBe('full');
    }
    expect(en).toContain("Reveal one lead's contact details, budget and timeline at a time");
    // The reveal's limits (src/lib/admin/rateLimit.ts) and its audit row.
    expect(en).toContain('up to 60 an hour for each person and 300 an hour for the whole team');
    expect(source('src/lib/admin/rateLimit.ts')).toMatch(
      /PII_REVEAL_LIMITS: RateLimitOptions = \{\s*perUser: 60,\s*perTenant: 300,/,
    );
    expect(en).toContain('Open the dashboard and the website stats.');
  });

  it('says what Sales cannot do, as the screens and the hook have it', () => {
    const en = text('en');
    expect(en).toContain('the Export CSV button does not show');
    expect(ROLE_CAPS.sales['export.csv']).toBe('none');
    expect(source('src/pages/admin/leads/index.astro')).toContain(
      "canExport: allowed && can(session.role, 'export.csv') === 'full'",
    );
    expect(en).toContain("Erase a lead, or receive a new lead's contact details in a notification");
    expect(ROLE_CAPS.sales['crm.erase']).toBe('none');
    expect(source('src/pages/api/hooks/notify-lead.ts')).toContain('receivesLeadPiiUnasked(role)');
    for (const cap of [
      'settings.general',
      'users.manage',
      'theme.edit',
      'applications.manage',
      'logs.view',
      'audit.view',
      'pages.write',
    ] as const) {
      expect(ROLE_CAPS.sales[cap], cap).toBe('none');
    }
    for (const label of ['Export CSV', 'Settings › Users & roles']) {
      expect(text('ar')).toContain(label);
    }
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
      'previewing-changes',
      'roles-and-access',
      'saving-and-publishing',
      'website-stats',
      'your-account',
      'your-dashboard',
    ]);
  });

  it('SEO: the basics, the media library (it opens it), SEO and redirects, and stats', () => {
    expect(shown('seo')).toEqual([
      'finding-your-way',
      'media-library',
      'previewing-changes',
      'roles-and-access',
      'seo-and-redirects',
      'website-stats',
      'your-account',
      'your-dashboard',
    ]);
  });

  it('Developer: the basics, media, leads and their personal data, maintenance, stats and site health; no hiring', () => {
    expect(shown('developer')).toEqual([
      'finding-your-way',
      'general-settings',
      'maintenance-mode',
      'media-library',
      'page-visibility',
      'personal-data',
      'previewing-changes',
      'roles-and-access',
      'site-health-and-logs',
      'the-sales-role',
      'website-stats',
      'working-with-leads',
      'your-account',
      'your-dashboard',
    ]);
  });

  it('Sales: the basics, leads and their personal data, the Sales role and stats; nothing else (C10a)', () => {
    expect(shown('sales')).toEqual([
      'finding-your-way',
      'personal-data',
      'roles-and-access',
      'the-sales-role',
      'website-stats',
      'working-with-leads',
      'your-account',
      'your-dashboard',
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
    expect(guideHref('your-account', null)).toBe('/admin/help?guide=your-account');
    expect(guideHref('your-account', '/admin/leads')).toBe(
      '/admin/help?guide=your-account&screen=%2Fadmin%2Fleads',
    );
    expect(helpHrefFor('/admin/leads')).toBe('/admin/help?screen=%2Fadmin%2Fleads');
  });

  it('a guide link keeps the screen the help was opened on (rows and related guides)', () => {
    const guide: HelpGuide = { slug: 'your-account', title: 'Your account', minutes: 2, tags: [] };
    const withScreen = '/admin/help?guide=your-account&amp;screen=%2Fadmin%2Fleads';
    const rows = renderToStaticMarkup(
      createElement(HelpGuideList, { guides: [guide], labelledBy: 'h', screen: '/admin/leads' }),
    );
    expect(rows).toContain(`href="${withScreen}"`);
    const article = SET.find((a) => a.slug === 'roles-and-access')!;
    const body = renderToStaticMarkup(
      createElement(HelpArticleBody, {
        article: { ...article, titleAr: article.title_ar },
        lang: 'en',
        level: 2,
        related: [guide],
        screen: '/admin/leads',
      }),
    );
    expect(body).toContain(`href="${withScreen}"`);
    // No screen known, no screen sent.
    const bare = renderToStaticMarkup(
      createElement(HelpGuideList, { guides: [guide], labelledBy: 'h' }),
    );
    expect(bare).toContain('href="/admin/help?guide=your-account"');
  });

  it('the help page keeps the screen on every link it builds', () => {
    const page = readFileSync('src/pages/admin/help.astro', 'utf8');
    // Every list and the related guides are given the screen; the language switch builds on
    // guideHref with it; the search form carries it as a hidden field.
    expect(page.match(/<HelpGuideList\b/g)?.length).toBe(3);
    expect(page.match(/<HelpGuideList\b[^>]*\bscreen=\{screen\}/g)?.length).toBe(3);
    expect(page).toMatch(/<HelpArticleBody\b[^>]*\bscreen=\{screen\}/);
    expect(page).not.toMatch(/guideHref\(article\.slug\)/);
    expect(page).toContain('guideHref(article.slug, screen)');
    expect(page).toContain('<input type="hidden" name="screen" value={screen} />');
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

  it('a query cut inside a surrogate pair stays well formed (cut by code points)', () => {
    const emoji = '\u{1F600}';
    // 63 letters and an emoji are 64 characters: the emoji stays whole.
    expect(cleanHelpQuery(`${'x'.repeat(63)}${emoji}`)).toBe(`${'x'.repeat(63)}${emoji}`);
    // One more letter and the emoji is past the cut: none of it is kept.
    expect(cleanHelpQuery(`${'x'.repeat(64)}${emoji}`)).toBe('x'.repeat(64));
    // 64 characters, as PostgreSQL's char_length counts them.
    expect(Array.from(cleanHelpQuery(emoji.repeat(70)))).toHaveLength(HELP_LIMITS.query);
    // Half a pair anywhere is dropped.
    expect(cleanHelpQuery('pass\ud83dword\ude00')).toBe('password');
    for (const raw of [`${'x'.repeat(63)}${emoji}`, emoji.repeat(70), 'a\ud800b', '\udfffab']) {
      const q = cleanHelpQuery(raw);
      expect(() => encodeURIComponent(q), JSON.stringify(raw)).not.toThrow();
    }
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

  it('search: the role filter runs before the cut to 20, so no readable guide is lost', async () => {
    // Thirty guides for hiring rank above twenty-five every member reads: a cut before the
    // filter would leave Content Creator nothing.
    const base = rowOf(SET[0]!);
    const hiring = Array.from({ length: 30 }, (_, i) => ({
      ...base,
      slug: `hiring-${i}`,
      caps: ['applications.manage'],
    }));
    const open = Array.from({ length: 25 }, (_, i) => ({ ...base, slug: `open-${i}`, caps: [] }));
    const { sb } = fakeDb({ rpc: [...hiring, ...open] });
    const results = await searchHelp(sb, auth('content_creator'), 'guide');
    expect(results.map((r) => r.slug)).toEqual(open.slice(0, MAX_RESULTS).map((r) => r.slug));
    // Admin reads them all: still the first 20, in the RPC's order.
    const admin = await searchHelp(
      fakeDb({ rpc: [...hiring, ...open] }).sb,
      auth('admin'),
      'guide',
    );
    expect(admin.map((r) => r.slug)).toEqual(hiring.slice(0, MAX_RESULTS).map((r) => r.slug));
  });

  it('search: a crafted query cut through an emoji reaches the RPC well formed', async () => {
    const { sb, calls } = fakeDb({ rpc: [] });
    await searchHelp(sb, auth('admin'), `${'x'.repeat(63)}\u{1F600}tail`);
    const sent = String(calls.rpc[0]?.args['p_q']);
    expect(sent).toBe(`${'x'.repeat(63)}\u{1F600}`);
    expect(() => encodeURIComponent(sent)).not.toThrow();
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
    // In the catalog's order: the-sales-role sits at 65, before leads (70); the page head still
    // opens working-with-leads (PAGE_GUIDES).
    expect(data.onScreen).toEqual(['the-sales-role', 'working-with-leads', 'personal-data']);
    expect(pageGuideFor('/admin/leads', 'developer')).toBe('working-with-leads');
    expect(data.guides.some((g) => g.slug === 'job-applications')).toBe(false);
  });

  it('GET /api/admin/help as Sales (C10a): its guides only, the leads screen’s three', async () => {
    const { sb } = fakeDb({ rows: SET.map(rowOf) });
    const { status, body } = await call(
      () => import('@/pages/api/admin/help/index'),
      '/api/admin/help?screen=%2Fadmin%2Fleads',
      'sales',
      sb,
    );
    expect(status).toBe(200);
    const data = body.data as { guides: HelpGuide[]; onScreen: string[] };
    expect(data.onScreen).toEqual(['the-sales-role', 'working-with-leads', 'personal-data']);
    expect(pageGuideFor('/admin/leads', 'sales')).toBe('working-with-leads');
    for (const slug of ['job-applications', 'saving-and-publishing', 'media-library']) {
      expect(
        data.guides.some((g) => g.slug === slug),
        slug,
      ).toBe(false);
    }
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
      /href=\{guideHref\(guide, screen\)\}\s+data-open="help"\s+data-help-guide=\{guide\}/,
    );
  });
});
