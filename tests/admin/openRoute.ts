import { expect, type Page } from '@playwright/test';
import { UNSEEDED_LISTS, editRowRequest, type SweepRoute } from './routes';

/*
 * How a signed-in spec finds the URL of a swept admin route (Admin v2 F0, shared since Z1): the
 * sweep (sweep.e2e.ts), the design capture (capture.e2e.ts), the dialog matrix
 * (dialogs.e2e.ts) and the admin visual baselines (tests/visual/admin.visual.ts) open the same
 * screens the same way, so an edit screen is the same row in all of them.
 */

/** The double-submit token the admin's own fetches send (the `__Host-csrf` cookie). */
export async function csrf(page: Page): Promise<string> {
  const find = async () =>
    (await page.context().cookies()).find((c) => c.name === '__Host-csrf')?.value ?? '';
  if (!(await find())) await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  return find();
}

/**
 * The URL to open: an edit screen takes the first row its role's own list API returns.
 * Null only for a list the seed leaves empty (UNSEEDED_LISTS). A refused or failing list,
 * or an empty one the seed fills, fails the test: the role's menu offers that screen. An
 * edit screen with no resource config posts its sample's body instead (EDIT_SAMPLES, the F0
 * harness extension; its row is made by tests/admin/samples.setup.ts).
 */
export async function resolvePath(page: Page, route: SweepRoute): Promise<string | null> {
  const request = editRowRequest(route);
  if (!request) return route.path;
  const listApi = route.listApi ?? '';
  const res =
    request.method === 'POST'
      ? await page.request.post(request.url, {
          headers: { 'x-csrf-token': await csrf(page) },
          data: request.body,
        })
      : await page.request.get(request.url);
  expect(res.status(), `${listApi} answers the signed-in role`).toBe(200);
  const body = (await res.json()) as { data?: { rows?: { id?: unknown }[] } };
  const id = body.data?.rows?.[0]?.id;
  if (typeof id === 'string') return route.path.replace('[id]', id);
  expect(
    UNSEEDED_LISTS[listApi],
    `${listApi} answered no row, but the seed has rows for it`,
  ).toBeDefined();
  return null;
}

/**
 * An edit screen opened on one named row rather than the first: the row of the role's own list
 * API whose `slug` is `slug` (the page editor on About, whose first section opens with it).
 */
export async function pathForSlug(page: Page, route: SweepRoute, slug: string): Promise<string> {
  const res = await page.request.get(`${route.listApi ?? ''}?limit=100`);
  expect(res.status(), `${route.listApi ?? ''} answers the signed-in role`).toBe(200);
  const body = (await res.json()) as { data?: { rows?: { id?: unknown; slug?: unknown }[] } };
  const row = (body.data?.rows ?? []).find((r) => r.slug === slug);
  expect(typeof row?.id, `the seeded row "${slug}" in ${route.listApi ?? ''}`).toBe('string');
  return route.path.replace('[id]', String(row!.id));
}
