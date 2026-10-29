import { randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { expectCleanAtWidths } from './collectionLayout';
import { RELEASES_OFF_ONLY, SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

/*
 * The section blocks (Admin v2 E10), through the real Worker and the seeded local database,
 * releases off. The service role puts a Text block, a Gallery and a Video, visible, at the end
 * of About (a published page), and removes them afterwards whatever failed; the project runs
 * alone (playwright.config.ts `blocks`), after the public and the admin specs, because those
 * read About.
 *
 *   served HTML   /about and /ar/about: each block in its language, the body as the allowlist
 *                 renderer writes it, the gallery's pictures lazy and sized, and no <video>;
 *   video bytes   the Video's frame mounts no <video> while it is below the fold, even parked
 *                 just under it, and mounts one once it is on screen; its own pause control
 *                 then shows and stops it (and it stays stopped back in view); under reduced
 *                 motion the whole page fetches no video at all, after a full scroll, and the
 *                 control stays hidden;
 *   axe           the blocks at 320, 390 and 1280 px in English and Arabic: zero WCAG 2.2 A/AA
 *                 violations and no sideways scroll;
 *   the editor    as Admin: Add section offers all three on About; each block's panel shows its
 *                 fields (the rich text editor with the body, the gallery's three pictures, the
 *                 still and the film); a heading saved; clean at every width.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.skip(releasesOn(), RELEASES_OFF_ONLY);
test.describe.configure({ mode: 'serial' });

const MARK = randomBytes(4).toString('hex');
const STILL = (n: number) => `5eed0a00-0000-4000-8000-00000000000${n}`;

type Node = { type: string; text?: string; attrs?: object; marks?: object[]; content?: Node[] };
const doc = (...content: Node[]) => ({ type: 'doc', content });
const para = (...content: Node[]): Node => ({ type: 'paragraph', content });
const text = (t: string, marks?: object[]): Node =>
  marks ? { type: 'text', text: t, marks } : { type: 'text', text: t };

const TEXT_BLOCK = {
  tag: { en: 'Notes', ar: 'ملاحظات' },
  heading: { en: `Block words ${MARK}`, ar: `كلمات القسم ${MARK}` },
  body: {
    en: doc(
      para(
        text('An English paragraph with '),
        text('a link', [{ type: 'link', attrs: { href: '/contact' } }]),
        text('.'),
      ),
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [para(text('One point'))] }],
      },
    ),
    ar: doc(
      para(
        text('فقرة عربية ١٢٣ مع '),
        text('رابط', [{ type: 'link', attrs: { href: '/contact' } }]),
      ),
    ),
  },
};
const GALLERY = {
  heading: { en: `Pictures ${MARK}`, ar: `صور ${MARK}` },
  items: [1, 2, 3].map((n) => ({ kind: 'image', mediaId: STILL(n) })),
};
const VIDEO = {
  heading: { en: `A film ${MARK}`, ar: `فيلم ${MARK}` },
  lead: { en: 'A moment of the reel.', ar: 'لحظة من الفيلم.' },
  mediaId: STILL(4),
  clip: { path: '/media/showreel.mp4', startS: 14, endS: 15.4 },
};

let aboutId = '';
const ids: Record<'textBlock' | 'gallery' | 'video', string> = {
  textBlock: '',
  gallery: '',
  video: '',
};

function service() {
  const env = staffEnv()!;
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.beforeAll(async () => {
  if (!staffEnv() || releasesOn()) return;
  const svc = service();
  const about = await svc
    .from('pages')
    .select('id')
    .eq('tenant_id', TENANT_ID)
    .eq('slug', 'about')
    .single();
  expect(about.error).toBeNull();
  aboutId = String((about.data as { id: string }).id);
  const last = await svc
    .from('page_sections')
    .select('sort_order')
    .eq('page_id', aboutId)
    .order('sort_order', { ascending: false })
    .limit(1);
  expect(last.error).toBeNull();
  const after = Number((last.data?.[0] as { sort_order?: number } | undefined)?.sort_order ?? 0);
  const rows = [
    { type: 'textBlock', content: TEXT_BLOCK },
    { type: 'gallery', content: GALLERY },
    { type: 'video', content: VIDEO },
  ].map((row, i) => ({
    tenant_id: TENANT_ID,
    page_id: aboutId,
    visible: true,
    sort_order: after + 10 * (i + 1),
    ...row,
  }));
  const inserted = await svc.from('page_sections').insert(rows).select('id,type');
  expect(inserted.error).toBeNull();
  for (const row of (inserted.data ?? []) as { id: string; type: keyof typeof ids }[]) {
    ids[row.type] = row.id;
  }
  expect(Object.values(ids).every(Boolean)).toBe(true);
});

test.afterAll(async () => {
  if (!staffEnv() || releasesOn()) return;
  const made = Object.values(ids).filter(Boolean);
  if (made.length > 0) await service().from('page_sections').delete().in('id', made);
});

const isVideoRequest = (r: Request) =>
  r.resourceType() === 'media' || /\.(mp4|webm|m3u8|mov)(\?|$)/i.test(r.url());

test.describe('the public page', () => {
  for (const [path, locale] of [
    ['/about', 'en'],
    ['/ar/about', 'ar'],
  ] as const) {
    test(`${path}: each block server-rendered in its language, no <video>`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      const html = await res.text();
      expect(html.match(/<video[\s>]/gi) ?? [], 'server-rendered <video>').toHaveLength(0);
      const between = (from: string, to: string) => {
        const start = html.indexOf(from);
        expect(start, from).toBeGreaterThan(-1);
        const end = html.indexOf(to, start);
        return html.slice(start, end === -1 ? undefined : end);
      };
      // The Text block: the tag, the heading and the body in this language only.
      const textBlock = between('<section class="blk-text"', '</section>');
      expect(textBlock).toContain(TEXT_BLOCK.heading[locale]);
      if (locale === 'en') {
        expect(textBlock).toContain('<p>An English paragraph with <a href="/contact"');
        expect(textBlock).toContain('<li><p>One point</p></li>');
      } else {
        expect(textBlock).toContain('فقرة عربية ١٢٣ مع');
        expect(textBlock).not.toContain('English paragraph');
      }
      expect(textBlock).not.toMatch(/\sstyle=/);
      // The Gallery: three lazy, sized pictures with the library's alt text.
      const gallery = between('<section class="blk-gal"', '</section>');
      expect(gallery).toContain(GALLERY.heading[locale]);
      const imgs = gallery.match(/<img\b[^>]*>/g) ?? [];
      expect(imgs).toHaveLength(3);
      for (const img of imgs) {
        expect(img).toMatch(/\sloading="lazy"/);
        expect(img).toMatch(/\swidth="\d+"/);
        expect(img).toMatch(/\sheight="\d+"/);
        expect(img).toMatch(/\salt="[^"]+"/);
      }
      // The Video: the still alone, a lazy in-view clip surface of a /media file.
      const video = between('<section class="blk-video"', '</section>');
      expect(video).toContain(VIDEO.heading[locale]);
      expect(video).toContain('data-clip-src="/media/showreel.mp4"');
      expect(video).toContain('data-clip-mode="inview"');
      expect(video).not.toContain('data-clip-after-load');
      const still = video.match(/<img\b[^>]*>/g) ?? [];
      expect(still).toHaveLength(1);
      expect(still[0]).toMatch(/\sloading="lazy"/);
    });
  }

  test('the Video mounts its film on intersection, not before', async ({ page }) => {
    await page.goto('/about', { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const frame = page.locator('.blk-video__frame');
    await expect(frame).toHaveCount(1);
    expect(await frame.locator('video').count(), 'mounted at load, below the fold').toBe(0);
    // Parked just below the fold: a "preload on approach" margin would mount it here.
    await page.evaluate(() => {
      const el = document.querySelector('.blk-video__frame')!;
      const top = el.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, top - innerHeight - 40));
    });
    await page.waitForTimeout(800);
    expect(await frame.locator('video').count(), 'mounted before it was on screen').toBe(0);
    await frame.scrollIntoViewIfNeeded();
    await expect(frame.locator('video')).toHaveCount(1, { timeout: 5000 });
    // The film is muted, hidden from assistive tech and never preloaded before it mounts.
    await expect(frame.locator('video')).toHaveAttribute('aria-hidden', 'true');
    // Its own pause control (WCAG 2.2.2): shown once wired, named for what it does next. The
    // test browser may not decode the film, so this reads the state, not the picture.
    const toggle = page.locator('.blk-video__box button[data-clip-toggle]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAccessibleName('Pause the film');
    await toggle.click();
    await expect(toggle).toHaveAccessibleName('Play the film');
    expect(await frame.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    await expect(frame).not.toHaveClass(/is-playing/);
    // Stopped, it stays stopped when it leaves the screen and comes back.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await frame.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    expect(await frame.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    await toggle.click();
    await expect(toggle).toHaveAccessibleName('Pause the film');
  });

  test('reduced motion: no video bytes at all, even after a full scroll', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const seen: string[] = [];
    page.on('request', (r) => {
      if (isVideoRequest(r)) seen.push(r.url());
    });
    await page.goto('/about', { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    const height = await page.evaluate(() => document.scrollingElement!.scrollHeight);
    const step = await page.evaluate(() => Math.round(innerHeight * 0.6));
    for (let y = 0; y <= height; y += step) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(800);
    expect(seen, 'video requested under prefers-reduced-motion').toEqual([]);
    expect(await page.locator('video').count()).toBe(0);
    // The still stays, and there is nothing to pause.
    await expect(page.locator('.blk-video__frame img')).toBeVisible();
    await expect(page.locator('.blk-video__box button[data-clip-toggle]')).toBeHidden();
    await ctx.close();
  });

  for (const path of ['/about', '/ar/about']) {
    test(`${path}: the blocks pass axe at 320, 390 and 1280 px, no sideways scroll`, async ({
      browser,
    }) => {
      // Reduced motion: the reveal never hides anything, so axe reads the colours a visitor
      // reads once the blocks are on screen.
      const ctx = await browser.newContext({ reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.goto(path, { waitUntil: 'load' });
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.locator('.blk-video').scrollIntoViewIfNeeded();
        const sideways = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(sideways, `${path} at ${width}px: no sideways scroll`).toBeLessThanOrEqual(0);
        const { violations } = await new AxeBuilder({ page })
          .include('.blk-text')
          .include('.blk-gal')
          .include('.blk-video')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          violations.map(
            (v) =>
              `${v.id} ${v.nodes.length}x: ${v.help} at ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          ),
          `${path} at ${width}px`,
        ).toEqual([]);
      }
      await ctx.close();
    });
  }
});

test.describe('the page editor, as admin', () => {
  test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

  const column = (page: Page) => page.getByRole('complementary', { name: 'Sections' });
  const rowOf = (page: Page, name: string) =>
    column(page)
      .locator('li.pe__row')
      .filter({ has: page.locator(`.pe__name:text-is(${JSON.stringify(name)})`) });

  async function openEditor(page: Page) {
    const res = await page.goto(`/admin/pages/${aboutId}`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
    await expect(column(page).locator('li.pe__row[aria-current="true"]')).toHaveCount(1);
  }

  async function openSection(page: Page, name: string) {
    await rowOf(page, name).locator('button.pe__pick').click();
    await expect(rowOf(page, name)).toHaveAttribute('aria-current', 'true');
    return page.getByRole('region', { name });
  }

  test('Add section offers the three blocks on About, even beside one of each', async ({
    page,
  }) => {
    await openEditor(page);
    await column(page).getByRole('button', { name: 'Add section' }).click();
    const library = page.getByRole('dialog', { name: 'Add a section' });
    for (const name of ['Text block', 'Gallery', 'Video']) {
      const option = library.getByRole('button', { name, exact: true });
      await expect(option, name).toBeVisible();
      await expect(option, name).not.toHaveAttribute('aria-disabled', 'true');
    }
    await page.keyboard.press('Escape');
    await expect(library).toBeHidden();
  });

  test('each block’s fields, and a heading saved', async ({ page }) => {
    // Every width check at 1280 px also runs axe over the public page in the preview frame.
    test.slow();
    await openEditor(page);

    const textPanel = await openSection(page, 'Text block');
    await expect(textPanel).toContainText('Section type: Text block');
    await expect(page.locator('#f-content-heading-en')).toHaveValue(TEXT_BLOCK.heading.en);
    // The body's editor is the lazy rich-text chunk: it arrives with the stored words.
    await expect(page.locator('#f-content-body-en')).toContainText('An English paragraph with', {
      timeout: 15_000,
    });
    await expectCleanAtWidths(page, 'the Text block panel');

    const heading = page.locator('#f-content-heading-en');
    await heading.fill(`Saved words ${MARK}`);
    const saved = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/admin/sections/${ids.textBlock}` &&
        r.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.locator('.save-status[data-state="saved"]')).toBeVisible();
    const { data, error } = await service()
      .from('page_sections')
      .select('content')
      .eq('id', ids.textBlock)
      .single();
    expect(error).toBeNull();
    const stored = (data as { content: Record<string, unknown> }).content;
    expect(stored['heading']).toEqual({ en: `Saved words ${MARK}`, ar: TEXT_BLOCK.heading.ar });
    // The body went back as it was loaded: the editor did not rewrite it.
    expect(stored['body']).toEqual(TEXT_BLOCK.body);

    const galleryPanel = await openSection(page, 'Gallery');
    await expect(galleryPanel).toContainText('Section type: Gallery');
    await expect(page.getByRole('list', { name: 'Pictures' }).locator('li')).toHaveCount(3);
    await expect(galleryPanel.getByRole('link', { name: /Media library/ })).toBeVisible();

    const videoPanel = await openSection(page, 'Video');
    await expect(videoPanel).toContainText('Section type: Video');
    await expect(page.locator('#f-content-clip-path')).toHaveValue('/media/showreel.mp4');
    await expect(
      page.locator('#f-content-mediaId').getByRole('button', { name: 'Change…' }),
    ).toBeVisible();
    await expectCleanAtWidths(page, 'the Video panel');
  });
});
