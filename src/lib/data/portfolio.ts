import {
  CaseStudyRowSchema,
  PortfolioCardRowSchema,
  PortfolioRowSchema,
  PUBLIC_MEDIA_COLUMNS,
  type CaseStudyRow,
  type LocalizedProse,
  type LocalizedText,
  type PortfolioCardRow,
  type PortfolioMediaRow,
  type ResultCard,
} from '@schemas/content';
import type { VideoClip } from '@schemas/media';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { clipOf, imageRef, type ImageRef } from '@/lib/media/resolve';
import { parseRow, parseRows, reportLoadError } from './parse';

// Runtime data access for the public portfolio / case studies (Tier A SSR). Tenant +
// published filtering are enforced by RLS; we still pass status explicitly. Shape lives in
// `packages/schemas/content.ts` (CLAUDE.md §8). Resilient: []/null on any error.
//
// Two generations live here while UI v2 lands page by page:
//   getPublishedPortfolio / getPortfolioBySlug   the current pages and the sitemap
//   getPortfolioCards / getCaseStudy             UI v2 (Our Work, All projects, case study)
// The sitemap and llms.txt already list case studies from the second generation
// (getCaseStudyIndex — PR10); PR11 moves the case-study page itself onto getCaseStudy, the
// same select and schema, so neither file can list a case study the page would 404 on.

export type { PortfolioRow } from '@schemas/content';

const COLUMNS = 'id,slug,title,summary,body_html,sort_order,updated_at';

export async function getPublishedPortfolio() {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await anonClient()
      .from('portfolio')
      .select(COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (error || !data) return [];
    return parseRows(PortfolioRowSchema, data, 'portfolio');
  } catch {
    return [];
  }
}

export async function getPortfolioBySlug(slug: string) {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await anonClient()
      .from('portfolio')
      .select(COLUMNS)
      .eq('status', 'published')
      .eq('slug', slug)
      .maybeSingle();
    if (error || !data) return null;
    return parseRow(PortfolioRowSchema, data, 'portfolio');
  } catch {
    return null;
  }
}

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

export const CASE_STUDY_COLUMNS =
  `${CARD_COLUMNS},body_html,lead,goal,result,scope,keywords,results,next_portfolio_id,` +
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

export function toCaseStudy(row: CaseStudyRow): CaseStudy {
  const byRole = (role: PortfolioMediaRow['role']) =>
    row.media
      .filter((m) => m.role === role)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(toCaseMedia);
  // A gallery or breakdown image that no longer resolves is dropped rather than rendered
  // as an empty frame; hero/final keep their clip even when the poster is missing.
  const images = (items: CaseMedia[]) => items.filter((m) => m.image !== null);
  return {
    ...toCard(row),
    summary: row.summary,
    bodyHtml: row.body_html,
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
    let query = anonClient()
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
    const { data, error } = await anonClient()
      .from('portfolio')
      .select(CASE_STUDY_COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true });
    if (error) {
      reportLoadError('case_study_index', error);
      return [];
    }
    return parseRows(CaseStudyRowSchema, data ?? [], 'portfolio').map((row) => ({
      slug: row.slug,
      title: row.title,
      updatedAt: row.updated_at,
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
    const { data, error } = await anonClient()
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
    const row = parseRow(CaseStudyRowSchema, data, 'portfolio');
    return row ? toCaseStudy(row) : null;
  } catch (err) {
    reportLoadError('case_study', err);
    return null;
  }
}
