import { describe, it, expect } from 'vitest';
import { RESOURCES } from '@/lib/admin/resources';
import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import { ROLES } from '@/lib/auth/types';
import { registryRows, type RegistryRow } from '../fixtures/releaseRegistry';

// The release registry's role lists equal ROLE_CAPS (Admin v2 R1, migration 0038).
//
// app.release_entities says, per entity type, who may stage a change (author_roles) and
// who may stage a removal (delete_roles); the drafts policies read those lists. They must
// be exactly the holders of the capability the entity's editor already requires, so the
// release model never widens who can change the live site (releases.md A3-4, program
// decision P-2): the write capability of its resource config (or route) for authoring, its
// delete capability (content.archiveDelete unless the config names another) for removals.
// A role added later (Sales) holds none of these, and this keeps it that way.

/** Entity types edited outside the resource configs: their route's write capability. */
const ROUTE_CAPS: Record<string, Capability> = {
  site_profile: 'settings.general', // src/pages/api/admin/site-profile.ts
  seo_defaults: 'seo.globalDefaults', // src/pages/api/admin/seo-defaults.ts
  entity_seo: 'seo.entityMeta', // src/pages/api/admin/entity-seo.ts
};

const holders = (cap: Capability) => ROLES.filter((role) => ROLE_CAPS[role][cap] === 'full').sort();

const configOf = (row: RegistryRow) =>
  Object.values(RESOURCES).find((config) => config.entity === row.entityType);

describe('the release registry (app.release_entities) equals ROLE_CAPS', () => {
  const rows = registryRows();

  it('parses the twenty rows the migration seeds', () => {
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((r) => r.entityType)).size).toBe(20);
  });

  it('every entity type is a resource config or a route with a stated capability', () => {
    const unmapped = rows
      .filter((row) => !configOf(row) && !(row.entityType in ROUTE_CAPS))
      .map((row) => row.entityType);
    expect(unmapped).toEqual([]);
  });

  for (const row of registryRows()) {
    describe(row.entityType, () => {
      const config = configOf(row);
      const writeCap = config?.writeCap ?? ROUTE_CAPS[row.entityType]!;

      it(`is the table its editor writes (${row.table})`, () => {
        if (config) expect(config.table).toBe(row.table);
        else expect(row.keyColumn === 'tenant_id' || row.entityType === 'entity_seo').toBe(true);
      });

      it(`author_roles = the holders of ${writeCap}`, () => {
        expect([...row.authorRoles].sort()).toEqual(holders(writeCap));
      });

      it('delete_roles = the holders of its delete capability (none for a singleton or SEO meta)', () => {
        const expected = config ? holders(config.deleteCap ?? 'content.archiveDelete') : [];
        expect([...row.deleteRoles].sort()).toEqual(expected);
      });

      it('its go-live flag agrees with the resource config', () => {
        if (config?.publishFlag) expect(row.publishFlag).toBe(config.publishFlag);
        if (row.publishFlag) expect(row.columns).toContain(row.publishFlag);
      });
    });
  }

  it('singletons are keyed by the tenant; everything else by id', () => {
    const singletons = rows.filter((r) => r.keyColumn === 'tenant_id').map((r) => r.entityType);
    expect(singletons.sort()).toEqual(['seo_defaults', 'site_profile']);
  });

  it('the job-application intake switch stays immediate (never in a release)', () => {
    const profile = rows.find((r) => r.entityType === 'site_profile')!;
    expect(profile.exemptColumns).toEqual(['accepting_applications']);
    expect(profile.columns).not.toContain('accepting_applications');
  });

  it('no release writes a key, the tenant, a version, an actor, a stamp or a schedule', () => {
    const system = new Set([
      'id',
      'tenant_id',
      'version',
      'created_at',
      'updated_at',
      'created_by',
      'updated_by',
      'published_at',
      'scheduled_for',
      'search_en',
      'search_ar',
    ]);
    const leaked = rows.flatMap((r) =>
      r.columns.filter((c) => system.has(c)).map((c) => `${r.table}.${c}`),
    );
    expect(leaked).toEqual([]);
  });

  it('apply order: a row comes after what it points at', () => {
    const order = new Map(rows.map((r) => [r.entityType, r.applyOrder]));
    const after = (a: string, b: string) => expect(order.get(a)!).toBeGreaterThan(order.get(b)!);
    after('service', 'discipline');
    after('portfolio', 'sector');
    after('portfolio', 'client');
    after('service_case', 'service');
    after('service_case', 'portfolio');
    after('testimonial', 'portfolio');
    after('testimonial', 'client');
    after('blog_post', 'team_member');
    after('blog_post', 'category');
    after('page_section', 'page');
    after('entity_seo', 'page');
    after('entity_seo', 'blog_post');
  });
});
