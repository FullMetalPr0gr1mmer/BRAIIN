import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AsOfEntity } from '@schemas/release';
import type { AuthContext, Role } from '@/lib/auth/types';
import { asOfChanges, asOfTargets } from '@/lib/release/asOf';
import { planRestore } from '@/lib/release/revert';
import { RELEASE_REGISTRY } from '@/lib/release/registry';
import { client, T, type Row } from '../fixtures/stagedDb';
import { ADMIN, makeDb } from '../fixtures/stagedRoute';

// The state at a version as the restore and the preview read it (Admin v2 R10,
// src/lib/release/asOf.ts and revert.ts). The chains themselves (the earliest before-image of
// every entity changed since a version, created, edited, removed, cascades and out-of-band
// writes included) are the database's: pgTAP release_versions. Here: what the ledger's answer
// becomes (one target per entity, a case study's link sets beside its row, team members never),
// the changes a preview lays over live, and what a restore stages against live per kind of
// change (only what differs, link sets apart from the row, a full replace's moved fields).

const BI = (en: string, ar: string) => ({ en, ar });
const id = (n: number) => `0c0c0c0c-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = id(1);
const SERVICE = id(2);
const MEDIA = id(3);
const PAGE = id(4);
const SEO = id(5);

const auth = (role: Role = 'admin'): AuthContext => ({
  userId: ADMIN,
  tenantId: T,
  role,
  isActive: true,
  email: 'a@example.test',
});

const project = (over: Row = {}): Row => ({
  id: PROJECT,
  tenant_id: T,
  slug: 'spring',
  title: BI('Spring', 'الربيع'),
  status: 'published',
  sort_order: 1,
  version: 4,
  ...over,
});

const e = (
  entity_type: string,
  entity_id: string,
  before: Row | null,
  exists_now = true,
): AsOfEntity => ({ entity_type, entity_id, before, exists_now });

describe('asOfTargets: the ledger’s answer as entities', () => {
  it('one target per entity, a case study’s link sets beside its row', () => {
    const targets = asOfTargets([
      e('portfolio', PROJECT, project()),
      e('portfolio_children', PROJECT, { service_ids: [SERVICE], media: [] }),
      e('service', SERVICE, null),
    ]);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      entityId: PROJECT,
      before: project(),
      existsNow: true,
      children: { service_ids: [SERVICE], media: [] },
    });
    expect(targets[0]!.entry.entityType).toBe('portfolio');
    expect(targets[1]).toMatchObject({ entityId: SERVICE, before: null, existsNow: true });
  });

  it('only the link sets changed: a target whose row is as it was (before undefined)', () => {
    const [target] = asOfTargets([
      e('portfolio_children', PROJECT, { service_ids: [], media: [] }),
    ]);
    expect(target).toMatchObject({ entityId: PROJECT, before: undefined, existsNow: true });
    // Link sets that did not exist then (a project created since): empty sets.
    expect(asOfTargets([e('portfolio_children', PROJECT, null)])[0]!.children).toEqual({
      service_ids: [],
      media: [],
    });
  });

  it('never a team member (owner item O-12), never a type the registry does not know', () => {
    expect(
      asOfTargets([e('team_member', id(9), { slug: 'x' }), e('lead', id(10), { name: 'x' })]),
    ).toEqual([]);
  });
});

describe('asOfChanges: what a preview of the version lays over live', () => {
  it('an edit carries the whole image; a removal since comes back; a creation since goes', () => {
    const changes = asOfChanges(
      asOfTargets([
        e('portfolio', PROJECT, project({ title: BI('Then', 'سابقا') })),
        e('service', SERVICE, { slug: 'logo', title: BI('Logo', 'شعار') }, false),
        e('page', PAGE, null),
        // Created since and gone again: nothing to undo.
        e('page', id(8), null, false),
      ]),
    );
    expect(changes).toEqual([
      {
        entityType: 'portfolio',
        entityId: PROJECT,
        op: 'update',
        payload: { slug: 'spring', title: BI('Then', 'سابقا'), status: 'published', sortOrder: 1 },
      },
      {
        entityType: 'service',
        entityId: SERVICE,
        op: 'create',
        payload: { slug: 'logo', title: BI('Logo', 'شعار') },
      },
      { entityType: 'page', entityId: PAGE, op: 'delete', payload: {} },
    ]);
  });

  it('link sets: with their row, or alone as an edit of the sets only', () => {
    const sets = {
      service_ids: [SERVICE],
      media: [{ role: 'hero', kind: 'image', media_id: MEDIA, caption: null }],
    };
    expect(asOfChanges(asOfTargets([e('portfolio_children', PROJECT, sets)]))).toEqual([
      {
        entityType: 'portfolio',
        entityId: PROJECT,
        op: 'update',
        payload: {
          serviceIds: [SERVICE],
          media: [{ role: 'hero', kind: 'image', mediaId: MEDIA }],
        },
      },
    ]);
    const [withRow] = asOfChanges(
      asOfTargets([e('portfolio', PROJECT, project()), e('portfolio_children', PROJECT, sets)]),
    );
    expect(withRow!.payload).toMatchObject({ slug: 'spring', serviceIds: [SERVICE] });
  });
});

describe('planRestore: what a restore stages against live', () => {
  function db(tables: Record<string, Row[]>) {
    return client(makeDb(tables)) as unknown as SupabaseClient;
  }

  const links = (serviceIds: string[], media: string[] = []): Record<string, Row[]> => ({
    portfolio_services: serviceIds.map((s, i) => ({
      tenant_id: T,
      portfolio_id: PROJECT,
      service_id: s,
      sort_order: i,
    })),
    portfolio_media: media.map((m, i) => ({
      id: id(200 + i),
      tenant_id: T,
      portfolio_id: PROJECT,
      role: 'gallery',
      kind: 'image',
      media_id: m,
      sort_order: i,
    })),
  });

  it('link sets that changed alone: an edit of the sets only, with no column and no base', async () => {
    const sb = db({
      portfolio: [project()],
      services: [{ id: SERVICE, tenant_id: T }],
      ...links([]),
    });
    const plan = await planRestore(
      sb,
      auth(),
      asOfTargets([e('portfolio_children', PROJECT, { service_ids: [SERVICE], media: [] })]),
    );
    expect(plan.refused).toEqual([]);
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.write).toMatchObject({
      op: 'update',
      payload: { serviceIds: [SERVICE], media: [] },
      base: {},
      base_version: 4,
      fields: ['serviceIds', 'media'],
    });
  });

  it('link sets as they are live: nothing to stage', async () => {
    const sb = db({
      portfolio: [project()],
      services: [{ id: SERVICE, tenant_id: T }],
      ...links([SERVICE]),
    });
    const plan = await planRestore(
      sb,
      auth(),
      asOfTargets([e('portfolio_children', PROJECT, { service_ids: [SERVICE], media: [] })]),
    );
    expect(plan).toEqual({ changes: [], refused: [], kept: [] });
  });

  it('a row edited since with its link sets as they were: the columns only, never the sets', async () => {
    const sb = db({ portfolio: [project({ title: BI('Now', 'الآن') })], ...links([SERVICE]) });
    const plan = await planRestore(sb, auth(), asOfTargets([e('portfolio', PROJECT, project())]));
    expect(plan.changes[0]!.write).toMatchObject({
      payload: { title: BI('Spring', 'الربيع') },
      base: { title: BI('Now', 'الآن') },
      fields: ['title'],
    });
    expect(plan.changes[0]!.write.payload).not.toHaveProperty('serviceIds');
  });

  it('a picture in a restored link set that is gone: refused on the set', async () => {
    const sb = db({ portfolio: [], media_assets: [], ...links([]) });
    const plan = await planRestore(
      sb,
      auth(),
      asOfTargets([
        e('portfolio', PROJECT, project({ status: 'draft' }), false),
        e('portfolio_children', PROJECT, {
          service_ids: [],
          media: [{ role: 'gallery', kind: 'image', media_id: MEDIA }],
        }),
      ]),
    );
    expect(plan.refused).toMatchObject([
      { entityType: 'portfolio', entityId: PROJECT, reason: 'link-gone', field: 'media' },
    ]);
  });

  it('search settings (a full replace): every field written, only the moved ones named', async () => {
    const live = {
      id: SEO,
      tenant_id: T,
      entity_type: 'page',
      entity_id: PAGE,
      meta_title: BI('Now', 'الآن'),
      meta_description: BI('Same', 'نفسه'),
      og_image: null,
      og_media_id: null,
      canonical_override: null,
      robots: null,
      schema_type: null,
      version: 2,
    };
    const sb = db({ entity_seo: [live], pages: [{ id: PAGE, tenant_id: T }] });
    const plan = await planRestore(
      sb,
      auth('seo'),
      asOfTargets([e('entity_seo', SEO, { ...live, meta_title: BI('Then', 'سابقا') })]),
    );
    expect(plan.refused).toEqual([]);
    expect(plan.changes[0]!.write).toMatchObject({
      op: 'update',
      fields: ['meta_title'],
      payload: {
        entityType: 'page',
        entityId: PAGE,
        metaTitle: BI('Then', 'سابقا'),
        metaDescription: BI('Same', 'نفسه'),
      },
    });
  });

  it('search settings made since stay as they are, and say so (no release removes them)', async () => {
    const sb = db({
      entity_seo: [{ id: SEO, tenant_id: T, entity_type: 'page', entity_id: PAGE, version: 1 }],
    });
    const plan = await planRestore(sb, auth('seo'), asOfTargets([e('entity_seo', SEO, null)]));
    expect(plan.changes).toEqual([]);
    expect(plan.kept).toMatchObject([{ entityType: 'entity_seo', entityId: SEO, reason: 'kept' }]);
  });

  it('an edit is derived once: one parse and toRow per changed entity, not two (P-15)', async () => {
    const live = { id: SERVICE, tenant_id: T, slug: 'logo', title: BI('Now', 'الآن'), version: 3 };
    const sb = db({ services: [live] });
    const toRow = vi.spyOn(RELEASE_REGISTRY.service.resource!, 'toRow');
    try {
      const plan = await planRestore(
        sb,
        auth(),
        asOfTargets([e('service', SERVICE, { ...live, title: BI('Then', 'سابقا') })]),
      );
      expect(plan.changes[0]!.write).toMatchObject({
        payload: { title: BI('Then', 'سابقا') },
        fields: ['title'],
      });
      expect(toRow).toHaveBeenCalledTimes(1);
    } finally {
      toRow.mockRestore();
    }
  });

  it('gone since and already gone: nothing; created since and already gone: nothing', async () => {
    const sb = db({ services: [] });
    const plan = await planRestore(sb, auth(), asOfTargets([e('service', SERVICE, null, false)]));
    expect(plan).toEqual({ changes: [], refused: [], kept: [] });
  });
});
