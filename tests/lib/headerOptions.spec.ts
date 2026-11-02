import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HEADER_BLURS,
  HEADER_COLUMNS,
  HEADER_CTA_HREF_LOCALIZED,
  HEADER_CTA_HREF_PATTERN,
  HEADER_DEFAULTS,
  HEADER_LOGO_POSITIONS,
  HEADER_LOGO_SIZES,
  HEADER_MENU_ALIGNS,
  HEADER_MOBILE_MENUS,
  HEADER_TINTS,
  SiteAppearanceWriteSchema,
} from '@schemas/appearance';
import { headerAttributes, headerFromRow, LOGO_SIZES } from '@/lib/appearance/header';
import { siteAppearanceSingleton } from '@/lib/admin/singletons/siteAppearance';
import { ValidationError } from '@/lib/admin/errors';
import { appearanceUi } from '@/lib/admin/ui/appearance';
import { barSketch, afterLine } from '@/components/admin/screens/header/sketch';
import {
  afterChange,
  keyChanges,
  KeyMoveError,
  MENU_PAGE,
  MENU_PAGES_MAX,
  menuKey,
  menuRows,
  movedOrder,
  moveKey,
  readMenu,
  type RowWrite,
} from '@/components/admin/screens/header/menu';
import { readsThroughRelease } from '@/lib/admin/releaseEvents';

// The header's options (Admin v2 E5, `public.site_appearance`): the Worker's schema, the
// public reader and the screen's pure parts, each held to the SQL the E5 migration writes, so
// the two layers cannot drift apart. supabase/tests/site_appearance.test.sql holds the
// database's side over every role.

// Found by its name, not its number: the merge train renumbers it.
const FILE = readdirSync('supabase/migrations').find((f) => /^\d{4}_site_appearance\.sql$/.test(f));
const SQL = readFileSync(`supabase/migrations/${FILE}`, 'utf8');
const BI = (en: string, ar: string) => ({ en, ar });

/** A CHECK's `in (...)` list for a column, from the migration. */
function sqlBucket(column: string): string[] {
  const m = new RegExp(`check \\(${column} in \\(([^)]*)\\)\\)`).exec(SQL);
  if (!m) throw new Error(`no bucket CHECK for ${column}`);
  return [...m[1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]!);
}

/** A column's DEFAULT, from the migration. */
function sqlDefault(column: string): string {
  const m = new RegExp(`\\n  ${column} (?:text|boolean) not null default ([^,\\n]+),`).exec(SQL);
  if (!m) throw new Error(`no default for ${column}`);
  return m[1]!.replace(/'/g, '');
}

describe('the buckets equal the SQL CHECKs', () => {
  it.each([
    ['header_logo_position', HEADER_LOGO_POSITIONS],
    ['header_logo_size', HEADER_LOGO_SIZES],
    ['header_menu_align', HEADER_MENU_ALIGNS],
    ['header_tint', HEADER_TINTS],
    ['header_blur', HEADER_BLURS],
    ['header_mobile_menu', HEADER_MOBILE_MENUS],
  ] as const)('%s', (column, values) => {
    expect(sqlBucket(column)).toEqual([...values]);
  });

  it('the defaults are the header as built, in the table and in the code', () => {
    for (const [key, column] of Object.entries(HEADER_COLUMNS)) {
      if (key === 'ctaLabel' || key === 'ctaHref') continue;
      expect(sqlDefault(column), column).toBe(
        String(HEADER_DEFAULTS[key as keyof typeof HEADER_DEFAULTS]),
      );
      expect(siteAppearanceSingleton.defaults[column], column).toEqual(
        HEADER_DEFAULTS[key as keyof typeof HEADER_DEFAULTS],
      );
    }
  });

  it('every option is a field of the screen, and every field an option', () => {
    expect(appearanceUi.fields.map((f) => f.name).sort()).toEqual(
      Object.keys(HEADER_COLUMNS).sort(),
    );
    for (const field of appearanceUi.fields) {
      expect(field.column).toBe(HEADER_COLUMNS[field.name as keyof typeof HEADER_COLUMNS]);
    }
    const selects = appearanceUi.fields.filter((f) => f.kind === 'select');
    const BUCKETS: Record<string, readonly string[]> = {
      logoPosition: HEADER_LOGO_POSITIONS,
      logoSize: HEADER_LOGO_SIZES,
      menuAlign: HEADER_MENU_ALIGNS,
      tint: HEADER_TINTS,
      blur: HEADER_BLURS,
      mobileMenu: HEADER_MOBILE_MENUS,
    };
    for (const field of selects) {
      expect(
        field.options?.map((o) => o.value),
        field.name,
      ).toEqual([...BUCKETS[field.name]!]);
    }
  });
});

describe('the write schema', () => {
  const ok = (body: Record<string, unknown>) =>
    SiteAppearanceWriteSchema.safeParse({ version: 1, ...body }).success;

  it('takes a whole header and any part of one (a pending change names only some)', () => {
    expect(ok({ ...HEADER_DEFAULTS })).toBe(true);
    expect(ok({ logoSize: 'l' })).toBe(true);
    expect(ok({})).toBe(true);
  });

  it('refuses a value outside its bucket', () => {
    expect(ok({ logoSize: 'xl' })).toBe(false);
    expect(ok({ tint: 'black' })).toBe(false);
    expect(ok({ menuAlign: 'justify' })).toBe(false);
    expect(ok({ sticky: 'yes' })).toBe(false);
  });

  it('a shown button needs its words and its link', () => {
    expect(ok({ ctaShow: true, ctaLabel: null })).toBe(false);
    expect(ok({ ctaShow: true, ctaHref: null })).toBe(false);
    expect(ok({ ctaShow: true, ctaLabel: BI('Go', 'اذهب'), ctaHref: '/contact' })).toBe(true);
    expect(ok({ ctaShow: false, ctaLabel: null, ctaHref: null })).toBe(true);
  });

  it('the button words: both languages, trimmed, at most 40 characters, no line break', () => {
    expect(ok({ ctaLabel: BI('Go', '') })).toBe(false);
    expect(ok({ ctaLabel: BI('a'.repeat(41), 'ب') })).toBe(false);
    expect(ok({ ctaLabel: BI('Two\nlines', 'ب') })).toBe(false);
    const parsed = SiteAppearanceWriteSchema.parse({ version: 1, ctaLabel: BI(' Go ', ' ب ') });
    expect(parsed.ctaLabel).toEqual(BI('Go', 'ب'));
  });

  it('the button link: a page of this site or an https link, nothing else', () => {
    for (const good of ['/', '/contact#inquiry', '/services?x=1', 'https://cal.example/a']) {
      expect(ok({ ctaHref: good }), good).toBe(true);
      expect(HEADER_CTA_HREF_PATTERN.test(good), good).toBe(true);
    }
    for (const bad of [
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'http://plain.example',
      '/a b',
      '/a"b',
      "/a'b",
      '/<b>',
      'contact',
      'https://',
      'https:///x',
    ]) {
      expect(ok({ ctaHref: bad }), bad).toBe(false);
    }
  });

  it('the SQL CHECK reads the same pattern', () => {
    expect(SQL).toContain(
      `header_cta_href ~ '^(/([^/\\\\[:space:]<>"''][^\\\\[:space:]<>"'']*)?|https://[^/\\\\[:space:]<>"''][^\\\\[:space:]<>"'']*)$'`,
    );
    // ...and refuses the Arabic prefix with the same pattern as HEADER_CTA_HREF_LOCALIZED.
    expect(SQL).toContain(`header_cta_href !~ '^/ar([/?#]|$)'`);
    expect(HEADER_CTA_HREF_LOCALIZED.source).toBe(String.raw`^\/ar(?:[/?#]|$)`);
  });

  it('the button link never carries the Arabic prefix: an Arabic page adds it (no /ar/ar/…)', () => {
    for (const bad of [
      '/ar',
      '/ar/',
      '/ar/services?x=1',
      '/ar#inquiry',
      '/ar?x=1',
      ' /ar/contact ',
    ]) {
      expect(ok({ ctaHref: bad }), bad).toBe(false);
    }
    // A path that only begins with the letters is a page of its own.
    for (const good of ['/arabic-calligraphy', '/art', '/services/ar']) {
      expect(ok({ ctaHref: good }), good).toBe(true);
    }
  });

  it('a sticky bar that stays see-through after the hero takes the darkest tint', () => {
    expect(ok({ sticky: true, solidAfterHero: false, tint: 'medium' })).toBe(false);
    expect(ok({ sticky: true, solidAfterHero: false, tint: 'dark' })).toBe(true);
    expect(ok({ sticky: false, solidAfterHero: false, tint: 'none' })).toBe(true);
    // A part that does not name all three is left to the SQL CHECK, which sees the row.
    expect(ok({ solidAfterHero: false })).toBe(true);
  });

  it('the singleton refuses a link the menus’ scheme allowlist refuses', () => {
    expect(() => siteAppearanceSingleton.toRow({ ctaHref: 'https://ok.example/x' })).not.toThrow();
    // Each of these passes the schema's pattern (and the SQL CHECK) but is no URL at all:
    // `new URL()` throws, so sanitizeHref refuses it, and only toRow stands in the way.
    for (const bad of ['https://a:b', 'https://%zz', 'https://[::1']) {
      expect(HEADER_CTA_HREF_PATTERN.test(bad), bad).toBe(true);
      expect(() => siteAppearanceSingleton.toRow({ ctaHref: bad }), bad).toThrow(ValidationError);
    }
    expect(siteAppearanceSingleton.toRow({ logoSize: 'l', ctaShow: true })).toEqual({
      header_logo_size: 'l',
      header_cta_show: true,
    });
  });
});

describe('the public reader', () => {
  it('no row is the header as built, and so is a row of defaults', () => {
    expect(headerFromRow(null)).toEqual(HEADER_DEFAULTS);
    const row = Object.fromEntries(
      Object.entries(HEADER_COLUMNS).map(([k, c]) => [
        c,
        HEADER_DEFAULTS[k as keyof typeof HEADER_DEFAULTS],
      ]),
    );
    expect(headerFromRow(row)).toEqual(HEADER_DEFAULTS);
    expect(headerAttributes(headerFromRow(row))).toEqual({});
  });

  it('an unreadable option costs that option, never the page', () => {
    const s = headerFromRow({ header_logo_size: 'xl', header_tint: 'medium', header_sticky: 'no' });
    expect(s.logoSize).toBe('m');
    expect(s.tint).toBe('medium');
    expect(s.sticky).toBe(true);
  });

  it('a button with no words or no link is no button', () => {
    expect(
      headerFromRow({ header_cta_show: true, header_cta_href: '/contact', header_cta_label: null })
        .ctaShow,
    ).toBe(false);
    expect(
      headerFromRow({
        header_cta_show: true,
        header_cta_href: 'javascript:alert(1)',
        header_cta_label: BI('Go', 'اذهب'),
      }).ctaShow,
    ).toBe(false);
  });

  it('a link that is no URL, written around the Worker, is no button (the scheme allowlist)', () => {
    for (const href of ['https://a:b', 'https://%zz', 'https://[::1']) {
      const s = headerFromRow({
        header_cta_show: true,
        header_cta_href: href,
        header_cta_label: BI('Go', 'اذهب'),
      });
      expect(s.ctaHref, href).toBeNull();
      expect(s.ctaShow, href).toBe(false);
    }
    expect(
      headerFromRow({
        header_cta_show: true,
        header_cta_href: '/ar/contact',
        header_cta_label: BI('Go', 'اذهب'),
      }).ctaShow,
    ).toBe(false);
  });

  it('a see-through bar with too light a tint that got past the CHECK turns solid', () => {
    const s = headerFromRow({ header_solid_after_hero: false, header_tint: 'light' });
    expect(s.solidAfterHero).toBe(true);
  });

  it('one attribute per option that differs, each a bucket value', () => {
    expect(
      headerAttributes({
        ...HEADER_DEFAULTS,
        logoSize: 's',
        sticky: false,
        tint: 'dark',
        mobileMenu: 'full',
      }),
    ).toEqual({
      'data-logo': 's',
      'data-sticky': 'off',
      'data-tint': 'dark',
      'data-mobile': 'full',
    });
  });

  it('the logo presets are global.css’s, the medium one the header as built', () => {
    const css = readFileSync('public/styles/global.css', 'utf8');
    expect(css).toContain(`--bs-logo-w: ${LOGO_SIZES.m};`);
    for (const size of ['s', 'l'] as const) {
      expect(css).toMatch(
        new RegExp(
          `:root:has\\(\\.site-header\\[data-logo='${size}'\\]\\) \\{\\s*--bs-logo-w: ${LOGO_SIZES[size].replace(/[()]/g, '\\$&')};`,
        ),
      );
    }
  });

  it('every attribute value the header can carry has its rule in global.css', () => {
    const css = readFileSync('public/styles/global.css', 'utf8');
    const rules = [
      "[data-logo-pos='center']",
      "[data-align='start']",
      "[data-align='end']",
      "[data-sticky='off']",
      "[data-tint='medium']",
      "[data-tint='dark']",
      "[data-blur='none']",
      "[data-blur='strong']",
      "[data-mobile='full']",
    ];
    for (const rule of rules) expect(css, rule).toContain(rule);
    // data-hide and data-solid are the script's (SiteHeader.astro).
    const header = readFileSync('src/components/SiteHeader.astro', 'utf8');
    expect(header).toContain("header.dataset.hide !== 'off'");
    expect(header).toContain("header.dataset.solid !== 'off'");
    expect(header).toContain("header.dataset.sticky !== 'off'");
  });
});

describe('the screen’s sketches', () => {
  it('over the hero: the tint; after scrolling: solid, or as it was', () => {
    const values = { tint: 'light', blur: 'strong', solidAfterHero: true, logoSize: 'l' };
    expect(barSketch(values, false)).toMatchObject({ backdrop: 'light', blur: 'none', logo: 'l' });
    expect(barSketch(values, true)).toMatchObject({ backdrop: 'solid', blur: 'strong' });
    expect(barSketch({ ...values, solidAfterHero: false, tint: 'dark' }, true)).toMatchObject({
      backdrop: 'dark',
      blur: 'none',
    });
    expect(afterLine({ solidAfterHero: false })).toBe('Stays as it is');
    expect(afterLine({ sticky: false })).toBe('Scrolls away with the page');
    expect(afterLine({})).toBe('Turns solid');
  });

  it('after scrolling the ground is the page, whatever the bar does; a bar that is not sticky is gone', () => {
    // Over the hero: the hero's ground, the bar drawn.
    expect(barSketch({}, false)).toMatchObject({ ground: 'hero', shown: true });
    expect(barSketch({ sticky: false }, false)).toMatchObject({ ground: 'hero', shown: true });
    // After scrolling: the page's light sections under a solid bar...
    expect(barSketch({}, true)).toMatchObject({ ground: 'page', shown: true, backdrop: 'solid' });
    // ...and under a bar that stays as it is: the tint over the page, the case its minimum is for.
    expect(barSketch({ sticky: true, solidAfterHero: false, tint: 'dark' }, true)).toMatchObject({
      ground: 'page',
      shown: true,
      backdrop: 'dark',
    });
    // A bar that scrolls away with the page is not drawn there at all.
    expect(barSketch({ sticky: false, solidAfterHero: true }, true)).toMatchObject({
      ground: 'page',
      shown: false,
    });
  });

  it('the button shows its English words only while it is on', () => {
    expect(barSketch({ ctaShow: true, ctaLabel: BI(' Go ', 'اذهب') }, false).button).toBe('Go');
    expect(barSketch({ ctaShow: false, ctaLabel: BI('Go', 'اذهب') }, false).button).toBeNull();
    expect(barSketch({ ctaShow: true, ctaLabel: null }, false).button).toBeNull();
  });

  it('an unknown value draws the header as built', () => {
    expect(barSketch({ logoSize: 'xl', tint: 'red', menuAlign: 1 }, false)).toEqual({
      ground: 'hero',
      shown: true,
      backdrop: 'none',
      blur: 'none',
      logo: 'm',
      logoPosition: 'start',
      align: 'center',
      button: null,
    });
  });
});

describe('the menu card', () => {
  const RAW: Record<string, unknown>[] = [
    {
      id: 'c',
      location: 'header',
      parent_id: null,
      label: BI('Contact', 'تواصل'),
      href: '/contact',
      visible: true,
      is_key: true,
      sort_order: 30,
      version: 2,
    },
    {
      id: 'a',
      location: 'header',
      parent_id: null,
      label: BI('About', 'من نحن'),
      href: '/about',
      visible: false,
      is_key: false,
      sort_order: 10,
      version: 1,
    },
    {
      id: 'w',
      location: 'header',
      parent_id: null,
      label: BI('Work', 'أعمالنا'),
      href: '/portfolio',
      visible: true,
      is_key: false,
      sort_order: 20,
      version: 5,
    },
    {
      id: 'w1',
      location: 'header',
      parent_id: 'w',
      label: BI('All', 'الكل'),
      href: '/portfolio/all',
      visible: true,
      is_key: false,
      sort_order: 1,
      version: 1,
    },
    {
      id: 'f',
      location: 'footer',
      parent_id: null,
      label: BI('Privacy', 'الخصوصية'),
      href: '/privacy',
      visible: true,
      is_key: false,
      sort_order: 1,
      version: 1,
    },
  ];
  const rows = menuRows(RAW);

  it('lists the header’s top-level links in order, with their sub-link counts', () => {
    expect(rows.map((r) => [r.id, r.label, r.visible, r.isKey, r.children])).toEqual([
      ['a', 'About', false, false, 0],
      ['w', 'Work', true, false, 1],
      ['c', 'Contact', true, true, 0],
    ]);
  });

  it('moving the star clears the old key link first; pressing the key clears it', () => {
    const key = menuKey(RAW);
    expect(key).toMatchObject({ id: 'c', sub: false, label: 'Contact' });
    expect(keyChanges(rows, 'w', key)).toEqual([
      { id: 'c', version: 2, isKey: false, pending: null },
      { id: 'w', version: 5, isKey: true, pending: null },
    ]);
    expect(keyChanges(rows, 'c', key)).toEqual([
      { id: 'c', version: 2, isKey: false, pending: null },
    ]);
    expect(keyChanges(rows, 'nope', key)).toEqual([]);
    expect(keyChanges(rows, 'w', null)).toEqual([
      { id: 'w', version: 5, isKey: true, pending: null },
    ]);
  });

  // E5 code review CR2: the unique index holds one key per MENU, sub-links included.
  it('a sub-link that holds the key is found and cleared first (no 23505)', () => {
    const raw = RAW.map((r) =>
      r['id'] === 'c' ? { ...r, is_key: false } : r['id'] === 'w1' ? { ...r, is_key: true } : r,
    );
    const key = menuKey(raw);
    expect(key).toMatchObject({ id: 'w1', label: 'All', sub: true, version: 1 });
    expect(keyChanges(menuRows(raw), 'a', key)).toEqual([
      { id: 'w1', version: 1, isKey: false, pending: null },
      { id: 'a', version: 1, isKey: true, pending: null },
    ]);
    // The footer's key is another menu's.
    expect(menuKey([{ id: 'f', location: 'footer', is_key: true }])).toBeNull();
  });

  // E5 code review CR1: the two PATCHes of a move cannot be one write, so a failed second one
  // puts the old key back, and says whether that worked.
  describe('moving the key', () => {
    const ok = (id: string, version: number): Record<string, unknown> => ({ id, version });
    const changes = () => keyChanges(rows, 'w', menuKey(RAW));

    it('sends the clear, then the set, each with its own version', async () => {
      const sent: [string, RowWrite][] = [];
      const pending = await moveKey(
        changes(),
        async (id, write) => {
          sent.push([id, write]);
          return ok(id, 9);
        },
        false,
      );
      expect(pending).toBe(false);
      expect(sent).toEqual([
        ['c', { body: { isKey: false, version: 2 }, mark: false }],
        ['w', { body: { isKey: true, version: 5 }, mark: false }],
      ]);
    });

    it('a failed second write sets the old key again, at the version the clear answered', async () => {
      const sent: [string, RowWrite][] = [];
      const refusal = new Error('409');
      const run = moveKey(
        changes(),
        async (id, write) => {
          sent.push([id, write]);
          if (id === 'w') throw refusal;
          return ok(id, 3);
        },
        false,
      );
      await expect(run).rejects.toBeInstanceOf(KeyMoveError);
      await run.catch((err: KeyMoveError) => {
        expect(err.restored).toBe(true);
        expect(err.reason).toBe(refusal);
      });
      expect(sent.map(([id, w]) => [id, w.body])).toEqual([
        ['c', { isKey: false, version: 2 }],
        ['w', { isKey: true, version: 5 }],
        ['c', { isKey: true, version: 3 }],
      ]);
    });

    it('says so when the old key could not be put back either', async () => {
      const run = moveKey(
        changes(),
        async (id, write) => {
          if (id === 'w' || write.body['isKey'] === true) throw new Error('down');
          return ok(id, 3);
        },
        false,
      );
      await run.catch(() => undefined);
      await expect(run).rejects.toMatchObject({ restored: false });
    });

    it('a failed first write changes nothing and is thrown as it is', async () => {
      const refusal = new Error('409');
      const sent: string[] = [];
      await expect(
        moveKey(
          changes(),
          async (id) => {
            sent.push(id);
            throw refusal;
          },
          false,
        ),
      ).rejects.toBe(refusal);
      expect(sent).toEqual(['c']);
    });

    it('in release mode: names a pending change, else carries the marker; the undo names the clear’s', async () => {
      const raw = RAW.map((r) =>
        r['id'] === 'w' ? { ...r, draft: { id: 'd-w', version: 4, op: 'update' } } : r,
      );
      const moves = keyChanges(menuRows(raw), 'w', menuKey(raw));
      const sent: [string, RowWrite][] = [];
      const run = moveKey(
        moves,
        async (id, write) => {
          sent.push([id, write]);
          if (id === 'w') throw new Error('409');
          return { id, version: 2, draft: { id: 'd-c', version: 1, op: 'update' } };
        },
        true,
      );
      await run.catch(() => undefined);
      expect(sent).toEqual([
        ['c', { body: { isKey: false, version: 2 }, mark: true }],
        ['w', { body: { isKey: true, version: 5, draftId: 'd-w', draftVersion: 4 }, mark: false }],
        ['c', { body: { isKey: true, version: 2, draftId: 'd-c', draftVersion: 1 }, mark: false }],
      ]);
    });
  });

  // E5 code review CR4: the API answers at most 100 rows; a move renumbers from the list read.
  it('reads the whole menu page by page, and says when it could not', async () => {
    const all = Array.from({ length: 230 }, (_, i) => ({ id: `n${i}`, location: 'header' }));
    const offsets: number[] = [];
    const read = await readMenu(async (offset) => {
      offsets.push(offset);
      return {
        rows: all.slice(offset, offset + MENU_PAGE),
        total: all.length,
        draftsInvalid: [],
      };
    }, readsThroughRelease);
    expect(offsets).toEqual([0, 100, 200]);
    expect(read).toMatchObject({ staged: true, complete: true });
    expect(read.rows).toHaveLength(230);

    const endless = await readMenu(
      async () => ({ rows: all.slice(0, MENU_PAGE), total: 1e6 }),
      readsThroughRelease,
    );
    expect(endless).toMatchObject({ staged: false, complete: false });
    expect(endless.rows).toHaveLength(MENU_PAGE * MENU_PAGES_MAX);
  });

  // E5 code review CR5: a move that changes nothing says nothing.
  it('a change that wrote nothing is not announced', () => {
    expect(afterChange('none', 'Menu order updated.')).toEqual({ toast: null, announce: false });
    expect(afterChange('live', 'Menu order updated.')).toEqual({
      toast: 'Menu order updated.',
      announce: false,
    });
    expect(afterChange('pending', 'Done.')).toEqual({ toast: 'Done.', announce: true });
  });

  it('the card reads, moves, stars and hides through these helpers', () => {
    const screen = readFileSync('src/components/admin/screens/header/HeaderScreen.tsx', 'utf8');
    expect(screen).toContain('readMenu(');
    expect(screen).toContain('moveKey(');
    expect(screen).toContain('afterChange(');
    expect(screen).not.toContain('limit=100');
    expect(screen).toMatch(/disabled=\{working \|\| !complete \|\| index === 0\}/);
  });

  it('moves one place, and stays put at either end', () => {
    expect(movedOrder(rows, 'w', -1)).toEqual(['w', 'a', 'c']);
    expect(movedOrder(rows, 'w', 1)).toEqual(['a', 'c', 'w']);
    expect(movedOrder(rows, 'a', -1)).toEqual(['a', 'w', 'c']);
    expect(movedOrder(rows, 'c', 1)).toEqual(['a', 'w', 'c']);
  });
});
