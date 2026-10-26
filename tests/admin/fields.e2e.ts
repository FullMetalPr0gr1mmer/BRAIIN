import { expect, test, type Page } from '@playwright/test';
import type { Role } from '@/lib/auth/types';
import { SECTION_UI } from '@/lib/admin/sectionUi';
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

test.describe('as admin, a number the browser cannot read (review M2)', () => {
  test.use({ storageState: authFile('admin') });

  test('refuses the save and says so, instead of clearing the stored value', async ({ page }) => {
    // Its own service: nothing here may save, and if it did it would race no other test.
    const id = await serviceId(page, 'brand-guidelines');
    await openEditor(page, id);
    // The service editor is tabbed since U5: the order is on the Publishing tab.
    await page
      .getByRole('tablist', { name: 'Service editor' })
      .getByRole('tab', { name: 'Publishing', exact: true })
      .click();
    const sort = page.locator('#f-sortOrder');
    await expect(sort).toBeVisible();
    const before = await sort.inputValue();
    // The row's version, as the actions bar shows it: it must not move, since nothing saves.
    const versionOf = (text: string | null) => /Version \d+/.exec(text ?? '')?.[0] ?? null;
    const version = versionOf(await page.locator('form.editor .form-actions').textContent());
    expect(version).not.toBeNull();
    let sent = false;
    page.on('request', (request) => {
      if (request.method() === 'PATCH') sent = true;
    });
    await sort.fill('');
    await sort.pressSequentially('1e');
    expect(await sort.evaluate((el) => (el as HTMLInputElement).validity.badInput)).toBe(true);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    const summary = page.getByRole('alert', { name: 'Fix 1 problem to save' });
    await expect(summary).toBeFocused();
    await expect(summary).toContainText('Sort order: Enter a number, or clear the box.');
    await expect(sort).toHaveAttribute('aria-invalid', 'true');
    expect(sent).toBe(false);
    // The edit is still there (Unsaved changes), and the stored row did not move.
    await expect(page.locator('form.editor .form-actions')).toContainText('Unsaved changes');
    expect(versionOf(await page.locator('form.editor .form-actions').textContent())).toBe(version);
    // Put back, the box reads again (the stored value was never touched).
    await sort.fill(before);
    expect(await sort.evaluate((el) => (el as HTMLInputElement).validity.badInput)).toBe(false);
  });
});

test.describe('as admin, Ctrl+S on a page with two editors (review L8)', () => {
  test.use({ storageState: authFile('admin') });

  test('with focus in neither form, saves neither', async ({ page }) => {
    await page.goto('/admin/settings', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
    await expect(page.locator('form.editor')).toHaveCount(2);
    let sent = 0;
    page.on('request', (request) => {
      if (request.method() === 'PATCH') sent += 1;
    });
    await page.locator('h1').first().click();
    await page.keyboard.press('Control+s');
    // Nothing to wait for but time: a save would have gone at once.
    await page.waitForTimeout(500);
    expect(sent).toBe(0);
  });
});

/*
 * The rest of the field kit on a real editor (Admin v2 F5b): a seeded page section, whose
 * content the typed editor draws. Nothing is saved here — these rows are the public
 * pages', and the other suites read them — so every check is a read.
 *
 *   accent     the word pickers are there, counting the words of the heading beside them;
 *   advanced   "Advanced (JSON)" is an Admin's (decision D5): a Content Creator editing
 *              the same section is offered the typed fields and not the JSON box.
 */

/**
 * The section types whose content carries an accent over a field called `heading`, so the
 * element ids below are the same whichever seeded section this finds (the hero's accent is
 * two numbers under its own name, over `headline`: its own case, unit-tested).
 */
const ACCENT_TYPES = Object.entries(SECTION_UI)
  .filter(([, fields]) =>
    (fields ?? []).some(
      (f) => f.kind === 'accent' && f.name === 'accent' && f.accent?.of === 'heading',
    ),
  )
  .map(([type]) => type);

interface AccentSection {
  id: string;
  type: string;
  /** The stored English heading, '' when the section keeps the built-in one. */
  heading: string;
}

/**
 * A seeded section of an ACCENT_TYPES type, chosen deterministically (F5b review M2): the
 * first, by type then id, whose stored content has an English heading, because only a
 * heading gives the field words to pick from. Without one the field shows its cue, so the
 * fallback is a section storing neither a heading nor an accent; null when there is none.
 */
async function accentSection(page: Page): Promise<AccentSection | null> {
  const res = await page.request.get('/api/admin/sections?limit=100');
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { data?: { rows?: unknown[] }; rows?: unknown[] };
  const rows = ((body.data?.rows ?? body.rows ?? []) as { id: string; type: string }[])
    .filter((row) => ACCENT_TYPES.includes(row.type))
    .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  let bare: AccentSection | null = null;
  for (const row of rows) {
    const detail = await page.request.get(`/api/admin/sections/${row.id}`);
    expect(detail.status(), await detail.text()).toBe(200);
    type Row = { content?: { heading?: { en?: unknown }; accent?: unknown } | null };
    const json = (await detail.json()) as Row & { data?: Row };
    const content = (json.data ?? json).content ?? {};
    const heading = typeof content.heading?.en === 'string' ? content.heading.en.trim() : '';
    if (heading !== '') return { ...row, heading };
    if (bare === null && content.accent === undefined) bare = { ...row, heading: '' };
  }
  return bare;
}

async function openSection(page: Page, id: string) {
  await page.goto(`/admin/sections/${id}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  await expect(page.locator('#f-content')).toBeVisible();
}

for (const role of ['admin', 'content_creator'] as const satisfies readonly Role[]) {
  test.describe(`a page section as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('the accent is word pickers, and "Advanced (JSON)" is the Admin’s', async ({ page }) => {
      const section = await accentSection(page);
      test.skip(section === null, 'no seeded section of a type that carries an accent');
      await openSection(page, section!.id);

      // The accent is picked by word, never written as HTML (Pillar 1).
      const from = page.locator('#f-content-accent-en-from');
      if (section!.heading !== '') {
        await expect(page.locator('#f-content-heading-en')).toHaveValue(section!.heading);
        await expect(from).toBeVisible();
        await expect(from.locator('option').first()).toHaveText('No highlight');
        // Its words are the heading's own: the first option after "No highlight" is word 1.
        const first = section!.heading.split(/\s+/)[0];
        await expect(from.locator('option').nth(1)).toHaveText(`1. ${first}`);
      } else {
        // No words to pick from yet: the field says what to do instead of a picker.
        await expect(page.getByText('Write the English words first')).toBeVisible();
        await expect(from).toHaveCount(0);
      }

      const advanced = page.getByText('Advanced (JSON)', { exact: true });
      if (role === 'admin') {
        await expect(advanced).toBeVisible();
      } else {
        await expect(advanced).toHaveCount(0);
        // ...and the typed fields are there instead, so nothing is out of reach.
        await expect(page.locator('#f-content-heading-en')).toBeVisible();
      }
    });
  });
}
