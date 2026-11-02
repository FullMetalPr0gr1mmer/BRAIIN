import {
  CaseStudyRowSchema,
  PortfolioCardRowSchema,
  PUBLIC_MEDIA_COLUMNS,
  type CaseStudyRow,
  type LocalizedProse,
  type LocalizedText,
  type PortfolioCardRow,
  type PortfolioMediaRow,
  type ResultCard,
} from '@schemas/content';
import type { VideoClip } from '@schemas/media';
import { supabaseConfigured } from '@/lib/supabase/client';
import { renderArticle } from '@/lib/content/tiptap';
import { clipOf, imageRef, type ImageRef } from '@/lib/media/resolve';
import { describable } from '@/lib/portfolio/caseStudy';
import { mapRows, parseRows, reportBodyRefused, reportLoadError } from './parse';
import { contentClient } from './source';

// Runtime data access for the public portfolio / case studies (Tier A SSR). Tenant +
// published filtering are enforced by RLS; we still pass status explicitly. Shape lives in
// `packages/schemas/content.ts` (CLAUDE.md §8). Resilient: []/null on any error.
//
//   getPortfolioCards    Our Work, All projects, home Selected work, the case study's
//                        "Next project"
//   getCaseStudy         the case study (/portfolio/[slug], PR11)
//   getCaseStudyIndex    the sitemap and llms.txt
// getCaseStudy and getCaseStudyIndex share ONE select (CASE_STUDY_COLUMNS) and ONE
// row→model path (parseCaseStudies), so neither discovery file can list a URL the page
// would answer 404 for (tests/lib/portfolioLoader.spec.ts asserts the pairing).

// ── UI v2 ──────────────────────────────────────────────────────────────────────

const MEDIA = `(${PUBLIC_MEDIA_COLUMNS})`;

// Embeds go through each FK column (`poster_media_id(...)`), so an embed can never pick
// the wrong relationship. Every embedded row passes anon's own RLS: a hidden client or an
// unpublished service comes back null — which is how "Confidential client" is detected.
export const CARD_COLUMNS =
  'id,slug,title,project_type,teaser,summary,year,is_featured,sort_order,updated_at,' +
  'preview_video_uid,preview_video_path,preview_start_s,preview_end_s,client_id,' +
  `poster:poster_media_id${MEDIA},sector:sector_id(slug,name,sort_order),` +
  'client:client_id(slug,name,sort_order),' +
  'services:portfolio_services(sort_order,service:service_id(slug,title,short_title,sort_order))';

// `body` (the Tiptap JSON), deliberately NOT `body_html`: the cache is written by the
// admin API, but the database also accepts it from a direct PostgREST / save_portfolio
// write that skips that API, so the public page never emits it (see renderBody).
export const CASE_STUDY_COLUMNS =
  `${CARD_COLUMNS},body,lead,goal,result,scope,keywords,results,next_portfolio_id,` +
  'media:portfolio_media(role,kind,video_uid,video_path,clip_start_s,clip_end_s,' +
  `duration_label,caption,breakdown_kind,layout,sort_order,asset:media_id${MEDIA})`;

export interface FacetValue {
  slug: string;
  name: LocalizedText;
  /** Where the value sorts among its facet's options (the entity's sort_order). */
  order: number;
}

export interface PortfolioCard {
  id: string;
  slug: string;
  title: LocalizedText;
  projectType: LocalizedText | null;
  /** The card blurb: the teaser, else the summary. */
  blurb: LocalizedText | LocalizedProse | null;
  year: number | null;
  isFeatured: boolean;
  sortOrder: number;
  updatedAt: string | null;
  poster: ImageRef | null;
  /** The hover loop (EXC-009 window of the showreel until Stream). */
  preview: VideoClip | null;
  sector: FacetValue | null;
  /** null with `confidentialClient` = a client we may not name (hidden by RLS). */
  client: FacetValue | null;
  confidentialClient: boolean;
  /** In the editor's order. `label` is the chip text (short title where one exists). */
  services: { slug: string; title: LocalizedText; label: LocalizedText; order: number }[];
}

export interface CaseMedia {
  kind: 'image' | 'video';
  image: ImageRef | null;
  clip: VideoClip | null;
  durationLabel: string | null;
  caption: LocalizedText | null;
  breakdownKind: 'sketch' | 'bts' | 'process' | null;
  layout: 'half' | 'wide' | 'third' | null;
}

export interface CaseStudy extends PortfolioCard {
  summary: LocalizedProse | null;
  /** Allowlist-rendered from the Tiptap source on every render (renderBody). */
  bodyHtml: LocalizedProse | null;
  lead: LocalizedText | null;
  goal: LocalizedText | null;
  result: LocalizedText | null;
  scope: LocalizedText[];
  keywords: LocalizedText[];
  results: ResultCard[];
  nextPortfolioId: string | null;
  hero: CaseMedia | null;
  final: CaseMedia | null;
  breakdown: CaseMedia[];
  gallery: CaseMedia[];
}

export function toCard(row: PortfolioCardRow): PortfolioCard {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    projectType: row.project_type,
    blurb: row.teaser ?? row.summary,
    year: row.year,
    isFeatured: row.is_featured,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
    poster: imageRef(row.poster),
    preview: clipOf({
      uid: row.preview_video_uid,
      path: row.preview_video_path,
      startS: row.preview_start_s,
      endS: row.preview_end_s,
    }),
    sector: row.sector && {
      slug: row.sector.slug,
      name: row.sector.name,
      order: row.sector.sort_order,
    },
    client: row.client && {
      slug: row.client.slug,
      name: row.client.name,
      order: row.client.sort_order,
    },
    confidentialClient: row.client_id !== null && row.client === null,
    services: [...row.services]
      .sort((a, b) => a.sort_order - b.sort_order)
      .flatMap(({ service }) =>
        service
          ? [
              {
                slug: service.slug,
                title: service.title,
                label: service.short_title ?? service.title,
                order: service.sort_order,
              },
            ]
          : [],
      ),
  };
}

function toCaseMedia(row: PortfolioMediaRow): CaseMedia {
  return {
    kind: row.kind,
    image: imageRef(row.asset),
    clip:
      row.kind === 'video'
        ? clipOf({
            uid: row.video_uid,
            path: row.video_path,
            startS: row.clip_start_s,
            endS: row.clip_end_s,
          })
        : null,
    durationLabel: row.duration_label,
    caption: row.caption,
    breakdownKind: row.breakdown_kind,
    layout: row.layout,
  };
}

/** Whose body is rendered: what a refused body is logged under (H15 code review, CR1). */
export interface BodySubject {
  entity: string;
  id: string;
}

/**
 * One language of a STORED article body, rendered by the allowlist renderer; '' when the language
 * holds nothing. A body the renderer refuses (or whose render threw) renders nothing and is
 * logged once, under its entity and id, never its content (`reportBodyRefused`, CR1).
 */
export function renderStoredDoc(doc: unknown, lang: 'en' | 'ar', subject: BodySubject): string {
  if (doc === undefined || doc === null) return '';
  const { html, refused } = renderArticle(doc);
  if (refused !== null) reportBodyRefused(subject.entity, subject.id, lang, refused);
  return html;
}

/**
 * The body as HTML, rendered HERE from its Tiptap JSON by the allowlist renderer
 * (src/lib/content/tiptap.ts) — CLAUDE.md Pillar 1: "Tiptap sanitised on write AND
 * render; never `set:html` unsanitised". The stored `body_html` cache is not trusted on
 * the public path: a caller holding portfolio.write can set it directly (PostgREST PATCH
 * or rpc/save_portfolio), skipping the admin API that derives it, and the edge would then
 * cache whatever markup they wrote. The renderer can only emit the tags and attributes
 * written literally in it. The cost lands on an edge-cache miss only (Security > Perf).
 *
 * Never throws (H15): the renderer is the one guard (`renderArticle`), and it answers '' for
 * anything it cannot read; the row's schema hands this plain data, so reading it cannot throw
 * either (CR8: the catch that stood here could never fire).
 */
export function renderBody(
  body: CaseStudyRow['body'],
  subject: BodySubject,
): LocalizedProse | null {
  const en = renderStoredDoc(body?.en, 'en', subject);
  const ar = renderStoredDoc(body?.ar, 'ar', subject);
  if (!en && !ar) return null;
  return ar ? { en, ar } : { en };
}

/** What a case study is mapped for: the page renders its body; the discovery index does not. */
interface CaseStudyUse {
  body: boolean;
}

const FOR_PAGE: CaseStudyUse = { body: true };

export function toCaseStudy(row: CaseStudyRow, use: CaseStudyUse = FOR_PAGE): CaseStudy {
  const byRole = (role: PortfolioMediaRow['role']) =>
    row.media
      .filter((m) => m.role === role)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(toCaseMedia);
  // A gallery or breakdown still is CONTENT on this page: one that no longer resolves, or
  // that cannot be described in both languages (no caption, no bilingual alt), is dropped
  // rather than rendered as an empty frame or with alt="". Hero/final keep their clip even
  // when the poster is missing.
  const images = (items: CaseMedia[]) => items.filter(describable);
  return {
    ...toCard(row),
    summary: row.summary,
    bodyHtml: use.body ? renderBody(row.body, { entity: 'portfolio', id: row.id }) : null,
    lead: row.lead,
    goal: row.goal,
    result: row.result,
    scope: row.scope,
    keywords: row.keywords,
    results: row.results,
    nextPortfolioId: row.next_portfolio_id,
    hero: byRole('hero')[0] ?? null,
    final: byRole('final')[0] ?? null,
    breakdown: images(byRole('breakdown')),
    gallery: images(byRole('gallery')),
  };
}

/** Published project cards, in catalogue order (sort_order). */
export async function getPortfolioCards(
  opts: { featuredOnly?: boolean } = {},
): Promise<PortfolioCard[]> {
  if (!supabaseConfigured()) return [];
  try {
    let query = contentClient()
      .from('portfolio')
      .select(CARD_COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });
    if (opts.featuredOnly) query = query.eq('is_featured', true);
    const { data, error } = await query;
    if (error) {
      reportLoadError('portfolio_cards', error);
      return [];
    }
    return parseRows(PortfolioCardRowSchema, data ?? [], 'portfolio').map(toCard);
  } catch (err) {
    reportLoadError('portfolio_cards', err);
    return [];
  }
}

/**
 * THE row → case-study path, shared by the page and the discovery index: whatever it
 * rejects (and logs) is a 404 on the page AND absent from the sitemap and llms.txt.
 *
 * Each row is mapped inside its own guard (H15, `mapRows`): a row that cannot be mapped is
 * dropped and logged, never the whole list (a stored body that threw used to empty the index,
 * so every case study left the sitemap and llms.txt). The body can no longer throw (its one
 * guard is the renderer's); the guard stays here, and only here, because this is a LIST: one
 * row's failure would otherwise cost every project its sitemap entry (H15 code review, CR8; the
 * service and blog pages map their one row as it is). The index maps without the body
 * (`use.body` false): it never shows it, and rendering every project's body cost CPU on each
 * sitemap miss. Which rows survive does not depend on it, since renderBody never throws.
 */
export function parseCaseStudies(rows: unknown[], use: CaseStudyUse = FOR_PAGE): CaseStudy[] {
  return mapRows(
    parseRows(CaseStudyRowSchema, rows, 'portfolio'),
    (row) => toCaseStudy(row, use),
    'portfolio',
  );
}

export interface CaseStudyEntry {
  /** The project's id: its SEO row's target (the sitemap's indexability filter, U10). */
  id: string;
  slug: string;
  title: LocalizedText;
  updatedAt: string | null;
}

/**
 * Every published case study the case-study page can render — for the sitemap and
 * llms.txt. Deliberately the SAME select and the same schema as getCaseStudy (not the
 * lighter card query): a row the page would reject (and answer 404 for) is dropped here
 * too, so neither discovery file ever lists a URL that does not resolve.
 */
export async function getCaseStudyIndex(): Promise<CaseStudyEntry[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await contentClient()
      .from('portfolio')
      .select(CASE_STUDY_COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });
    if (error) {
      reportLoadError('case_study_index', error);
      return [];
    }
    return parseCaseStudies(data ?? [], { body: false }).map((study) => ({
      id: study.id,
      slug: study.slug,
      title: study.title,
      updatedAt: study.updatedAt,
    }));
  } catch (err) {
    reportLoadError('case_study_index', err);
    return [];
  }
}

/** One published case study, or null (the page answers a real 404). */
export async function getCaseStudy(slug: string): Promise<CaseStudy | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await contentClient()
      .from('portfolio')
      .select(CASE_STUDY_COLUMNS)
      .eq('status', 'published')
      .eq('slug', slug)
      .maybeSingle();
    if (error) {
      reportLoadError('case_study', error);
      return null;
    }
    if (!data) return null;
    return parseCaseStudies([data])[0] ?? null;
  } catch (err) {
    reportLoadError('case_study', err);
    return null;
  }
}
