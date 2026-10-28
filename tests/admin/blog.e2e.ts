import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { TENANT_ID } from '../../scripts/gen-seeds.mjs';
import { RELEASES_OFF_ONLY, SKIP_REASON, authFile, releasesOn, staffEnv } from './staff';

/*
 * The tabbed and read-only post editor (Admin v2 U8b), signed in, through the real Worker:
 *   admin    a post made on the Content tab; published from Publishing with no author, the
 *            server refuses and the error's link switches to Content and focuses Author (the
 *            tab said "has errors"); a published author picked, it publishes, the cue clears
 *            and "Open on site" opens the page; a draft author is refused on the author field
 *            (the API: the picker offers published members only); every tab clean at 320,
 *            390 and 1280 (axe, no sideways scroll, no CSP violation);
 *   seo      the post opens on its SEO tab, the content is read-only (a disabled fieldset,
 *            no Save, the note), the list offers no "New post", and the SEO tab saves; the
 *            server refuses its edit of the post and its new post (403 `forbidden`);
 *   cc       the SEO tab is view-only, and the server refuses its SEO save (403).
 * The refusals are sent by hand with the layout's CSRF token and the page's origin, so the
 * capability is the only thing left to refuse them (CLAUDE.md §9: a server 403, not just a
 * hidden button; tests/admin/refusals.e2e.ts does the same for services).
 * The whole file runs in order, in one worker. The post is NOT deleted afterwards (the sweep
 * opens the first row of the posts list, and a post removed between its list and its open
 * would 404 there; the CI database is per run): it is archived instead, off the public site.
 * The draft team member sorts last (the sweep's team row is the first) and is removed.
 */

const env = staffEnv();
test.skip(!env, SKIP_REASON);
// The release-mode rehearsal (Admin v2 R14-prep): written for releases off.
test.skip(releasesOn(), RELEASES_OFF_ONLY);
test.describe.configure({ mode: 'serial' });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const RUN = Date.now().toString(36);
const SLUG = `e2e-ck-${RUN}`;
const TITLE = { en: `Colour notes ${RUN}`, ar: 'ملاحظات عن اللون' };
const DRAFT_AUTHOR = '0e2e0000-0000-4000-8000-0000000000b8';

let postId = '';

function service(): SupabaseClient {
  return createClient(env!.url, env!.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function ready(page: Page) {
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await page.waitForLoadState('networkidle');
}

async function axeClean(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    where,
  ).toEqual([]);
}

/**
 * No sideways scroll. A failure names its cause: the outermost elements that reach past the
 * right edge while their parent's box does not (the box that grew, or the content that spilled
 * out of a box that fits), each with its ancestor chain (box right, display, overflow), so one
 * CI run says what to fix.
 */
async function noSidewaysScroll(page: Page, where: string) {
  const { over, causes } = await page.evaluate(() => {
    const root = document.documentElement;
    const edge = root.clientWidth + 0.5;
    const name = (el: Element) => {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/) : [];
      const tag = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '');
      return (
        tag +
        cls
          .filter(Boolean)
          .map((c) => `.${c}`)
          .join('')
      );
    };
    const reach = (el: HTMLElement) => {
      const box = el.getBoundingClientRect();
      return Math.max(box.right, box.left + el.scrollWidth);
    };
    const describe = (el: HTMLElement) => {
      const s = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return `${name(el)}[w=${Math.round(box.width)} right=${Math.round(box.right)} ${s.display} ${s.position} ox=${s.overflowX} minw=${s.minWidth}]`;
    };
    const shown = [...document.querySelectorAll<HTMLElement>('body *')].filter(
      (el) => el.getClientRects().length > 0,
    );
    const causes = shown
      .filter((el) => {
        const right = el.getBoundingClientRect().right;
        const parent = el.parentElement;
        // A box that crosses the edge inside a parent that fits: the box that grew.
        if (right > edge) return !parent || parent.getBoundingClientRect().right <= edge;
        // A box that fits but whose own text spills (no child element crosses the edge).
        return (
          reach(el) > edge &&
          ![...el.children].some((c) => c instanceof HTMLElement && reach(c) > edge)
        );
      })
      .slice(0, 4)
      .map((el) => {
        const chain: string[] = [];
        for (
          let p = el.parentElement;
          p && p !== document.body && chain.length < 8;
          p = p.parentElement
        ) {
          chain.push(describe(p));
        }
        return `${describe(el)} reach=${Math.round(reach(el))} in ${chain.join(' < ')}`;
      });
    return { over: root.scrollWidth - root.clientWidth, causes };
  });
  expect(
    over,
    `${where}: sideways scroll; caused by: ${causes.join(' | ') || 'none found'}`,
  ).toBeLessThanOrEqual(0);
}

async function watchCsp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      w.__csp.push(`${event.violatedDirective} ${event.blockedURI || 'inline'}`);
    });
  });
}

/** A hand-made mutation's CSRF double-submit token and origin, from the admin layout. */
async function writeHeaders(page: Page): Promise<Record<string, string>> {
  const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  expect(token, 'the admin layout carries a CSRF token').toBeTruthy();
  return { 'x-csrf-token': token!, origin: new URL(page.url()).origin };
}

/** The post's stored version and excerpt, read as the service role. */
async function stored(): Promise<{ version: number; excerpt: unknown }> {
  const { data, error } = await service()
    .from('blog_posts')
    .select('version,excerpt')
    .eq('id', postId)
    .single();
  expect(error, error?.message).toBeNull();
  return data as { version: number; excerpt: unknown };
}

/**
 * A tab of the post editor by its whole computed name: a string matches exactly, so "Content"
 * is the Content tab with no cue, and "Content, has errors" the one with it (Chromium's name,
 * not the markup: a hidden span once computed to "Content , has errors" and matched nothing).
 */
const tab = (page: Page, name: string | RegExp) =>
  page
    .getByRole('tablist', { name: 'Post editor' })
    .getByRole('tab', typeof name === 'string' ? { name, exact: true } : { name });

test.beforeAll(async () => {
  const { error } = await service()
    .from('team_members')
    .upsert(
      {
        id: DRAFT_AUTHOR,
        tenant_id: TENANT_ID,
        slug: `e2e-draft-author-${RUN}`,
        name: { en: 'Draft Author', ar: 'كاتب مسودة' },
        status: 'draft',
        sort_order: 99999,
      },
      { onConflict: 'id' },
    );
  expect(error, error?.message).toBeNull();
});

test.afterAll(async () => {
  const svc = service();
  if (postId) await svc.from('blog_posts').update({ status: 'archived' }).eq('id', postId);
  await svc.from('team_members').delete().eq('id', DRAFT_AUTHOR);
});

test.describe('as Admin', () => {
  test.use({ storageState: authFile('admin'), contextOptions: { reducedMotion: 'reduce' } });

  test('a post made on the Content tab', async ({ page }) => {
    await page.goto('/admin/blog/new');
    await ready(page);
    await expect(page.getByRole('heading', { level: 1, name: 'New post' })).toBeVisible();
    await expect(tab(page, 'Content')).toHaveAttribute('aria-selected', 'true');
    await tab(page, 'SEO').click();
    await expect(
      page.getByText('Save the post first. Its SEO can be added once it exists.'),
    ).toBeVisible();
    await expect(page).toHaveURL(/[?&]tab=seo\b/);
    await tab(page, 'Content').click();
    await page.getByRole('radio', { name: 'Both' }).check();
    await page.locator('#f-title-en').fill(TITLE.en);
    await page.locator('#f-title-ar').fill(TITLE.ar);
    await page.locator('#f-slug').fill(SLUG);
    await page.getByRole('button', { name: 'Create post' }).click();
    await page.waitForURL(/\/admin\/blog\/[0-9a-f-]{36}/);
    postId = /\/admin\/blog\/([0-9a-f-]{36})/.exec(page.url())![1]!;
    await ready(page);
  });

  test('publishing without an author: the error switches to Content and focuses Author', async ({
    page,
  }) => {
    await page.goto(`/admin/blog/${postId}?tab=publishing`);
    await ready(page);
    await expect(tab(page, 'Publishing')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#f-status').selectOption('published');
    await page.getByRole('button', { name: 'Save changes' }).click();
    const summary = page.locator('.error-summary');
    await expect(summary).toBeVisible();
    await expect(tab(page, 'Content, has errors')).toBeVisible();
    await summary.getByRole('link').first().click();
    await expect(tab(page, /^Content/)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#f-authorId')).toBeFocused();
    await expect(page).toHaveURL(/[?&]tab=content\b/);
  });

  test('a published author: it publishes, the cue clears, and Open on site opens it', async ({
    page,
  }) => {
    await page.goto(`/admin/blog/${postId}`);
    await ready(page);
    const author = page.locator('#f-authorId');
    await expect(author).toBeEnabled();
    expect(await author.locator('option', { hasText: 'Draft Author' }).count()).toBe(0);
    await author.selectOption({ index: 1 });
    await tab(page, 'Publishing').click();
    await page.locator('#f-status').selectOption('published');
    // Chosen, not saved: the page does not exist yet, so nothing links to it.
    await expect(page.getByRole('link', { name: 'Open on site' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.save-status')).toContainText(/Saved/);
    await expect(tab(page, 'Content')).toBeVisible();
    await expect(tab(page, /has errors/)).toHaveCount(0);
    const open = page.getByRole('link', { name: 'Open on site' });
    await expect(open).toHaveAttribute('href', `/creative-knowledge/${SLUG}`);
    const res = await page.request.get(`/creative-knowledge/${SLUG}`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain(TITLE.en);
  });

  test('a draft author is refused on the author field', async ({ page }) => {
    await page.goto(`/admin/blog/${postId}`);
    await ready(page);
    const token = await page.locator('meta[name="csrf-token"]').getAttribute('content');
    const current = await page.request.get(`/api/admin/blog/${postId}`);
    const { data } = (await current.json()) as { data: { version: number } };
    const res = await page.request.patch(`/api/admin/blog/${postId}`, {
      headers: { 'x-csrf-token': token!, origin: new URL(page.url()).origin },
      data: { authorId: DRAFT_AUTHOR, version: data.version },
    });
    expect(res.status()).toBe(422);
    expect(await res.json()).toMatchObject({
      ok: false,
      field: 'authorId',
      detail: 'the author must be a published team member',
    });
  });

  for (const width of [320, 390, 1280]) {
    test(`every tab clean at ${width}px`, async ({ page }) => {
      await watchCsp(page);
      await page.setViewportSize({ width, height: 900 });
      for (const id of ['content', 'seo', 'publishing']) {
        await page.goto(`/admin/blog/${postId}?tab=${id}`);
        await ready(page);
        await expect(page.locator(`[data-editor-tab="${id}"]`)).toBeVisible();
        await axeClean(page, `admin ${id} ${width}`);
        await noSidewaysScroll(page, `admin ${id} ${width}`);
      }
      expect(
        await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []),
      ).toEqual([]);
    });
  }
});

test.describe('as SEO', () => {
  test.use({ storageState: authFile('seo'), contextOptions: { reducedMotion: 'reduce' } });

  test('no New post on the list', async ({ page }) => {
    await page.goto('/admin/blog');
    await ready(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Creative Knowledge' })).toBeVisible();
    await expect(page.getByRole('link', { name: /New post/ })).toHaveCount(0);
  });

  for (const width of [320, 390, 1280]) {
    test(`the post opens on SEO, its content read-only, at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/admin/blog/${postId}`);
      await ready(page);
      await expect(tab(page, 'SEO')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('button', { name: 'Save SEO' })).toBeVisible();
      await axeClean(page, `seo seo ${width}`);
      await noSidewaysScroll(page, `seo seo ${width}`);
      await tab(page, 'Content').click();
      await expect(page.locator('fieldset.editor-ro')).toHaveAttribute('disabled', '');
      await expect(
        page.getByText('You can read this post. Your role changes its SEO only.'),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
      await expect(page.locator('#f-title-en')).toBeDisabled();
      await axeClean(page, `seo content ${width}`);
      await noSidewaysScroll(page, `seo content ${width}`);
    });
  }

  test('the server refuses SEO an edit of the post and a new post', async ({ page }) => {
    await page.goto(`/admin/blog/${postId}`);
    await ready(page);
    const headers = await writeHeaders(page);
    const before = await stored();
    const edit = await page.request.patch(`/api/admin/blog/${postId}`, {
      headers,
      data: { excerpt: { en: 'Refused', ar: 'مرفوض' }, version: before.version },
    });
    expect(edit.status(), 'PATCH /api/admin/blog/[id] as seo').toBe(403);
    expect(await edit.json()).toMatchObject({ ok: false, error: 'forbidden' });
    const slug = `e2e-refused-${RUN}`;
    const create = await page.request.post('/api/admin/blog', {
      headers,
      data: { slug, title: { en: 'Refused', ar: 'مرفوض' }, status: 'draft' },
    });
    expect(create.status(), 'POST /api/admin/blog as seo').toBe(403);
    expect(await create.json()).toMatchObject({ ok: false, error: 'forbidden' });
    // Nothing changed, nothing was made.
    expect(await stored()).toEqual(before);
    const { data: made } = await service().from('blog_posts').select('id').eq('slug', slug);
    expect(made).toEqual([]);
  });

  test('the SEO tab saves', async ({ page }) => {
    await page.goto(`/admin/blog/${postId}?tab=seo`);
    await ready(page);
    const seo = page.locator('[data-editor-tab="seo"]');
    await seo.getByRole('radio', { name: 'Both' }).check();
    await seo.locator('#f-metaTitle-en').fill(`Colour notes ${RUN} | Search`);
    await seo.locator('#f-metaTitle-ar').fill('ملاحظات اللون');
    await seo.getByRole('button', { name: 'Save SEO' }).click();
    await expect(seo.locator('.save-status')).toContainText(/Saved/);
  });
});

test.describe('as Content Creator', () => {
  test.use({
    storageState: authFile('content_creator'),
    contextOptions: { reducedMotion: 'reduce' },
  });

  test('writes the post, and only views its SEO', async ({ page }) => {
    await page.goto(`/admin/blog/${postId}?tab=seo`);
    await ready(page);
    await expect(tab(page, 'SEO')).toHaveAttribute('aria-selected', 'true');
    const seo = page.locator('[data-editor-tab="seo"]');
    await expect(seo.getByText('Only Admin and SEO change these.')).toBeVisible();
    await expect(seo.getByRole('button', { name: 'Save SEO' })).toHaveCount(0);
    await tab(page, 'Content').click();
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
    await axeClean(page, 'cc content');
  });

  test('the server refuses a Content Creator’s SEO save', async ({ page }) => {
    await page.goto(`/admin/blog/${postId}?tab=seo`);
    await ready(page);
    const read = await page.request.get(
      `/api/admin/entity-seo?entityType=blog_post&entityId=${postId}`,
    );
    expect(read.status(), 'GET /api/admin/entity-seo as content_creator (view)').toBe(200);
    const before = ((await read.json()) as { data: Record<string, unknown> }).data;
    const res = await page.request.put('/api/admin/entity-seo', {
      headers: await writeHeaders(page),
      data: {
        entityType: 'blog_post',
        entityId: postId,
        metaTitle: { en: 'Refused', ar: 'مرفوض' },
        version: Number(before['version'] ?? 0),
      },
    });
    expect(res.status(), 'PUT /api/admin/entity-seo as content_creator').toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'forbidden' });
    const after = await page.request.get(
      `/api/admin/entity-seo?entityType=blog_post&entityId=${postId}`,
    );
    expect(((await after.json()) as { data: Record<string, unknown> }).data).toEqual(before);
  });
});
