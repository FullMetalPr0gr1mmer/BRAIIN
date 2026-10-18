import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext, Role } from '@/lib/auth/types';

// One made-up tenant covering every fence the preview's anon-RLS mirror copies (Admin v2
// R8), and a fake staff client that serves it the way PostgREST would to a staff token
// (every row of the tenant, whatever its status), paged by `range()` under a `max_rows`
// cap, with an exact count. Made-up content only: the repository is public.
//
// What a visitor would see of it (the mirror's expectations, written by hand from the
// policies in supabase/migrations, never from the code under test) sits next to each row.

type Row = Record<string, unknown>;

/** A fixture uuid: `id(12)` → 00000000-0000-4000-8000-000000000012. */
export const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const TENANT = '0a000000-0000-4000-8000-00000000000a';
export const OTHER_TENANT = '0b000000-0000-4000-8000-00000000000b';

const BI = (en: string, ar: string) => ({ en, ar });
const T = (row: Row): Row => ({ tenant_id: TENANT, ...row });

/** Named ids, so a test reads `ID.sPub` rather than a number. */
export const ID = {
  // media
  mPoster: id(101),
  mDraftPoster: id(102),
  mFrame: id(103),
  mDraftFrame: id(104),
  mLogo: id(105),
  mHiddenLogo: id(106),
  mAvatar: id(107),
  mDraftAvatar: id(108),
  mPortrait: id(109),
  mSection: id(110),
  mHiddenSection: id(111),
  mDraftSection: id(112),
  mDiscPoster: id(113),
  mSvcPoster: id(114),
  mSvcHiddenPoster: id(115),
  mExternal: id(116),
  mUnref: id(117),
  mLockedSection: id(118),
  // disciplines, services, cases
  dPub: id(201),
  dDraft: id(202),
  sPub: id(211),
  sNoDisc: id(212),
  sHiddenByDisc: id(213),
  sDraft: id(214),
  cPub: id(221),
  cOfDraftService: id(222),
  cOfHiddenService: id(223),
  cDraft: id(224),
  // our work
  secVis: id(301),
  secHidden: id(302),
  clVis: id(311),
  clHidden: id(312),
  pPub: id(321),
  pDraft: id(322),
  pPub2: id(323),
  pmPub: id(331),
  pmDraft: id(332),
  tPub: id(341),
  tDraft: id(342),
  // people, numbers, blog
  tmPub: id(401),
  tmDraft: id(402),
  stPub: id(411),
  stDraft: id(412),
  cePub: id(421),
  ceDraft: id(422),
  cat1: id(431),
  bPub: id(441),
  bUndated: id(442),
  bOld: id(443),
  bDraft: id(444),
  // the FAQ (Admin v2 U7)
  fqPub: id(461),
  fqDraft: id(462),
  // pages, sections, menus
  pgHome: id(501),
  pgDraft: id(502),
  pgLocked: id(503),
  psVis: id(511),
  psHidden: id(512),
  psOfDraft: id(513),
  psLocked: id(514),
  pvLocked: id(531),
  pvHome: id(532),
  nVis: id(521),
  nHidden: id(522),
  nChild: id(523),
  nGrandchild: id(524),
  // SEO
  esSvc: id(601),
  esSvcDraft: id(602),
  esSvcHidden: id(603),
  esBlog: id(604),
  esProject: id(605),
  esPage: id(606),
  esPageDraft: id(607),
  esOrphan: id(608),
  // another tenant
  foreign: id(901),
} as const;

const media = (mid: string, provider = 'static'): Row =>
  T({
    id: mid,
    kind: 'image',
    provider,
    storage_path:
      provider === 'external' ? 'https://example.test/a.webp' : `fixture-${mid.slice(-3)}`,
    width: 800,
    height: 600,
    alt: BI('An image', 'صورة'),
    stream_uid: null,
    mime_type: 'image/webp',
    updated_at: '2026-01-01T00:00:00+00:00',
  });

const service = (
  sid: string,
  slug: string,
  status: string,
  disciplineId: string | null,
  extra: Row = {},
): Row =>
  T({
    id: sid,
    slug,
    title: BI(slug, slug),
    short_title: null,
    blurb: null,
    body: null,
    body_html: null,
    hero_video_uid: null,
    category: null,
    status,
    is_teaser: false,
    sort_order: 0,
    updated_at: '2026-01-01T00:00:00+00:00',
    published_at: status === 'published' ? '2026-01-01T00:00:00+00:00' : null,
    discipline_id: disciplineId,
    intro: null,
    value_points: [],
    deliverables: [],
    poster_media_id: null,
    preview_video_path: null,
    preview_start_s: null,
    preview_end_s: null,
    ...extra,
  });

const project = (pid: string, slug: string, status: string, extra: Row = {}): Row =>
  T({
    id: pid,
    slug,
    title: BI(slug, slug),
    project_type: null,
    teaser: null,
    summary: null,
    body: null,
    year: 2026,
    is_featured: false,
    sort_order: 0,
    status,
    updated_at: '2026-01-01T00:00:00+00:00',
    published_at: status === 'published' ? '2026-01-01T00:00:00+00:00' : null,
    preview_video_uid: null,
    preview_video_path: null,
    preview_start_s: null,
    preview_end_s: null,
    client_id: null,
    sector_id: null,
    poster_media_id: null,
    lead: null,
    goal: null,
    result: null,
    scope: [],
    keywords: [],
    results: [],
    next_portfolio_id: null,
    is_placeholder: false,
    ...extra,
  });

const seo = (eid: string, entityType: string, entityId: string): Row =>
  T({
    id: eid,
    entity_type: entityType,
    entity_id: entityId,
    meta_title: BI(`Title ${eid.slice(-3)}`, 'عنوان'),
    meta_description: BI('Description', 'وصف'),
    og_image: null,
    canonical_override: null,
    robots: null,
    schema_type: null,
  });

/** The fixture tenant's rows, as a staff token reads them (and one foreign row). */
export function fixtureTables(): Record<string, Row[]> {
  return {
    media_assets: [
      media(ID.mPoster), // pPub's poster: visible
      media(ID.mDraftPoster), // pDraft's poster only: hidden
      media(ID.mFrame), // pPub's gallery frame: visible
      media(ID.mDraftFrame), // pDraft's frame only: hidden
      media(ID.mLogo), // clVis's logo: visible
      media(ID.mHiddenLogo), // clHidden's logo: hidden
      media(ID.mAvatar), // tPub's avatar: visible
      media(ID.mDraftAvatar), // tDraft's avatar: hidden
      media(ID.mPortrait), // tmPub's portrait: visible
      media(ID.mSection), // nested mediaId in a visible section of a published page: visible
      media(ID.mHiddenSection), // only in a hidden section: hidden
      media(ID.mDraftSection), // only in a section of a draft page: hidden
      media(ID.mDiscPoster), // dPub's poster: visible
      media(ID.mSvcPoster), // sPub's poster: visible
      media(ID.mSvcHiddenPoster), // sHiddenByDisc's poster (service hidden by its discipline): hidden
      media(ID.mExternal, 'external'), // pPub2's poster, but not a hosted provider: hidden
      media(ID.mUnref), // referenced by nothing: hidden
      media(ID.mLockedSection), // only in a section of a page behind a password: hidden (0061)
    ],
    disciplines: [
      T({
        id: ID.dPub,
        slug: 'branding',
        name: BI('Branding', 'الهوية'),
        short: null,
        blurb: null,
        poster_media_id: ID.mDiscPoster,
        preview_video_path: null,
        preview_start_s: null,
        preview_end_s: null,
        status: 'published',
        sort_order: 1,
        published_at: '2026-01-01T00:00:00+00:00',
        updated_at: '2026-01-01T00:00:00+00:00',
      }),
      T({
        id: ID.dDraft,
        slug: 'events',
        name: BI('Events', 'الفعاليات'),
        short: null,
        blurb: null,
        poster_media_id: null,
        preview_video_path: null,
        preview_start_s: null,
        preview_end_s: null,
        status: 'draft',
        sort_order: 2,
        published_at: null,
        updated_at: '2026-01-01T00:00:00+00:00',
      }),
    ],
    services: [
      service(ID.sPub, 'logo', 'published', ID.dPub, {
        sort_order: 1,
        poster_media_id: ID.mSvcPoster,
      }), // visible
      service(ID.sNoDisc, 'hosting', 'published', null, { sort_order: 2 }), // visible (no discipline)
      service(ID.sHiddenByDisc, 'venue', 'published', ID.dDraft, {
        sort_order: 3,
        poster_media_id: ID.mSvcHiddenPoster,
      }), // hidden by its discipline
      service(ID.sDraft, 'packaging', 'draft', ID.dPub, { sort_order: 4 }), // hidden
    ],
    service_cases: [
      T({
        id: ID.cPub,
        service_id: ID.sPub,
        portfolio_id: ID.pPub,
        title: BI('Case', 'حالة'),
        context: null,
        problems: [],
        results: [],
        status: 'published',
        published_at: '2026-01-01T00:00:00+00:00',
        updated_at: '2026-01-01T00:00:00+00:00',
      }), // visible
      T({
        id: ID.cOfDraftService,
        service_id: ID.sDraft,
        portfolio_id: null,
        title: BI('C2', 'ح'),
        context: null,
        problems: [],
        results: [],
        status: 'published',
        published_at: null,
        updated_at: '2026-01-01T00:00:00+00:00',
      }), // hidden: service draft
      T({
        id: ID.cOfHiddenService,
        service_id: ID.sHiddenByDisc,
        portfolio_id: null,
        title: BI('C3', 'ح'),
        context: null,
        problems: [],
        results: [],
        status: 'published',
        published_at: null,
        updated_at: '2026-01-01T00:00:00+00:00',
      }), // hidden: service hidden by its discipline
      T({
        id: ID.cDraft,
        service_id: ID.sNoDisc,
        portfolio_id: null,
        title: BI('C4', 'ح'),
        context: null,
        problems: [],
        results: [],
        status: 'draft',
        published_at: null,
        updated_at: '2026-01-01T00:00:00+00:00',
      }), // hidden: draft
    ],
    sectors: [
      T({
        id: ID.secVis,
        slug: 'retail',
        name: BI('Retail', 'التجزئة'),
        visible: true,
        sort_order: 1,
        updated_at: '2026-01-01T00:00:00+00:00',
      }),
      T({
        id: ID.secHidden,
        slug: 'secret',
        name: BI('Secret', 'سري'),
        visible: false,
        sort_order: 2,
        updated_at: '2026-01-01T00:00:00+00:00',
      }),
    ],
    clients: [
      T({
        id: ID.clVis,
        slug: 'acme',
        name: BI('Acme', 'أكمي'),
        logo_media_id: ID.mLogo,
        website_url: null,
        show_in_marquee: true,
        visible: true,
        is_placeholder: false,
        sort_order: 1,
      }),
      T({
        id: ID.clHidden,
        slug: 'hush',
        name: BI('Hush', 'هش'),
        logo_media_id: ID.mHiddenLogo,
        website_url: null,
        show_in_marquee: true,
        visible: false,
        is_placeholder: false,
        sort_order: 2,
      }),
    ],
    portfolio: [
      project(ID.pPub, 'launch', 'published', {
        sort_order: 1,
        sector_id: ID.secVis,
        client_id: ID.clHidden,
        poster_media_id: ID.mPoster,
      }), // visible; client confidential
      project(ID.pDraft, 'secret-project', 'draft', {
        sort_order: 2,
        poster_media_id: ID.mDraftPoster,
      }), // hidden
      project(ID.pPub2, 'film', 'published', {
        sort_order: 0,
        client_id: ID.clVis,
        is_featured: true,
        poster_media_id: ID.mExternal,
      }), // visible
    ],
    portfolio_services: [
      T({ portfolio_id: ID.pPub, service_id: ID.sPub, sort_order: 0 }), // visible, embeds sPub
      T({ portfolio_id: ID.pPub, service_id: ID.sDraft, sort_order: 1 }), // visible link, embeds null
      T({ portfolio_id: ID.pDraft, service_id: ID.sPub, sort_order: 0 }), // hidden (draft project)
    ],
    portfolio_media: [
      T({
        id: ID.pmPub,
        portfolio_id: ID.pPub,
        role: 'gallery',
        kind: 'image',
        media_id: ID.mFrame,
        video_uid: null,
        video_path: null,
        clip_start_s: null,
        clip_end_s: null,
        duration_label: null,
        caption: BI('Frame', 'إطار'),
        breakdown_kind: null,
        layout: null,
        sort_order: 0,
      }),
      T({
        id: ID.pmDraft,
        portfolio_id: ID.pDraft,
        role: 'gallery',
        kind: 'image',
        media_id: ID.mDraftFrame,
        video_uid: null,
        video_path: null,
        clip_start_s: null,
        clip_end_s: null,
        duration_label: null,
        caption: null,
        breakdown_kind: null,
        layout: null,
        sort_order: 0,
      }),
    ],
    testimonials: [
      T({
        id: ID.tPub,
        slug: 'quote-a',
        quote: BI('Great', 'رائع'),
        author_name: BI('Sam', 'سام'),
        author_role: null,
        client_id: ID.clVis,
        portfolio_id: ID.pPub,
        avatar_media_id: ID.mAvatar,
        placements: ['home'],
        status: 'published',
        sort_order: 1,
        published_at: '2026-01-01T00:00:00+00:00',
        updated_at: '2026-01-01T00:00:00+00:00',
      }),
      T({
        id: ID.tDraft,
        slug: 'quote-b',
        quote: BI('Draft', 'مسودة'),
        author_name: BI('Kim', 'كيم'),
        author_role: null,
        client_id: null,
        portfolio_id: null,
        avatar_media_id: ID.mDraftAvatar,
        placements: ['home'],
        status: 'draft',
        sort_order: 2,
        published_at: null,
        updated_at: '2026-01-01T00:00:00+00:00',
      }),
    ],
    team_members: [
      T({
        id: ID.tmPub,
        slug: 'nora',
        name: BI('Nora', 'نورة'),
        bio: null,
        avatar_url: null,
        sort_order: 1,
        role: BI('Lead', 'قائدة'),
        linkedin_url: null,
        is_leadership: true,
        is_placeholder: false,
        portrait_media_id: ID.mPortrait,
        status: 'published',
      }),
      T({
        id: ID.tmDraft,
        slug: 'omar',
        name: BI('Omar', 'عمر'),
        bio: null,
        avatar_url: null,
        sort_order: 2,
        role: null,
        linkedin_url: null,
        is_leadership: false,
        is_placeholder: false,
        portrait_media_id: null,
        status: 'draft',
      }),
    ],
    statistics: [
      T({
        id: ID.stPub,
        slug: 'projects',
        label: BI('Projects', 'مشاريع'),
        value: '150+',
        sort_order: 1,
        value_numeric: 150,
        value_suffix: '+',
        placements: ['home', 'about'],
        placement_labels: {},
        status: 'published',
      }),
      T({
        id: ID.stDraft,
        slug: 'clients',
        label: BI('Clients', 'عملاء'),
        value: '40',
        sort_order: 2,
        value_numeric: 40,
        value_suffix: null,
        placements: ['home'],
        placement_labels: {},
        status: 'draft',
      }),
    ],
    certifications: [
      T({
        id: ID.cePub,
        slug: 'iso',
        name: BI('ISO', 'أيزو'),
        issuer: null,
        year: 2025,
        logo_url: null,
        sort_order: 1,
        status: 'published',
      }),
      T({
        id: ID.ceDraft,
        slug: 'award',
        name: BI('Award', 'جائزة'),
        issuer: null,
        year: 2026,
        logo_url: null,
        sort_order: 2,
        status: 'draft',
      }),
    ],
    faq_items: [
      T({
        id: ID.fqPub,
        question: BI('Who owns the work?', 'لمن الشغل؟'),
        answer: BI('You do.', 'لك.'),
        sort_order: 10,
        status: 'published',
      }),
      T({
        id: ID.fqDraft,
        question: BI('Draft?', 'مسودة؟'),
        answer: BI('Not yet.', 'ليس بعد.'),
        sort_order: 20,
        status: 'draft',
      }),
    ],
    categories: [T({ id: ID.cat1, slug: 'craft', name: BI('Craft', 'حرفة') })],
    blog_posts: [
      T({
        id: ID.bPub,
        slug: 'new',
        title: BI('New', 'جديد'),
        excerpt: null,
        body_html: null,
        cover_image_url: null,
        published_at: '2026-01-02T10:00:00+00:00',
        updated_at: '2026-01-02T10:00:00+00:00',
        reading_minutes: 3,
        author_id: ID.tmPub,
        category_id: ID.cat1,
        status: 'published',
      }),
      T({
        id: ID.bUndated,
        slug: 'undated',
        title: BI('Undated', 'بلا تاريخ'),
        excerpt: null,
        body_html: null,
        cover_image_url: null,
        published_at: null,
        updated_at: null,
        reading_minutes: null,
        author_id: ID.tmPub,
        category_id: null,
        status: 'published',
      }),
      T({
        id: ID.bOld,
        slug: 'old',
        title: BI('Old', 'قديم'),
        excerpt: null,
        body_html: null,
        cover_image_url: null,
        published_at: '2025-12-01T10:00:00+03:00',
        updated_at: null,
        reading_minutes: 2,
        author_id: ID.tmDraft,
        category_id: ID.cat1,
        status: 'published',
      }),
      T({
        id: ID.bDraft,
        slug: 'draft-post',
        title: BI('Draft', 'مسودة'),
        excerpt: null,
        body_html: null,
        cover_image_url: null,
        published_at: null,
        updated_at: null,
        reading_minutes: null,
        author_id: ID.tmPub,
        category_id: ID.cat1,
        status: 'draft',
      }),
    ],
    pages: [
      T({
        id: ID.pgHome,
        slug: 'home',
        title: BI('Home', 'الرئيسية'),
        status: 'published',
        nav_visible: true,
        updated_at: '2026-01-01T00:00:00+00:00',
        published_at: '2026-01-01T00:00:00+00:00',
      }),
      T({
        id: ID.pgDraft,
        slug: 'about',
        title: BI('About', 'من نحن'),
        status: 'draft',
        nav_visible: true,
        updated_at: '2026-01-01T00:00:00+00:00',
        published_at: null,
      }),
      // Published, behind a password (page_visibility below): the page row is public, its
      // sections are not (0061 page_sections_password_fence).
      T({
        id: ID.pgLocked,
        slug: 'join',
        title: BI('Join', 'انضم'),
        status: 'published',
        nav_visible: true,
        updated_at: '2026-01-01T00:00:00+00:00',
        published_at: '2026-01-01T00:00:00+00:00',
      }),
    ],
    // Staff read it (0057); anon never. The mirror reads it for the fence alone.
    page_visibility: [
      T({ id: ID.pvLocked, page_id: ID.pgLocked, template: null, mode: 'password' }),
      T({ id: ID.pvHome, page_id: ID.pgHome, template: null, mode: 'public' }),
    ],
    page_sections: [
      T({
        id: ID.psVis,
        page_id: ID.pgHome,
        type: 'cta',
        content: { frames: [{ image: { mediaId: ID.mSection } }] },
        visible: true,
        sort_order: 1,
      }),
      T({
        id: ID.psHidden,
        page_id: ID.pgHome,
        type: 'cta',
        content: { mediaId: ID.mHiddenSection },
        visible: false,
        sort_order: 2,
      }),
      T({
        id: ID.psOfDraft,
        page_id: ID.pgDraft,
        type: 'cta',
        content: { mediaId: ID.mDraftSection },
        visible: true,
        sort_order: 1,
      }),
      T({
        id: ID.psLocked,
        page_id: ID.pgLocked,
        type: 'cta',
        content: { mediaId: ID.mLockedSection },
        visible: true,
        sort_order: 1,
      }),
    ],
    navigation: [
      T({
        id: ID.nVis,
        location: 'header',
        parent_id: null,
        label: BI('Work', 'أعمالنا'),
        href: '/portfolio',
        sort_order: 1,
        is_key: true,
        visible: true,
      }),
      T({
        id: ID.nHidden,
        location: 'header',
        parent_id: null,
        label: BI('Soon', 'قريبا'),
        href: '/soon',
        sort_order: 2,
        is_key: false,
        visible: false,
      }),
      T({
        id: ID.nChild,
        location: 'header',
        parent_id: ID.nVis,
        label: BI('All', 'الكل'),
        href: '/portfolio/all',
        sort_order: 1,
        is_key: false,
        visible: true,
      }),
      // A third level: a pending delete of the top link takes it too (0009's cascade).
      T({
        id: ID.nGrandchild,
        location: 'header',
        parent_id: ID.nChild,
        label: BI('Archive', 'الأرشيف'),
        href: '/portfolio/all#archive',
        sort_order: 1,
        is_key: false,
        visible: true,
      }),
    ],
    site_profile: [
      {
        tenant_id: TENANT,
        brand_name: BI('Fixture Studio', 'استوديو'),
        legal_name: null,
        contact_email: 'hello@example.test',
        whatsapp_e164: null,
        whatsapp_display: null,
        location: BI('Riyadh', 'الرياض'),
        address_locality: null,
        address_country: 'SA',
        founded_year: 2020,
        socials: [],
        accepting_applications: false,
        updated_at: '2026-01-01T00:00:00+00:00',
      },
    ],
    seo_defaults: [
      {
        tenant_id: TENANT,
        title_template: BI('%s | %brand%', '%s | %brand%'),
        default_title: BI('Studio', 'استوديو'),
        default_description: BI('We make things.', 'نصنع الأشياء.'),
        default_og_image: null,
        organization: {},
        robots_directives: 'index,follow',
      },
    ],
    entity_seo: [
      seo(ID.esSvc, 'service', ID.sPub), // visible
      seo(ID.esSvcDraft, 'service', ID.sDraft), // hidden: draft parent
      seo(ID.esSvcHidden, 'service', ID.sHiddenByDisc), // hidden: parent hidden by its discipline
      seo(ID.esBlog, 'blog_post', ID.bPub), // visible
      seo(ID.esProject, 'portfolio', ID.pPub), // visible
      seo(ID.esPage, 'page', ID.pgHome), // visible
      seo(ID.esPageDraft, 'page', ID.pgDraft), // hidden
      seo(ID.esOrphan, 'service', id(999)), // hidden: orphan
    ],
  };
}

/** The ids a visitor reads, per table (hand-written from the policies). */
export const VISIBLE: Readonly<Record<string, readonly string[]>> = {
  media_assets: [
    ID.mPoster,
    ID.mFrame,
    ID.mLogo,
    ID.mAvatar,
    ID.mPortrait,
    ID.mSection,
    ID.mDiscPoster,
    ID.mSvcPoster,
  ],
  disciplines: [ID.dPub],
  services: [ID.sPub, ID.sNoDisc],
  service_cases: [ID.cPub],
  sectors: [ID.secVis],
  clients: [ID.clVis],
  portfolio: [ID.pPub, ID.pPub2],
  portfolio_media: [ID.pmPub],
  testimonials: [ID.tPub],
  team_members: [ID.tmPub],
  statistics: [ID.stPub],
  certifications: [ID.cePub],
  faq_items: [ID.fqPub],
  categories: [ID.cat1],
  blog_posts: [ID.bPub, ID.bUndated, ID.bOld],
  pages: [ID.pgHome, ID.pgLocked],
  page_sections: [ID.psVis],
  navigation: [ID.nVis, ID.nChild, ID.nGrandchild],
  entity_seo: [ID.esSvc, ID.esBlog, ID.esProject, ID.esPage],
};

// ---- a fake staff client -------------------------------------------------------------------

export interface FakeClientOptions {
  /** Supabase's max_rows: the most rows one response carries (default 1000). */
  maxRows?: number;
  /** Tables whose read fails, with the error a staff token would get. */
  fail?: Readonly<Record<string, { code: string; message: string }>>;
  /** Tables whose count is a lie (rows really there differ), for the cap tests. */
  countOverride?: Readonly<Record<string, number>>;
}

export interface FakeClient {
  client: SupabaseClient;
  /** One line per request: `table range(from,to)`. */
  calls: string[];
  /** The select lists and options asked for, per table. */
  selects: Record<string, { columns: string; options: unknown }[]>;
}

/** A staff client over `tables`: from().select(cols, {count}).order(...).range(a, b). */
export function fakeStaffClient(
  tables: Record<string, Row[]>,
  opts: FakeClientOptions = {},
): FakeClient {
  const calls: string[] = [];
  const selects: FakeClient['selects'] = {};
  const maxRows = opts.maxRows ?? 1000;
  const client = {
    from(table: string) {
      let columns = '*';
      const orders: string[] = [];
      const b = {
        select(cols: string, options: unknown) {
          columns = cols;
          (selects[table] ??= []).push({ columns: cols, options });
          return b;
        },
        order(column: string) {
          orders.push(column);
          return b;
        },
        range(from: number, to: number) {
          calls.push(`${table} range(${from},${to})`);
          const failure = opts.fail?.[table];
          if (failure) return Promise.resolve({ data: null, error: failure, count: null });
          const all = [...(tables[table] ?? [])].sort((x, y) => {
            for (const key of orders) {
              const a = String(x[key]);
              const c = String(y[key]);
              if (a !== c) return a < c ? -1 : 1;
            }
            return 0;
          });
          const wanted = columns === '*' ? null : columns.split(',');
          const rows = all
            .slice(from, Math.min(to + 1, from + maxRows))
            .map((row) =>
              wanted ? Object.fromEntries(wanted.map((c) => [c, row[c] ?? null])) : { ...row },
            );
          return Promise.resolve({
            data: rows,
            error: null,
            count: opts.countOverride?.[table] ?? all.length,
          });
        },
      };
      return b;
    },
  };
  return { client: client as unknown as SupabaseClient, calls, selects };
}

/** A session of the fixture tenant. */
export function session(role: Role, extra: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: id(1),
    tenantId: TENANT,
    role,
    isActive: true,
    email: 'staff@example.test',
    ...extra,
  };
}

let draftSeq = 0;
/** A content_drafts row of the fixture tenant. */
export function draft(
  entityType: string,
  op: 'create' | 'update' | 'delete',
  entityId: string,
  payload: Row = {},
  extra: Row = {},
): Row {
  draftSeq += 1;
  return {
    id: `0d000000-0000-4000-8000-${String(draftSeq).padStart(12, '0')}`,
    tenant_id: TENANT,
    entity_type: entityType,
    entity_id: entityId,
    op,
    payload,
    version: 1,
    release_id: null,
    updated_at: new Date(Date.UTC(2026, 1, 1) + draftSeq * 1000).toISOString(),
    ...extra,
  };
}

export { BI };
