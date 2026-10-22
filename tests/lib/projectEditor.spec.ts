import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PortfolioUpdateSchema } from '@schemas/admin';
import type { AuthContext } from '@/lib/auth/types';
import { SEO_PANEL_FIELD_NAMES, validateTabs, visibleTabs } from '@/lib/admin/editorTabs';
import { formToPayload, rowToForm } from '@/lib/admin/formPayload';
import { mapIssues } from '@/lib/admin/fieldErrors';
import { portfolioResource } from '@/lib/admin/resources/portfolio';
import { portfolioUi } from '@/lib/admin/ui/portfolio';
import { withIdPrefix } from '@/components/admin/fields/EditorForm';
import { tileName } from '@/components/admin/fields/GalleryField';
import { isDisabledControl } from '@/lib/admin/client/sortable';
import {
  MEDIA_VIEW_FIELDS,
  joinMedia,
  remapMediaErrors,
  setView,
  splitMedia,
  viewIdOf,
  type Item,
} from '@/components/admin/screens/projects/media';
import {
  countBy,
  filterProjects,
  fold,
  matchesChip,
  matchesQuery,
  projectChips,
  projectName,
  projectsCount,
  serviceNames,
  type Row,
} from '@/components/admin/screens/projects/model';
import {
  placeholderFigure,
  publishRequirements,
  requirementsSummary,
} from '@/components/admin/screens/projects/publish';
import { consentState } from '@/components/admin/screens/projects/TestimonialsCard';
import {
  PROJECT_FIELDS,
  PROJECT_GROUPS,
  PROJECT_TABS,
} from '@/components/admin/screens/projects/view';

// The Projects area (Admin v2 U6, AV-15): the media set as four role controls and back (one
// save), the server's errors on the right control, the editor's tabs and cards, the publish
// requirements against assertPublishable, and the list's search, chips and counts. The screens
// are driven in a browser by tests/admin/projects.e2e.ts.

const T = '00000000-0000-4000-8000-0000000000aa';
const M1 = '00000000-0000-4000-8000-000000000001';
const M2 = '00000000-0000-4000-8000-000000000002';
const M3 = '00000000-0000-4000-8000-000000000003';
const M4 = '00000000-0000-4000-8000-000000000004';

/** A stored project as the item GET returns it (the embeds through fromRow). */
function storedProject(media: Record<string, unknown>[]) {
  return portfolioResource.fromRow!({
    id: T,
    slug: 'p',
    title: { en: 'P', ar: 'ب' },
    status: 'draft',
    version: 3,
    portfolio_services: [],
    portfolio_media: media,
  });
}

/** The media set's form state, as useEntitySave loads it. */
function loadedMedia(media: Record<string, unknown>[]): Item[] {
  return rowToForm(storedProject(media), portfolioUi.fields)['media'] as Item[];
}

const SEEDED = [
  // The seed's order is not the canonical one: a gallery first, the film last.
  { role: 'gallery', kind: 'image', media_id: M3, sort_order: 0 },
  {
    role: 'hero',
    kind: 'video',
    media_id: M1,
    video_path: '/media/reel.mp4',
    clip_start_s: 2,
    clip_end_s: 9,
    sort_order: 1,
  },
  {
    role: 'breakdown',
    kind: 'image',
    media_id: M2,
    breakdown_kind: 'sketch',
    layout: 'wide',
    caption: { en: 'A', ar: 'أ' },
    sort_order: 2,
  },
  { role: 'gallery', kind: 'image', media_id: M4, sort_order: 3 },
  {
    role: 'final',
    kind: 'video',
    media_id: M1,
    video_path: '/media/reel.mp4',
    clip_start_s: 10,
    clip_end_s: 20,
    duration_label: '1:30',
    sort_order: 4,
  },
];

describe('the media set as four role controls (media.ts)', () => {
  it('splits by role, keeping each item whole but its role, and says where each went', () => {
    const { view, layout } = splitMedia(loadedMedia(SEEDED));
    expect(view.heroItem['mediaId']).toBe(M1);
    expect(view.heroItem['role']).toBeUndefined();
    expect(view.finalFilm['durationLabel']).toBe('1:30');
    expect(view.breakdown.map((i) => i['breakdownKind'])).toEqual(['sketch']);
    expect(view.gallery.map((i) => i['mediaId'])).toEqual([M3, M4]);
    // layout[k] is the set's item k, in the set's own (loaded) order.
    expect(layout).toEqual([
      { role: 'gallery', index: 0 },
      { role: 'hero', index: 0 },
      { role: 'breakdown', index: 0 },
      { role: 'gallery', index: 1 },
      { role: 'final', index: 0 },
    ]);
  });

  it('joins back in one order (hero, film, breakdown, gallery), the payload what the API takes', () => {
    const loaded = loadedMedia(SEEDED);
    const { media } = joinMedia(splitMedia(loaded).view);
    expect(media.map((i) => i['role'])).toEqual([
      'hero',
      'final',
      'breakdown',
      'gallery',
      'gallery',
    ]);
    const payload = formToPayload({ media }, portfolioUi.fields);
    const parsed = PortfolioUpdateSchema.safeParse({ version: 1, ...payload });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    // Nothing is lost on the way: every stored item comes back with what it held.
    const before = formToPayload({ media: loaded }, portfolioUi.fields)['media'] as Item[];
    const after = payload['media'] as Item[];
    const key = (i: Item) => JSON.stringify(Object.entries(i).sort());
    expect(after.map(key).sort()).toEqual(before.map(key).sort());
  });

  it('a control holding nothing is no item; a clip makes a video, a picture alone an image', () => {
    const { view } = splitMedia(loadedMedia(SEEDED));
    const noHero = joinMedia({
      ...view,
      heroItem: { ...view.heroItem, mediaId: '', clip: { source: '' } },
    });
    expect(noHero.media.map((i) => i['role'])).not.toContain('hero');
    const imageHero = joinMedia({ ...view, heroItem: { ...view.heroItem, clip: { source: '' } } });
    expect(imageHero.media.find((i) => i['role'] === 'hero')?.['kind']).toBe('image');
    const videoBreakdown = joinMedia({
      ...view,
      breakdown: [
        {
          ...view.breakdown[0],
          clip: { source: 'path', path: '/media/reel.mp4', startS: '', endS: '', streamUid: '' },
        },
      ],
    });
    expect(videoBreakdown.media.find((i) => i['role'] === 'breakdown')?.['kind']).toBe('video');
  });

  it('a new gallery picture is an image item; a control set from the set as it stands', () => {
    const loaded = loadedMedia(SEEDED);
    const { view } = splitMedia(loaded);
    const next = setView(loaded, 'gallery', [...view.gallery, { kind: 'image', mediaId: M2 }]);
    expect(next.filter((i) => i['role'] === 'gallery').map((i) => i['mediaId'])).toEqual([
      M3,
      M4,
      M2,
    ]);
    expect(next.filter((i) => i['role'] === 'hero')).toHaveLength(1);
    // A reorder of the gallery moves nothing else.
    const swapped = setView(loaded, 'gallery', [view.gallery[1], view.gallery[0]]);
    expect(swapped.filter((i) => i['role'] === 'gallery').map((i) => i['mediaId'])).toEqual([
      M4,
      M3,
    ]);
    expect(swapped.find((i) => i['role'] === 'final')?.['durationLabel']).toBe('1:30');
    expect([...MEDIA_VIEW_FIELDS].sort()).toEqual([
      'breakdown',
      'finalFilm',
      'gallery',
      'heroItem',
    ]);
  });

  it('nothing the database would not hold twice is dropped: a second hero shows in the gallery', () => {
    const { view, layout } = splitMedia([
      { role: 'hero', kind: 'image', mediaId: M1 },
      { role: 'hero', kind: 'image', mediaId: M2 },
    ]);
    expect(view.gallery.map((i) => i['mediaId'])).toEqual([M2]);
    expect(layout[1]).toEqual({ role: 'gallery', index: 0 });
  });
});

describe('the server’s errors land on the control holding the item', () => {
  const layout = splitMedia(loadedMedia(SEEDED)).layout;

  it('maps an item’s element id to its control’s', () => {
    expect(viewIdOf('f-media-1-mediaId', layout)).toBe('f-heroItem-mediaId');
    expect(viewIdOf('f-media-1-clip-path', layout)).toBe('f-heroItem-clip-path');
    expect(viewIdOf('f-media-1-kind', layout)).toBe('f-heroItem');
    expect(viewIdOf('f-media-4-durationLabel', layout)).toBe('f-finalFilm-durationLabel');
    expect(viewIdOf('f-media-2-caption-ar', layout)).toBe('f-breakdown-0-caption-ar');
    expect(viewIdOf('f-media-2-role', layout)).toBe('f-breakdown-0');
    expect(viewIdOf('f-media-3-mediaId', layout)).toBe('f-gallery');
    expect(viewIdOf('f-media', layout)).toBe('f-breakdown');
    expect(viewIdOf('f-media-99', layout)).toBe('f-breakdown');
    expect(viewIdOf('f-title-en', layout)).toBe('f-title-en');
  });

  it('a refused save, mapped as fieldErrors.ts maps it, names the control in the summary', () => {
    const values = { media: loadedMedia(SEEDED) };
    const mapped = mapIssues(
      [
        { path: 'media.1.mediaId', message: 'choose the image' },
        { path: 'media.2.breakdownKind', message: 'a breakdown item has a kind' },
        { path: 'title.ar', message: 'Required' },
      ],
      portfolioUi.fields,
      'f',
      values,
    );
    const moved = remapMediaErrors(mapped, layout);
    expect(Object.keys(moved.byId).sort()).toEqual(
      ['f-breakdown-0-breakdownKind', 'f-heroItem-mediaId', 'f-title-ar'].sort(),
    );
    expect(moved.summary.map((s) => s.message)).toEqual([
      'Hero banner: choose the image',
      'Breakdown 1: a breakdown item has a kind',
      expect.stringContaining('Required'),
    ]);
  });
});

describe('the editor’s tabs and cards (view.ts)', () => {
  const ui = {
    slug: 'portfolio-editor',
    fields: PROJECT_FIELDS,
    tabs: PROJECT_TABS,
    seoEntity: 'portfolio' as const,
  };

  it('keep the rules of a tabbed editor', () => {
    expect(validateTabs(ui)).toEqual([]);
    expect(PROJECT_TABS.map((t) => t.label)).toEqual([
      'Basics',
      'Case study',
      'Breakdown & gallery',
      'SEO',
      'Publishing',
    ]);
    for (const name of SEO_PANEL_FIELD_NAMES) {
      expect(PROJECT_FIELDS.map((f) => f.name)).not.toContain(name);
    }
  });

  it('draw every field the save sends but the one media set, which the four controls are', () => {
    const drawn = new Set(PROJECT_FIELDS.map((f) => f.name));
    for (const field of portfolioUi.fields) {
      if (field.name === 'media') continue;
      expect(drawn.has(field.name), field.name).toBe(true);
    }
    expect(drawn.has('media')).toBe(false);
    for (const name of MEDIA_VIEW_FIELDS) expect(drawn.has(name), name).toBe(true);
    // A relabelled field keeps its name, kind and rules.
    for (const field of PROJECT_FIELDS) {
      const api = portfolioUi.fields.find((f) => f.name === field.name);
      if (api) expect({ ...field, label: '', help: '' }).toEqual({ ...api, label: '', help: '' });
    }
  });

  it('each card sits inside one tab', () => {
    for (const group of PROJECT_GROUPS) {
      const homes = PROJECT_TABS.filter((t) => group.fields.every((n) => t.fields?.includes(n)));
      expect(homes, group.id).toHaveLength(1);
    }
  });

  it('a role that only reads SEO opens on it; one without SEO has no tab for it', () => {
    expect(visibleTabs(PROJECT_TABS, { seoAccess: 'none' }).map((t) => t.id)).not.toContain('seo');
    expect(visibleTabs(PROJECT_TABS, { seoAccess: 'view' }).map((t) => t.id)).toContain('seo');
  });
});

describe('the publish requirements mirror assertPublishable', () => {
  const auth = { tenantId: T } as unknown as AuthContext;
  const fakeSb = (alt: unknown) =>
    ({
      from: () => {
        const api = {
          select: () => api,
          eq: () => api,
          maybeSingle: async () => ({ data: { alt }, error: null }),
        };
        return api;
      },
    }) as unknown as SupabaseClient;

  const good = {
    title: { en: 'Name', ar: 'اسم' },
    projectType: { en: 'Brand film', ar: 'فيلم' },
    posterMediaId: M1,
    isPlaceholder: false,
    results: [{ value: '+40%', label: { en: 'Reach', ar: 'وصول' } }],
  };
  const alt = { en: 'A frame', ar: 'إطار' };
  const cases: [string, Record<string, unknown>, unknown][] = [
    ['all there', good, alt],
    ['no Arabic name', { ...good, title: { en: 'Name', ar: '' } }, alt],
    ['no type', { ...good, projectType: null }, alt],
    ['no poster', { ...good, posterMediaId: '' }, alt],
    ['no Arabic alt', good, { en: 'A frame' }],
    ['a sample', { ...good, isPlaceholder: true }, alt],
    ['an XX figure', { ...good, results: [{ value: 'XXM', label: { en: 'a', ar: 'ب' } }] }, alt],
  ];

  for (const [name, values, posterAlt] of cases) {
    it(`agree: ${name}`, async () => {
      const reqs = publishRequirements(values, values['posterMediaId'] ? { alt: posterAlt } : null);
      const allMet = reqs.every((r) => r.met);
      const row = {
        title: values['title'],
        project_type: values['projectType'],
        poster_media_id: values['posterMediaId'] || null,
        is_placeholder: values['isPlaceholder'],
        results: values['results'],
      };
      let passes = true;
      try {
        await portfolioResource.assertPublishable!(row, { auth, sb: fakeSb(posterAlt) });
      } catch {
        passes = false;
      }
      expect(allMet, name).toBe(passes);
    });
  }

  it('says how many are left', () => {
    expect(requirementsSummary(publishRequirements(good, { alt }))).toBe('Ready to publish.');
    expect(requirementsSummary(publishRequirements({}, null))).toBe(
      '4 things to do before it can be published.',
    );
    expect(placeholderFigure([{ value: '+xx%' }])).toBe(true);
  });
});

describe('the Projects list (model.ts)', () => {
  const rows: Row[] = [
    {
      id: 'a',
      title: { en: 'Desert film', ar: 'فيلم الصحراء' },
      project_type: { en: 'Brand film', ar: 'فيلم' },
      is_featured: true,
      status: 'published',
      sector_id: 's1',
      sector_name: { en: 'Retail', ar: 'تجزئة' },
      client_id: 'c1',
      service_ids: ['v1', 'v2'],
    },
    {
      id: 'b',
      title: { en: 'Rebrand', ar: 'إعادة الهوية' },
      project_type: { en: 'Identity', ar: 'هوية' },
      is_featured: false,
      status: 'draft',
      sector_id: 's2',
      sector_name: { en: 'Banking', ar: 'بنوك' },
      client_id: 'c1',
      service_ids: [],
    },
    {
      id: 'c',
      title: { en: '', ar: 'مَشروع' },
      project_type: null,
      is_featured: false,
      status: 'archived',
      sector_id: null,
    },
  ] as unknown as Row[];

  it('searches the name and the type in both languages, folded', () => {
    expect(filterProjects(rows, 'desert', 'all').map((r) => r.id)).toEqual(['a']);
    expect(filterProjects(rows, 'IDENTITY', 'all').map((r) => r.id)).toEqual(['b']);
    expect(filterProjects(rows, 'الهويه', 'all').map((r) => r.id)).toEqual(['b']);
    expect(filterProjects(rows, 'مشروع', 'all').map((r) => r.id)).toEqual(['c']);
    expect(matchesQuery(rows[0]!, '   ')).toBe(true);
    expect(fold('أَحْمد')).toBe('احمد');
    // Arabic digits are never transformed (P-12).
    expect(fold('٠١٢ ۵۶۷')).toBe('٠١٢ ۵۶۷');
  });

  it('chips: All, Featured, each sector the projects carry by name, Hidden', () => {
    expect(projectChips(rows).map((c) => c.label)).toEqual([
      'All',
      'Featured',
      'Banking',
      'Retail',
      'Hidden',
    ]);
    expect(filterProjects(rows, '', 'featured').map((r) => r.id)).toEqual(['a']);
    expect(filterProjects(rows, '', 'hidden').map((r) => r.id)).toEqual(['b', 'c']);
    expect(filterProjects(rows, '', 'sector:s2').map((r) => r.id)).toEqual(['b']);
    expect(matchesChip(rows[0]!, 'unknown')).toBe(true);
  });

  it('names, pills and counts', () => {
    expect(rows.map(projectName)).toEqual(['Desert film', 'Rebrand', 'مَشروع']);
    expect(projectName({ id: 'x' } as Row)).toBe('Untitled project');
    expect(serviceNames(rows[0]!, new Map([['v1', 'Logo']]))).toEqual(['Logo']);
    expect(countBy(rows, 'client_id').get('c1')).toBe(2);
    expect([0, 1, 4].map(projectsCount)).toEqual(['No projects', '1 project', '4 projects']);
  });
});

describe('the pieces the two areas add to the kit', () => {
  it('a gallery tile is named by its kind and place', () => {
    expect(tileName({ kind: 'image' }, 0)).toBe('Image 1');
    expect(tileName({ kind: 'video' }, 2)).toBe('Video 3');
  });

  it('a quote’s consent, in words', () => {
    expect(consentState({ is_placeholder: true })).toEqual({ label: 'Sample', tone: 'gray' });
    expect(consentState({ consent_obtained_at: '2026-01-01' }).label).toBe('Consent recorded');
    expect(consentState({}).label).toBe('Needs consent');
  });

  it('a second form’s ids: the save’s f- errors move onto its prefix', () => {
    const errors = {
      byId: { 'f-title-en': 'Required', 'f-problems-0-problem-ar': 'Required' },
      summary: [
        { id: 'f-title-en', message: 'Case headline (English): Required' },
        { message: 'x' },
      ],
    };
    expect(withIdPrefix(errors, 'f')).toBe(errors);
    expect(withIdPrefix(errors, 'fc')).toEqual({
      byId: { 'fc-title-en': 'Required', 'fc-problems-0-problem-ar': 'Required' },
      summary: [
        { id: 'fc-title-en', message: 'Case headline (English): Required' },
        { message: 'x' },
      ],
    });
  });

  it('a disabled handle never drags (a read-only editor’s disabled fieldset, U8’s note)', () => {
    const el = (disabled: boolean, inFieldset: boolean, aria: string | null = null) =>
      ({
        disabled,
        closest: (sel: string) => (sel === 'fieldset[disabled]' && inFieldset ? {} : null),
        getAttribute: (name: string) => (name === 'aria-disabled' ? aria : null),
      }) as unknown as Element;
    expect(isDisabledControl(el(false, false))).toBe(false);
    expect(isDisabledControl(el(true, false))).toBe(true);
    expect(isDisabledControl(el(false, true))).toBe(true);
    expect(isDisabledControl(el(false, false, 'true'))).toBe(true);
  });
});
