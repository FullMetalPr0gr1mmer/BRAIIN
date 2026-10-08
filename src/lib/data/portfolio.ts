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
import { renderTiptapToHtml } from '@/lib/content/tiptap';
import { clipOf, imageRef, type ImageRef } from '@/lib/media/resolve';
import { describable } from '@/lib/portfolio/caseStudy';
import { parseRows, reportLoadError } from './parse';
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

/**
 * The body as HTML, rendered HERE from its Tiptap JSON by the allowlist renderer
 * (src/lib/content/tiptap.ts) — CLAUDE.md Pillar 1: "Tiptap sanitised on write AND
 * render; never `set:html` unsanitised". The stored `body_html` cache is not trusted on
 * the public path: a caller holding portfolio.write can set it directly (PostgREST PATCH
 * or rpc/save_portfolio), skipping the admin API that derives it, and the edge would then
 * cache whatever markup they wrote. The renderer can only emit the tags and attributes
 * written literally in it. The cost lands on an edge-cache miss only (Security > Perf).
 */
export function renderBody(body: CaseStudyRow['body']): LocalizedProse | null {
  const en = renderTiptapToHtml(body?.en);
  const ar = renderTiptapToHtml(body?.ar);
  if (!en && !ar) return null;
  return ar ? { en, ar } : { en };
}

export function toCaseStudy(row: CaseStudyRow): CaseStudy {
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
    bodyHtml: renderBody(row.body),
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
      .order('sort_order', { ascending: true });
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
 */
export function parseCaseStudies(rows: unknown[]): CaseStudy[] {
  return parseRows(CaseStudyRowSchema, rows, 'portfolio').map(toCaseStudy);
}

export interface CaseStudyEntry {
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
      .order('sort_order', { ascending: true });
    if (error) {
      reportLoadError('case_study_index', error);
      return [];
    }
    return parseCaseStudies(data ?? []).map((study) => ({
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
