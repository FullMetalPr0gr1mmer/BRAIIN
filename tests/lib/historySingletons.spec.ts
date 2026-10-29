import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HistoryQuerySchema,
  HistoryRestoreRequestSchema,
  SINGLETON_ENTITY_TYPES,
} from '@schemas/release';
import type { EntitySave } from '@/lib/admin/useEntitySave';
import type { AuthContext } from '@/lib/auth/types';

// History for the site's own settings and a page's search settings (Admin v2 R14-prep, owner
// decision 2026-10-28: before R14). The identity (General) and the SEO defaults (SEO › Site
// wide) are per-tenant singletons, keyed in content_versions by the tenant, which the browser
// never names: their History asks with no id and the server reads the session's tenant
// (src/lib/release/history.ts, tests/lib/releaseVersions.spec.ts). A page's search settings
// (entity SEO, the shared SeoPanel) are keyed by the row's own id, known from the load.

const ROW = '0e0e0e0e-0000-4000-8000-000000000450';
const TENANT = '00000000-0000-4000-8000-0000000000c1';

/** What each mocked editor's save hands EditorForm, and what it was asked to load. */
const mock = vi.hoisted(() => ({
  targets: [] as unknown[],
  /** The row the entity-SEO load answers (its `id`), or none. */
  seoRow: null as Record<string, unknown> | null,
}));

vi.mock('@/components/admin/RichText', () => ({ default: () => null }));
vi.mock('@/lib/admin/useEntitySave', async (importOriginal) => {
  const { useRef } = await import('react');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    useEntitySave: (
      target: unknown,
      _id: unknown,
      options: { onRow?: (row: Record<string, unknown>) => void },
    ): EntitySave => {
      mock.targets.push(target);
      // The load's answer, once, as useEntitySave's effect would hand it over.
      const told = useRef(false);
      if (!told.current && mock.seoRow && (target as { kind?: string }).kind === 'entitySeo') {
        told.current = true;
        options.onRow?.(mock.seoRow);
      }
      const values = { metaTitle: { en: '', ar: '' } };
      return {
        isNew: false,
        values,
        saved: values,
        set: () => undefined,
        version: 2,
        busy: false,
        loadError: null,
        status: 'idle',
        savedAt: null,
        errors: { byId: {}, summary: [] },
        conflict: false,
        edgeMissed: false,
        dirty: false,
        message: null,
        save: async () => true,
        reloadTheirs: async () => undefined,
        adoptVersion: () => undefined,
      } as unknown as EntitySave;
    },
  };
});

const { RELEASE_REGISTRY } = await import('@/lib/release/registry');
const { historyEntityId } = await import('@/lib/release/history');
const { ValidationError } = await import('@/lib/admin/errors');
const { entitySeoHistory, historyQuery, historyRestoreBody, singletonHistory } =
  await import('@/lib/admin/historyTarget');
const { default: GeneralScreen } = await import('@/components/admin/screens/general/GeneralScreen');
const { default: SiteWideForm } = await import('@/components/admin/screens/seo/SiteWideForm');
const { default: SeoPanel, seoHistoryLabel } =
  await import('@/components/admin/screens/seo/SeoPanel');

/** Every History button a render draws, by the record it names. */
const historyButtons = (html: string): string[] =>
  [...html.matchAll(/>History<span class="visually-hidden"> of ([^<]*)<\/span><\/button>/g)].map(
    (m) => m[1]!,
  );

describe('the singletons of the release registry', () => {
  it('are exactly its tenant-keyed entries (the history the server keys by the session tenant)', () => {
    const keyed = Object.values(RELEASE_REGISTRY)
      .filter((entry) => entry.key === 'tenant_id')
      .map((entry) => entry.entityType)
      .sort();
    expect([...SINGLETON_ENTITY_TYPES].sort()).toEqual(keyed);
  });

  it('a history request names no id for a singleton, and one for anything else', () => {
    expect(HistoryQuerySchema.safeParse({ entityType: 'site_profile' }).success).toBe(true);
    expect(
      HistoryQuerySchema.safeParse({ entityType: 'site_profile', entityId: ROW }).success,
    ).toBe(false);
    expect(HistoryQuerySchema.safeParse({ entityType: 'service' }).success).toBe(false);
    expect(HistoryQuerySchema.safeParse({ entityType: 'entity_seo', entityId: ROW }).success).toBe(
      true,
    );
    expect(
      HistoryRestoreRequestSchema.safeParse({ entityType: 'seo_defaults', seq: 2 }).success,
    ).toBe(true);
    expect(
      HistoryRestoreRequestSchema.safeParse({ entityType: 'seo_defaults', entityId: ROW, seq: 2 })
        .success,
    ).toBe(false);
  });

  it('the server keys a singleton by the session, and refuses an id it would not use (code review 2)', () => {
    // The registry's rule (key `tenant_id`) and the schema's list are two copies; the test above
    // holds them equal, and the server refuses a request the registry's rule does not expect, so
    // a sent id is never silently ignored and a missing one never guessed.
    const auth = { tenantId: TENANT } as AuthContext;
    for (const entityType of SINGLETON_ENTITY_TYPES) {
      const entry = RELEASE_REGISTRY[entityType];
      expect(historyEntityId(auth, entry, undefined), entityType).toBe(TENANT);
      let refused: unknown = null;
      try {
        historyEntityId(auth, entry, ROW);
      } catch (err) {
        refused = err;
      }
      expect(refused, entityType).toBeInstanceOf(ValidationError);
      expect((refused as InstanceType<typeof ValidationError>).field).toBe('entityId');
    }
    const service = RELEASE_REGISTRY['service'];
    expect(historyEntityId(auth, service, ROW)).toBe(ROW);
    expect(() => historyEntityId(auth, service, undefined)).toThrow(ValidationError);
  });

  it("the drawer's request and restore body leave a singleton's id out", () => {
    const identity = singletonHistory('site_profile');
    expect(historyQuery(identity)).toBe('/api/admin/history?entityType=site_profile');
    expect(historyRestoreBody(identity, 3)).toEqual({ entityType: 'site_profile', seq: 3 });
    const seo = entitySeoHistory(ROW)!;
    expect(historyQuery(seo)).toBe(`/api/admin/history?entityType=entity_seo&entityId=${ROW}`);
    expect(historyRestoreBody(seo, 1)).toEqual({ entityType: 'entity_seo', entityId: ROW, seq: 1 });
    expect(entitySeoHistory(null)).toBeNull();
  });
});

describe('the editors offer History', () => {
  it('General: the identity has it (named "Site identity"); Region and data keeps none', () => {
    const html = renderToStaticMarkup(
      createElement(GeneralScreen, { logoSrc: null, canOpenApplications: true, tz: 'Asia/Riyadh' }),
    );
    expect(historyButtons(html)).toEqual(['Site identity']);
  });

  it('SEO › Site wide: the defaults have it (named "Site wide SEO")', () => {
    const html = renderToStaticMarkup(createElement(SiteWideForm));
    expect(historyButtons(html)).toEqual(['Site wide SEO']);
  });

  const panel = () =>
    renderToStaticMarkup(
      createElement(SeoPanel, {
        target: {
          entityType: 'service',
          entityId: '0e0e0e0e-0000-4000-8000-000000000001',
          label: 'Logo Design',
          path: '/services/logo',
        },
        context: {
          brand: { en: 'Studio', ar: 'استوديو' },
          titleTemplate: { en: '%s | Studio', ar: '%s | استوديو' },
          defaultRobots: 'index,follow',
          defaults: {
            title: { en: 'Logo Design', ar: 'تصميم الشعار' },
            description: { en: 'Logos', ar: 'شعارات' },
          },
        },
      } as never),
    );

  it("a page's search settings: History once the row exists, named apart from the page's own", () => {
    mock.seoRow = { id: ROW, version: 2 };
    expect(historyButtons(panel())).toEqual([seoHistoryLabel('Logo Design')]);
    expect(seoHistoryLabel('Logo Design')).toBe('Search settings for Logo Design');
  });

  it('a page with no search settings saved yet has no History (nothing was ever saved)', () => {
    mock.seoRow = { id: null, version: 0 };
    expect(historyButtons(panel())).toEqual([]);
  });
});
