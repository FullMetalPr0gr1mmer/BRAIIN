import { expect, test, type Page } from '@playwright/test';
import type { Role } from '@/lib/auth/types';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * The field kit v2 on a real editor (Admin v2 F5a), signed in, against this job's local
 * Supabase: a seeded service's edit screen (/admin/services/[id]), saved through
 * useEntitySave and EditorForm.
 *
 *   digits    an Arabic title holding both Arabic digit sets (U+0660-0669, U+06F0-06F9)
 *             saves, reloads and reads back unchanged, as each role that edits services
 *             (P-12: Arabic content digits are never transformed; the layers between are
 *             unit-tested in tests/lib/arabicDigits.spec.ts and tests/render/);
 *   conflict  two tabs on one service: the first saves, the second's save is a 409 that
 *             keeps its form and offers "Reload their version", which loads theirs.
 *   create    a new category opens its edit screen with no "Leave site?" prompt (the
 *             form is clean once the row exists), and is deleted again.
 *
 * Each role works on its own service and the conflict on a third, so the parallel workers
 * never race each other's versions. The title is put back afterwards (the public pages and
 * the other suites read these rows); the conflict saves change nothing but the version.
 * The kit's own pieces are driven on /admin/kit (kit.e2e.ts).
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const DIGITS = '٠١٢٣٤ ۵۶۷۸۹';

/** A service each role edits alone; the conflict test's own. */
const SERVICE: Record<'admin' | 'content_creator' | 'conflict', string> = {
  admin: 'letterhead',
  content_creator: 'stationery',
  conflict: 'packaging',
};

async function serviceId(page: Page, slug: string): Promise<string> {
  const res = await page.request.get('/api/admin/services?limit=100');
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { data?: { rows?: unknown[] }; rows?: unknown[] };
  const rows = (body.data?.rows ?? body.rows ?? []) as { id: string; slug: string }[];
  const row = rows.find((r) => r.slug === slug);
  expect(row, `the seeded service "${slug}"`).toBeTruthy();
  return row!.id;
}

/** Opens a service's editor and waits for its row to be in the form. */
async function openEditor(page: Page, id: string) {
  await page.goto(`/admin/services/${id}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await expect(page.locator('#f-title-en')).toHaveValue(/\S/);
}

const saveStatus = (page: Page) => page.locator('form.editor .save-status');

async function saveAndWait(page: Page) {
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(saveStatus(page)).toHaveText(/^Saved/);
}

/** Shows both languages, so the Arabic input can be typed in. */
async function showBoth(page: Page) {
  await page
    .getByRole('group', { name: 'Editing language' })
    .getByRole('radio', { name: 'Both' })
    .check();
  await expect(page.locator('#f-title-ar')).toBeVisible();
}

for (const role of ['admin', 'content_creator'] as const satisfies readonly Role[]) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('an Arabic title with both digit sets saves and reads back unchanged', async ({
      page,
    }) => {
      // A dirty form asks before the page goes (beforeunload): accepted, so a failed run
      // can still reload and put the title back.
      page.on('dialog', (dialog) => void dialog.accept());
      const id = await serviceId(page, SERVICE[role]);
      await openEditor(page, id);
      await showBoth(page);
      const ar = page.locator('#f-title-ar');
      const original = await ar.inputValue();
      const withDigits = `${original} ${DIGITS}`;
      try {
        await ar.fill(withDigits);
        await saveAndWait(page);
        await expect(ar).toHaveValue(withDigits);

        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
        await expect(page.locator('#f-title-ar')).toHaveValue(withDigits);

        // The API answers the same code points (no folding, no Western digits).
        const res = await page.request.get(`/api/admin/services/${id}`);
        type Row = { title?: { ar?: string } };
        const body = (await res.json()) as Row & { data?: Row };
        const stored = (body.data ?? body).title?.ar ?? '';
        expect([...stored].map((c) => c.codePointAt(0))).toEqual(
          [...withDigits].map((c) => c.codePointAt(0)),
        );
      } finally {
        await openEditor(page, id);
        await showBoth(page);
        if ((await page.locator('#f-title-ar').inputValue()) !== original) {
          await page.locator('#f-title-ar').fill(original);
          await saveAndWait(page);
        }
      }
    });
  });
}

test.describe('as admin, two tabs on one service', () => {
  test.use({ storageState: authFile('admin') });

  test('the second save is a 409: the form is kept and "Reload their version" loads theirs', async ({
    page,
    context,
  }) => {
    const id = await serviceId(page, SERVICE.conflict);
    const second = await context.newPage();
    await openEditor(page, id);
    await openEditor(second, id);
    const version = async (p: Page) =>
      Number(
        (await p.locator('form.editor .form-actions').textContent())?.match(/Version (\d+)/)?.[1],
      );
    const before = await version(page);
    expect(before).toBeGreaterThan(0);

    await saveAndWait(page);
    await expect(page.locator('form.editor .form-actions')).toContainText(`Version ${before + 1}`);

    await second.getByRole('button', { name: 'Save changes', exact: true }).click();
    const banner = second.getByRole('alert').filter({
      hasText: 'Someone else saved changes while you were editing.',
    });
    await expect(banner).toBeVisible();
    await expect(saveStatus(second)).toHaveText('Not saved');
    // Nothing the editor typed is thrown away by the refusal: still version `before`.
    await expect(second.locator('form.editor .form-actions')).toContainText(`Version ${before}`);

    await banner.getByRole('button', { name: 'Reload their version' }).click();
    await expect(banner).toHaveCount(0);
    await expect(second.locator('form.editor .form-actions')).toContainText(
      `Version ${before + 1}`,
    );
    // And now it saves.
    await saveAndWait(second);
    await expect(second.locator('form.editor .form-actions')).toContainText(
      `Version ${before + 2}`,
    );
  });
});

test.describe('as admin, a create (review H1)', () => {
  test.use({ storageState: authFile('admin') });

  test('opens the new record without a "Leave site?" prompt', async ({ page }) => {
    // Any dialog fails the test: the create used to leave with the unsaved-changes guard
    // still attached, so the browser asked, and "Stay" left a form that could not save.
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss();
    });
    await page.goto('/admin/categories/new', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
    // Sorts after every seeded category, so the sweep's "first row" edit screen never
    // opens the one this test makes and deletes.
    const slug = `zz-e2e-create-${Date.now().toString(36)}`;
    await page.locator('#f-slug').fill(slug);
    await page.locator('#f-name-en').fill('E2E category');
    await page
      .getByRole('group', { name: 'Editing language' })
      .getByRole('radio', { name: 'Both' })
      .check();
    await page.locator('#f-name-ar').fill('فئة الاختبار');
    let id = '';
    try {
      await Promise.all([
        page.waitForURL(/\/admin\/categories\/[0-9a-f-]{36}$/),
        page.getByRole('button', { name: 'Create category', exact: true }).click(),
      ]);
      id = page.url().split('/').pop() ?? '';
      expect(dialogs).toEqual([]);
      await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
      await expect(page.locator('#f-slug')).toHaveValue(slug);
    } finally {
      if (!id) {
        const res = await page.request.get('/api/admin/categories?limit=100');
        const body = (await res.json()) as { data?: { rows?: { id: string; slug: string }[] } };
        id = body.data?.rows?.find((r) => r.slug === slug)?.id ?? '';
      }
      if (id) {
        const csrf = await page.locator('meta[name="csrf-token"]').getAttribute('content');
        const res = await page.request.delete(`/api/admin/categories/${id}`, {
          headers: { 'x-csrf-token': csrf ?? '', origin: new URL(page.url()).origin },
        });
        expect(res.status(), await res.text()).toBeLessThan(300);
      }
    }
  });
});
