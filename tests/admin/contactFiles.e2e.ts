import AxeBuilder from '@axe-core/playwright';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { SKIP_REASON, authFile, staffEnv } from './staff';

/*
 * Contact files, end to end (Admin v2 C16, crm.md §12), on the real Worker and the local stack
 * (its Storage included), as the Admin and, for the refusals, as Content Creator, SEO,
 * Developer and Sales, none of whom holds crm.files:
 *   the card     on a contact's page: "No files yet.", a PDF added through the file input with
 *                its name, said in the live region; axe with the list drawn;
 *   the download a plain link: an attachment with nosniff and a sandbox CSP, under the
 *                name's ASCII slug, never rendered;
 *   a refusal    a file whose bytes are not one of the five kinds (an SVG) is refused in words,
 *                whatever its name says;
 *   the removal  after the confirm, the card says "No files yet." and the download is a 404;
 *   erasure      a person erased takes their file: the preview counts it, the erasure answers
 *                it, and its download is a 404 after;
 *   refusals     every other role gets a 403 from every file route.
 * Every contact it adds is named with this run's token and added through the real routes;
 * nothing reads or writes the database or the bucket directly.
 */

test.skip(!staffEnv(), SKIP_REASON);
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const RUN = randomBytes(4).toString('hex');
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id} [${v.impact ?? 'n/a'}] ${v.nodes.length}x: ${v.help}`),
    `axe on ${label}`,
  ).toEqual([]);
}

/** The double-submit token the admin's own fetches send (the `__Host-csrf` cookie). */
async function csrf(page: Page): Promise<string> {
  const find = async () =>
    (await page.context().cookies()).find((c) => c.name === '__Host-csrf')?.value ?? '';
  if (!(await find())) await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  return find();
}

/** Opens an admin page and waits until every island has hydrated (as contacts.e2e.ts does). */
async function visit(page: Page, path: string) {
  const res = await page.goto(path);
  await page.waitForFunction(() => document.querySelector('astro-island[ssr]') === null);
  return res;
}

/** A contact added by hand through the real route (no e-mail or phone: none is needed). */
async function addContact(page: Page, label: string): Promise<{ id: string; name: string }> {
  const name = `E2E ${RUN} files ${label}`;
  const res = await page.request.post('/api/admin/crm/contacts', {
    headers: { 'x-csrf-token': await csrf(page) },
    data: { displayName: name },
  });
  expect(res.status(), `add ${label}`).toBe(200);
  const { data } = (await res.json()) as { data: { id: string } };
  return { id: data.id, name };
}

/** A file added through the real upload route (multipart, the CSRF header). */
async function addFile(page: Page, contactId: string, name: string): Promise<string> {
  const res = await page.request.post(`/api/admin/crm/contacts/${contactId}/files`, {
    headers: { 'x-csrf-token': await csrf(page) },
    multipart: {
      name,
      file: { name: 'anything.bin', mimeType: 'application/octet-stream', buffer: PDF },
    },
  });
  expect(res.status(), `upload ${name}`).toBe(200);
  return ((await res.json()) as { data: { file: { id: string } } }).data.file.id;
}

test.describe('as admin', () => {
  test.use({ storageState: authFile('admin') });

  test('a file added, downloaded as an attachment, refused when its bytes are not one, removed', async ({
    page,
  }) => {
    const person = await addContact(page, 'card');
    await visit(page, `/admin/contacts/${person.id}`);
    const card = page.locator('section.card', {
      has: page.getByRole('heading', { level: 2, name: 'Files', exact: true }),
    });
    await expect(card.getByText('No files yet.')).toBeVisible();
    await expect(
      card.getByText('Files are not virus-scanned. Open them in an up-to-date app.'),
    ).toBeVisible();

    // Add: the name starts from the file's own; the server decides the kind by the bytes.
    await card.getByLabel('Add a file').setInputFiles({
      name: 'Brief.pdf',
      mimeType: 'application/pdf',
      buffer: PDF,
    });
    await expect(card.getByLabel('Name', { exact: true })).toHaveValue('Brief.pdf');
    await card.getByRole('button', { name: 'Add file', exact: true }).click();
    await expect(card.getByRole('status')).toHaveText('File added.');
    const item = card.getByRole('listitem').filter({ hasText: 'Brief.pdf' });
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('PDF');
    await expect(item.getByText('Not virus-scanned')).toBeVisible();
    await axe(page, 'a contact with a file');

    // The download: a plain link, answered as an attachment no browser renders.
    const link = item.getByRole('link', { name: 'Download Brief.pdf' });
    const href = await link.getAttribute('href');
    expect(href).toMatch(new RegExp(`^/api/admin/crm/contacts/${person.id}/files/[0-9a-f-]{36}$`));
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toBe('Brief.pdf');
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/pdf');
    expect(res.headers()['content-disposition']).toBe('attachment; filename="Brief.pdf"');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['content-security-policy']).toContain('sandbox');
    expect(res.headers()['cache-control']).toContain('no-store');
    expect((await res.body()).toString()).toBe(PDF.toString());

    // An SVG named as a PDF: refused by its bytes, said in words, nothing added.
    await card.getByLabel('Add a file').setInputFiles({
      name: 'logo.pdf',
      mimeType: 'application/pdf',
      buffer: SVG,
    });
    await card.getByRole('button', { name: 'Add file', exact: true }).click();
    await expect(
      card.getByText('Add a PDF, a Word document (.docx) or a PNG, JPEG or WebP image.'),
    ).toBeVisible();
    await expect(card.getByRole('listitem')).toHaveCount(1);

    // Remove: asked first; then gone, and its download is a 404.
    await item.getByRole('button', { name: 'Remove Brief.pdf' }).click();
    const sure = page.getByRole('dialog', { name: 'Remove Brief.pdf? It cannot be brought back.' });
    await sure.getByRole('button', { name: 'Remove file', exact: true }).click();
    await expect(card.getByRole('status')).toHaveText('File removed.');
    await expect(card.getByText('No files yet.')).toBeVisible();
    expect((await page.request.get(href!)).status()).toBe(404);
  });

  test('erasing a person takes their file: counted in the preview, gone after', async ({
    page,
  }) => {
    const person = await addContact(page, 'erase');
    const fileId = await addFile(page, person.id, 'Contract.pdf');
    const download = `/api/admin/crm/contacts/${person.id}/files/${fileId}`;
    expect((await page.request.get(download)).status()).toBe(200);

    const token = await csrf(page);
    const preview = await page.request.post(`/api/admin/crm/contacts/${person.id}/erase-preview`, {
      headers: { 'x-csrf-token': token },
    });
    expect(preview.status()).toBe(200);
    const counted = (await preview.json()) as { data: { counts: { files: number } } };
    expect(counted.data.counts.files).toBe(1);

    const erased = await page.request.post(`/api/admin/crm/contacts/${person.id}/erase`, {
      headers: { 'x-csrf-token': token },
      data: { reason: 'dsar' },
    });
    expect(erased.status()).toBe(200);
    const answer = (await erased.json()) as { data: { counts: { files: number } } };
    expect(answer.data.counts.files).toBe(1);
    expect((await page.request.get(download)).status()).toBe(404);
  });
});

for (const role of ['content_creator', 'seo', 'developer', 'sales'] as const) {
  test.describe(`as ${role}`, () => {
    test.use({ storageState: authFile(role) });

    test('every file route is refused by the server', async ({ page }) => {
      const contact = randomUUID();
      const file = randomUUID();
      const base = `/api/admin/crm/contacts/${contact}/files`;
      const token = await csrf(page);
      expect((await page.request.get(base)).status(), 'list').toBe(403);
      expect((await page.request.get(`${base}/${file}`)).status(), 'download').toBe(403);
      const upload = await page.request.post(base, {
        headers: { 'x-csrf-token': token },
        multipart: {
          name: 'x.pdf',
          file: { name: 'x.pdf', mimeType: 'application/pdf', buffer: PDF },
        },
      });
      expect(upload.status(), 'upload').toBe(403);
      const removal = await page.request.delete(`${base}/${file}`, {
        headers: { 'x-csrf-token': token },
      });
      expect(removal.status(), 'removal').toBe(403);
    });
  });
}
