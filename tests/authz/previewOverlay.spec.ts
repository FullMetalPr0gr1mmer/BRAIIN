import { describe, expect, it } from 'vitest';
import { CMS_ROLES, type Role } from '@/lib/auth/types';
import { AuthorizationError } from '@/lib/authz/errors';
import { assertAnyCap } from '@/lib/authz/matrix';
import { canPreview, createPreviewSource, PREVIEW_READ_CAPS } from '@/lib/preview/dataset';
import { RELEASE_REGISTRY } from '@/lib/release/registry';
import { RELEASE_ENTITY_TYPES, type ReleaseEntityType } from '@schemas/release';
import {
  BI,
  draft,
  fakeStaffClient,
  fixtureTables,
  ID,
  OTHER_TENANT,
  session,
  TENANT,
} from '../fixtures/previewDataset';

// Who sees which pending changes in a preview (Admin v2 R8; releases.md §8 edge case 16), per
// role over admin, content_creator, seo, developer, anon and other_tenant (CLAUDE.md §9). A
// draft is overlaid only in an area the role may read in the admin (its registry entry's
// readCaps at its readAccess); the rest are counted, never shown. The expectation is
// written by hand from CLAUDE.md §5, not derived from the code under test.

type Outcome = 'overlaid' | 'not previewed' | 'not shown';

/** Each type's pending change, against a fixture row that exists. */
const CHANGE: Record<ReleaseEntityType, () => Record<string, unknown>> = {
  category: () => draft('category', 'delete', ID.cat1),
  sector: () => draft('sector', 'delete', ID.secVis),
  client: () => draft('client', 'delete', ID.clVis),
  team_member: () => draft('team_member', 'delete', ID.tmPub),
  statistic: () => draft('statistic', 'delete', ID.stPub),
  certification: () => draft('certification', 'delete', ID.cePub),
  discipline: () => draft('discipline', 'delete', ID.dPub),
  service: () => draft('service', 'delete', ID.sPub),
  portfolio: () => draft('portfolio', 'delete', ID.pPub),
  service_case: () => draft('service_case', 'delete', ID.cPub),
  testimonial: () => draft('testimonial', 'delete', ID.tPub),
  blog_post: () => draft('blog_post', 'delete', ID.bPub),
  page: () => draft('page', 'delete', ID.pgHome),
  page_section: () => draft('page_section', 'delete', ID.psVis),
  nav_item: () => draft('nav_item', 'delete', ID.nVis),
  site_profile: () => draft('site_profile', 'update', TENANT, { brandName: BI('B', 'ب') }),
  custom_theme: () => draft('custom_theme', 'delete', ID.foreign),
  entity_seo: () => draft('entity_seo', 'delete', ID.esSvc),
  seo_defaults: () =>
    draft('seo_defaults', 'update', TENANT, { robotsDirectives: 'noindex,follow' }),
  redirect: () => draft('redirect', 'delete', ID.foreign),
  page_visibility: () => draft('page_visibility', 'delete', ID.foreign),
};

const O: Outcome = 'overlaid';
const P: Outcome = 'not previewed';
const N: Outcome = 'not shown';

/**
 * By hand from §5. Admin reads everything. Content Creator: the content areas, categories
 * and sectors, the team, and entity SEO ("view"); not identity, SEO defaults, theme,
 * redirects or visibility. SEO: what it reaches through seo.entityMeta (the content it
 * writes meta for, read only: categories, sectors, clients, team, disciplines, services,
 * projects, posts, pages) plus entity SEO and SEO defaults, and redirects (not previewed).
 * Developer: pages (through maintenance.manage) and identity; theme and page visibility
 * are readable but not previewed. A page-visibility change stays "not previewed" even
 * though the dataset reads the live rows for 0061's password fence (the fence follows the
 * live mode; docs/admin-v2/as-built/R8.md says why).
 */
const EXPECTED: Record<(typeof CMS_ROLES)[number], Record<ReleaseEntityType, Outcome>> = {
  admin: {
    category: O,
    sector: O,
    client: O,
    team_member: O,
    statistic: O,
    certification: O,
    discipline: O,
    service: O,
    portfolio: O,
    service_case: O,
    testimonial: O,
    blog_post: O,
    page: O,
    page_section: O,
    nav_item: O,
    site_profile: O,
    custom_theme: P,
    entity_seo: O,
    seo_defaults: O,
    redirect: P,
    page_visibility: P,
  },
  content_creator: {
    category: O,
    sector: O,
    client: O,
    team_member: O,
    statistic: O,
    certification: O,
    discipline: O,
    service: O,
    portfolio: O,
    service_case: O,
    testimonial: O,
    blog_post: O,
    page: O,
    page_section: O,
    nav_item: O,
    site_profile: N,
    custom_theme: N,
    entity_seo: O,
    seo_defaults: N,
    redirect: N,
    page_visibility: N,
  },
  seo: {
    category: O,
    sector: O,
    client: O,
    team_member: O,
    statistic: N,
    certification: N,
    discipline: O,
    service: O,
    portfolio: O,
    service_case: N,
    testimonial: N,
    blog_post: O,
    page: O,
    page_section: N,
    nav_item: N,
    site_profile: N,
    custom_theme: N,
    entity_seo: O,
    seo_defaults: O,
    redirect: P,
    page_visibility: N,
  },
  developer: {
    category: N,
    sector: N,
    client: N,
    team_member: N,
    statistic: N,
    certification: N,
    discipline: N,
    service: N,
    portfolio: N,
    service_case: N,
    testimonial: N,
    blog_post: N,
    page: O,
    page_section: N,
    nav_item: N,
    site_profile: O,
    custom_theme: P,
    entity_seo: N,
    seo_defaults: N,
    redirect: N,
    page_visibility: P,
  },
};

async function outcome(role: Role, type: ReleaseEntityType): Promise<Outcome> {
  const preview = createPreviewSource({
    supabase: fakeStaffClient({ ...fixtureTables(), content_drafts: [CHANGE[type]()] }).client,
    session: session(role),
  });
  const table = RELEASE_REGISTRY[type].table;
  const db = preview.client();
  // Read the type's table when the preview has it; any table loads the drafts.
  await db
    .from(['custom_themes', 'redirects', 'page_visibility'].includes(table) ? 'pages' : table)
    .select(
      table === 'site_profile' || table === 'seo_defaults'
        ? 'tenant_id'
        : table === 'portfolio_services'
          ? 'portfolio_id'
          : 'id',
    );
  const r = preview.report();
  expect(r.invalid, `${role} ${type}`).toEqual([]);
  expect(r.unsupported, `${role} ${type}`).toEqual([]);
  if (r.overlaid === 1) return O;
  if (r.notPreviewed.includes(type)) return P;
  expect(r.draftsNotShown, `${role} ${type}`).toBe(1);
  return N;
}

describe('pending changes a preview shows, per role and entity type', () => {
  it('covers every registry type and every CMS role', () => {
    for (const role of CMS_ROLES)
      expect(Object.keys(EXPECTED[role]).sort()).toEqual([...RELEASE_ENTITY_TYPES].sort());
  });

  for (const role of CMS_ROLES) {
    it(`${role}: as §5 says`, async () => {
      const got: Record<string, Outcome> = {};
      for (const type of RELEASE_ENTITY_TYPES) got[type] = await outcome(role, type);
      expect(got).toEqual(EXPECTED[role]);
    });
  }

  it('admin previews all 18 previewable types', () => {
    expect(Object.values(EXPECTED.admin).filter((o) => o === O)).toHaveLength(18);
  });
});

describe('who may open a preview at all', () => {
  const supabase = fakeStaffClient(fixtureTables()).client;

  it('every CMS role may (each reads at least one area)', () => {
    for (const role of CMS_ROLES) {
      expect(canPreview(role)).toBe(true);
      expect(() => createPreviewSource({ supabase, session: session(role) })).not.toThrow();
      // R9's gate on the same list agrees.
      expect(() =>
        assertAnyCap(session(role), PREVIEW_READ_CAPS, ['full', 'view', 'meta']),
      ).not.toThrow();
    }
  });

  it('anon (no session) and an inactive member are refused', () => {
    expect(() => createPreviewSource({ supabase, session: null })).toThrow(AuthorizationError);
    expect(() => createPreviewSource({ supabase, session: undefined })).toThrow(AuthorizationError);
    expect(() =>
      createPreviewSource({ supabase, session: session('admin', { isActive: false }) }),
    ).toThrow(AuthorizationError);
  });

  it('a role holding none of the read capabilities is refused (Sales, C10a)', () => {
    const sales: Role = 'sales';
    expect(canPreview(sales)).toBe(false);
    expect(() => createPreviewSource({ supabase, session: session(sales) })).toThrow(
      AuthorizationError,
    );
  });

  it("PREVIEW_READ_CAPS is the union of the registry's read capabilities", () => {
    expect([...PREVIEW_READ_CAPS].sort()).toEqual(
      [
        'blog.write',
        'categories.manage',
        'maintenance.manage',
        'nav.edit',
        'pages.write',
        'portfolio.write',
        'redirects.manage',
        'seo.entityMeta',
        'seo.globalDefaults',
        'services.write',
        'settings.general',
        'theme.edit',
      ].sort(),
    );
  });
});

describe('other_tenant', () => {
  it("never overlays another tenant's draft, nor serves its rows, even if the client returns them", async () => {
    // An Admin of the other tenant whose client (wrongly) returned the fixture tenant's rows.
    const preview = createPreviewSource({
      supabase: fakeStaffClient({
        ...fixtureTables(),
        content_drafts: [draft('sector', 'update', ID.secVis, { slug: 'theirs' })],
      }).client,
      session: session('admin', { tenantId: OTHER_TENANT }),
    });
    const { data } = await preview.client().from('sectors').select('id,slug');
    expect(data).toEqual([]);
    const r = preview.report();
    expect(r.overlaid).toBe(0);
    expect(r.pending).toBe(0);
    expect(r.foreignTenantRows).toBe(3);
  });
});
