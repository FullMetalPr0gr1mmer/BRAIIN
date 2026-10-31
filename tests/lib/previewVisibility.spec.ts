import { describe, expect, it } from 'vitest';
import { createPreviewSource } from '@/lib/preview/dataset';
import { PREVIEW_TABLES, type PreviewTable } from '@/lib/preview/relations';
import { mediaIdsInContent, visibilityClosure, VISIBILITY_DEPS } from '@/lib/preview/visibility';
import {
  BI,
  draft,
  fakeStaffClient,
  fixtureTables,
  ID,
  id,
  session,
  VISIBLE,
} from '../fixtures/previewDataset';

// The anon-RLS mirror (Admin v2 R8, src/lib/preview/visibility.ts): one fixture per fence,
// what a visitor would read written by hand from the policies (tests/fixtures/
// previewDataset.ts), and each fence flipped by a pending change (releases.md §8 edge case
// 24: a pending publish shows, a pending hide or delete hides).

type Row = Record<string, unknown>;

/** The ids a visitor would read of each table, through the emulator. */
async function visible(tables: Record<string, Row[]>, drafts: Row[] = []) {
  const source = createPreviewSource({
    supabase: fakeStaffClient({ ...tables, content_drafts: drafts }).client,
    session: session('admin'),
  });
  const db = source.client();
  const out: Record<string, string[]> = {};
  for (const table of PREVIEW_TABLES) {
    const key =
      table === 'portfolio_services'
        ? 'portfolio_id,service_id'
        : table === 'site_profile' || table === 'seo_defaults' || table === 'site_integrations'
          ? 'tenant_id'
          : // Admin v2 E4: a visitor reads a theme's tokens and version only, never its id.
            table === 'custom_themes'
            ? 'version'
            : 'id';
    const { data, error } = await db.from(table).select(key);
    if (error) throw new Error(`${table}: ${error.code}`);
    out[table] = (data as unknown as Row[]).map((r) =>
      table === 'portfolio_services' ? `${r['portfolio_id']}>${r['service_id']}` : String(r[key]),
    );
  }
  return { ids: out, report: source.report() };
}

describe('the mirror over the fixture tenant', () => {
  it('keeps exactly what a visitor reads, table by table', async () => {
    const { ids, report } = await visible(fixtureTables());
    for (const [table, want] of Object.entries(VISIBLE)) {
      expect([...ids[table]!].sort(), table).toEqual([...want].sort());
    }
    expect(ids['portfolio_services']).toEqual([`${ID.pPub}>${ID.sPub}`, `${ID.pPub}>${ID.sDraft}`]);
    expect(ids['site_profile']).toHaveLength(1);
    expect(ids['seo_defaults']).toHaveLength(1);
    expect(ids['site_integrations']).toHaveLength(1);
    // Admin v2 E4: the active v1 theme (version 3), never the active legacy one.
    expect(ids['custom_themes']).toEqual(['3']);
    expect(report.unsupported).toEqual([]);
  });

  it('services: a published one with no discipline, or a published discipline (0028)', async () => {
    const { ids } = await visible(fixtureTables());
    expect(ids['services']).toContain(ID.sNoDisc);
    expect(ids['services']).not.toContain(ID.sHiddenByDisc);
  });

  it('service cases: hidden with a draft service, and with a service its discipline hides', async () => {
    const { ids } = await visible(fixtureTables());
    expect(ids['service_cases']).not.toContain(ID.cOfDraftService);
    expect(ids['service_cases']).not.toContain(ID.cOfHiddenService);
  });

  it('entity SEO: each parent kind, and an orphan never', async () => {
    const { ids } = await visible(fixtureTables());
    expect(ids['entity_seo']!.sort()).toEqual(
      [ID.esSvc, ID.esBlog, ID.esProject, ID.esPage].sort(),
    );
  });

  it('media: each of the eight branches, and never an external or unreferenced asset', async () => {
    const { ids } = await visible(fixtureTables());
    // 1 project poster, 2 case-study frame, 3 client logo, 4 testimonial avatar, 5 team
    // portrait, 6 a nested mediaId in a visible section, 7 discipline poster, 8 service poster
    expect(ids['media_assets']!.sort()).toEqual(
      [
        ID.mPoster,
        ID.mFrame,
        ID.mLogo,
        ID.mAvatar,
        ID.mPortrait,
        ID.mSection,
        ID.mDiscPoster,
        ID.mSvcPoster,
      ].sort(),
    );
    for (const hidden of [
      ID.mExternal,
      ID.mUnref,
      ID.mHiddenSection,
      ID.mDraftSection,
      ID.mSvcHiddenPoster,
      ID.mDraftPoster,
      ID.mDraftFrame,
      ID.mHiddenLogo,
      ID.mDraftAvatar,
    ]) {
      expect(ids['media_assets']).not.toContain(hidden);
    }
  });

  it('media: a share image (0073) is read while its SEO row is, and the default always', async () => {
    const tables = fixtureTables();
    const template = tables['media_assets']!.find((m) => m['id'] === ID.mUnref)!;
    const shareLive = id(171);
    const shareDraft = id(172);
    const shareOrphan = id(173);
    const shareDefault = id(174);
    tables['media_assets']!.push(
      ...[shareLive, shareDraft, shareOrphan, shareDefault].map((mid) => ({
        ...template,
        id: mid,
      })),
    );
    const og = (eid: string, mid: string) => {
      const row = tables['entity_seo']!.find((r) => r['id'] === eid)!;
      row['og_media_id'] = mid;
    };
    og(ID.esSvc, shareLive); // a published service's SEO row: read
    og(ID.esSvcDraft, shareDraft); // a draft service's: hidden
    og(ID.esOrphan, shareOrphan); // an orphan's: hidden
    tables['seo_defaults']![0]!['default_og_media_id'] = shareDefault;
    const { ids } = await visible(tables);
    expect(ids['media_assets']).toContain(shareLive);
    expect(ids['media_assets']).toContain(shareDefault);
    expect(ids['media_assets']).not.toContain(shareDraft);
    expect(ids['media_assets']).not.toContain(shareOrphan);
  });

  it('reads every rule from the tables it depends on (the closure the dataset loads)', () => {
    expect([...visibilityClosure(['service_cases'])].sort()).toEqual([
      'disciplines',
      'service_cases',
      'services',
    ]);
    // 0073 adds the share images: entity_seo (and the parents its fence reads, blog_posts
    // among them) and seo_defaults; 0102 the site's icons: site_profile.
    expect(visibilityClosure(['media_assets']).size).toBe(15);
    expect(visibilityClosure(['media_assets'])).toContain('site_profile');
    for (const table of PREVIEW_TABLES)
      expect(VISIBILITY_DEPS[table as PreviewTable]).toBeDefined();
  });
});

describe('mediaIdsInContent mirrors `lax $.**.mediaId ? (@ == $id)`', () => {
  // Each case was run against PostgreSQL 18's jsonpath (jsonb_path_exists with the same
  // path and vars) when this mirror was written; the answers are the database's.
  it.each([
    [{ a: { mediaId: ['x'] } }, true],
    [{ mediaId: 'x' }, true],
    [[{ b: [{ mediaId: 'x' }] }], true],
    [{ mediaId: { mediaId: 'x' } }, true],
    [{ MediaId: 'x' }, false],
    [{ a: { mediaId: [['x']] } }, true],
    ['x', false],
    [{ mediaId: 1 }, false],
    // lax mode unwraps at most two array levels under the key
    [{ mediaId: [[['x']]] }, false],
    [{ a: { mediaId: [[['x']]] } }, false],
    [{ mediaId: [['y', ['x']]] }, false],
    [{ mediaId: [[[['x']]]] }, false],
    [{ mediaId: ['y', 'x'] }, true],
    [{ mediaId: [[{ mediaId: 'x' }]] }, true],
    [[[[{ mediaId: 'x' }]]], true],
  ])('%j holds x: %s', (content, holds) => {
    const ids = mediaIdsInContent(content);
    expect(ids.has('x') || ids.has('1')).toBe(holds);
  });
});

describe('the password fence (0061 page_sections_password_fence)', () => {
  it('hides every section of a page behind a password, and media only they hold (branch 6)', async () => {
    const { ids } = await visible(fixtureTables());
    expect(ids['pages']).toContain(ID.pgLocked);
    expect(ids['page_sections']).not.toContain(ID.psLocked);
    expect(ids['media_assets']).not.toContain(ID.mLockedSection);
  });

  it('shows them when the live visibility row is in another mode', async () => {
    const tables = fixtureTables();
    tables['page_visibility']!.find((v) => v['id'] === ID.pvLocked)!['mode'] = 'link';
    const { ids } = await visible(tables);
    expect(ids['page_sections']).toContain(ID.psLocked);
    expect(ids['media_assets']).toContain(ID.mLockedSection);
  });

  it('follows the live row: a pending visibility change is not previewed', async () => {
    const { ids, report } = await visible(fixtureTables(), [
      draft('page_visibility', 'update', ID.pvLocked, { mode: 'public' }),
    ]);
    expect(ids['page_sections']).not.toContain(ID.psLocked);
    expect(report.notPreviewed).toEqual(['page_visibility']);
  });

  it("page_visibility is the mirror's alone: the emulator refuses it to a loader", () => {
    const source = createPreviewSource({
      supabase: fakeStaffClient(fixtureTables()).client,
      session: session('admin'),
    });
    expect(() => source.client().from('page_visibility')).toThrow();
    expect(source.report().unsupported).toEqual(['from page_visibility']);
  });
});

describe('pending changes flip each fence (edge case 24)', () => {
  it('a pending publish of a discipline shows its services, their cases and posters', async () => {
    const { ids } = await visible(fixtureTables(), [
      draft('discipline', 'update', ID.dDraft, { status: 'published' }),
    ]);
    expect(ids['disciplines']).toContain(ID.dDraft);
    expect(ids['services']).toContain(ID.sHiddenByDisc);
    expect(ids['service_cases']).toContain(ID.cOfHiddenService);
    expect(ids['media_assets']).toContain(ID.mSvcHiddenPoster);
    expect(ids['entity_seo']).toContain(ID.esSvcHidden);
  });

  it('a pending unpublish of a discipline hides its services and their cases', async () => {
    const { ids } = await visible(fixtureTables(), [
      draft('discipline', 'update', ID.dPub, { status: 'draft' }),
    ]);
    expect(ids['services']).toEqual([ID.sNoDisc]);
    expect(ids['service_cases']).toEqual([]);
    expect(ids['media_assets']).not.toContain(ID.mSvcPoster);
    expect(ids['media_assets']).not.toContain(ID.mDiscPoster);
  });

  it('a pending publish of a project shows its links and frames; a pending archive hides them', async () => {
    const shown = await visible(fixtureTables(), [
      draft('portfolio', 'update', ID.pDraft, { status: 'published' }),
    ]);
    expect(shown.ids['portfolio_services']).toContain(`${ID.pDraft}>${ID.sPub}`);
    expect(shown.ids['portfolio_media']).toContain(ID.pmDraft);
    expect(shown.ids['media_assets']).toEqual(
      expect.arrayContaining([ID.mDraftPoster, ID.mDraftFrame]),
    );
    const hidden = await visible(fixtureTables(), [
      draft('portfolio', 'update', ID.pPub, { status: 'archived' }),
    ]);
    expect(hidden.ids['portfolio_services']).toEqual([]);
    expect(hidden.ids['portfolio_media']).toEqual([]);
    expect(hidden.ids['entity_seo']).not.toContain(ID.esProject);
  });

  it('a pending hide of a page hides its sections and their media; a pending publish shows them', async () => {
    const hide = await visible(fixtureTables(), [
      draft('page', 'update', ID.pgHome, { status: 'draft' }),
    ]);
    expect(hide.ids['page_sections']).toEqual([]);
    expect(hide.ids['media_assets']).not.toContain(ID.mSection);
    const show = await visible(fixtureTables(), [
      draft('page', 'update', ID.pgDraft, { status: 'published' }),
    ]);
    expect(show.ids['page_sections']).toContain(ID.psOfDraft);
    expect(show.ids['media_assets']).toContain(ID.mDraftSection);
    expect(show.ids['entity_seo']).toContain(ID.esPageDraft);
  });

  it('a pending show of a section shows it and the media in it', async () => {
    const { ids } = await visible(fixtureTables(), [
      draft('page_section', 'update', ID.psHidden, { visible: true }),
    ]);
    expect(ids['page_sections']).toContain(ID.psHidden);
    expect(ids['media_assets']).toContain(ID.mHiddenSection);
  });

  it('a pending show of a client, sector and menu link shows each; a pending hide hides it', async () => {
    const { ids } = await visible(fixtureTables(), [
      draft('client', 'update', ID.clHidden, { visible: true }),
      draft('sector', 'update', ID.secVis, { visible: false }),
      draft('nav_item', 'update', ID.nHidden, { visible: true }),
    ]);
    expect(ids['clients']).toContain(ID.clHidden);
    expect(ids['media_assets']).toContain(ID.mHiddenLogo);
    expect(ids['sectors']).toEqual([]);
    expect(ids['navigation']).toContain(ID.nHidden);
  });

  it('a pending delete hides the row, cascades to its children and clears what pointed at it', async () => {
    const { ids } = await visible(fixtureTables(), [
      draft('service', 'delete', ID.sPub),
      draft('nav_item', 'delete', ID.nVis),
    ]);
    expect(ids['services']).toEqual([ID.sNoDisc]);
    // cascade: its case and its project links go (0001, 0028)
    expect(ids['service_cases']).toEqual([]);
    expect(ids['portfolio_services']).toEqual([`${ID.pPub}>${ID.sDraft}`]);
    // a menu link's children go with it (0009)
    expect(ids['navigation']).toEqual([]);
    expect(ids['entity_seo']).not.toContain(ID.esSvc);
  });

  it('a pending publish of a testimonial and a team member shows their media', async () => {
    const { ids } = await visible(fixtureTables(), [
      draft('testimonial', 'update', ID.tDraft, {
        status: 'published',
        consentObtainedAt: '2026-02-01T00:00:00.000Z',
      }),
      draft('team_member', 'update', ID.tmDraft, { status: 'published' }),
    ]);
    expect(ids['testimonials']).toContain(ID.tDraft);
    expect(ids['media_assets']).toContain(ID.mDraftAvatar);
    expect(ids['team_members']).toContain(ID.tmDraft);
  });

  it('a pending create appears only when it would be visible', async () => {
    const { ids } = await visible(fixtureTables(), [
      draft('category', 'create', id(801), { slug: 'new-cat', name: BI('New', 'جديد') }),
      draft('blog_post', 'create', id(802), { slug: 'np', title: BI('P', 'م') }),
      draft('blog_post', 'create', id(803), {
        slug: 'np2',
        title: BI('P2', 'م'),
        status: 'published',
      }),
    ]);
    expect(ids['categories']).toContain(id(801));
    // created as a draft (the column default): hidden
    expect(ids['blog_posts']).not.toContain(id(802));
    expect(ids['blog_posts']).toContain(id(803));
  });
});
