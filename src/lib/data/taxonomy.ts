import {
  ClientRowSchema,
  PUBLIC_MEDIA_COLUMNS,
  SectorRowSchema,
  TestimonialRowSchema,
  type LocalizedText,
  type TestimonialPlacement,
} from '@schemas/content';
import { supabaseConfigured } from '@/lib/supabase/client';
import { imageRef, type ImageRef } from '@/lib/media/resolve';
import { parseRows, reportLoadError } from './parse';
import { contentClient } from './source';

// Sectors, clients and testimonials (0021) for the public pages. Tier A SSR reads under
// RLS: visible sectors/clients and published testimonials only, tenant-fenced. Resilient:
// [] on any error, with the error CODE logged (parse.ts reportLoadError).

const MEDIA = `(${PUBLIC_MEDIA_COLUMNS})`;

export interface Sector {
  slug: string;
  name: LocalizedText;
}

/** Visible sectors in display order — the "Industry" facet of Our Work. */
export async function getSectors(): Promise<Sector[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await contentClient()
      .from('sectors')
      .select('id,slug,name,sort_order')
      .order('sort_order', { ascending: true });
    if (error) {
      reportLoadError('sectors', error);
      return [];
    }
    return parseRows(SectorRowSchema, data ?? [], 'sector').map((r) => ({
      slug: r.slug,
      name: r.name,
    }));
  } catch (err) {
    reportLoadError('sectors', err);
    return [];
  }
}

export interface MarqueeClient {
  slug: string;
  name: LocalizedText;
  logo: ImageRef | null;
  websiteUrl: string | null;
}

/**
 * The clients marquee: visible clients flagged for it. `visible` is the disclosure
 * permission, so RLS alone keeps an unconfirmed name off the page.
 */
export async function getMarqueeClients(): Promise<MarqueeClient[]> {
  if (!supabaseConfigured()) return [];
  try {
    const { data, error } = await contentClient()
      .from('clients')
      .select(`id,slug,name,website_url,sort_order,logo:logo_media_id${MEDIA}`)
      .eq('show_in_marquee', true)
      .order('sort_order', { ascending: true });
    if (error) {
      reportLoadError('clients', error);
      return [];
    }
    return parseRows(ClientRowSchema, data ?? [], 'client').map((r) => ({
      slug: r.slug,
      name: r.name,
      logo: imageRef(r.logo),
      websiteUrl: r.website_url,
    }));
  } catch (err) {
    reportLoadError('clients', err);
    return [];
  }
}

export interface Testimonial {
  slug: string;
  quote: LocalizedText;
  authorName: LocalizedText;
  /** "Title, Company" verbatim. */
  authorRole: LocalizedText | null;
  avatar: ImageRef | null;
}

// The anon grant on testimonials is COLUMN-level (the consent record is withheld), so the
// select lists columns explicitly — `*` would be a permission error.
const TESTIMONIAL_COLUMNS =
  'id,slug,quote,author_name,author_role,client_id,portfolio_id,placements,sort_order,' +
  `avatar:avatar_media_id${MEDIA}`;

/**
 * Published quotes for a page (`placement`) or a case study (`portfolioId`), in order.
 * `limit` bounds the carousel (≤ 8).
 */
export async function getTestimonials(opts: {
  placement?: TestimonialPlacement;
  portfolioId?: string;
  limit?: number;
}): Promise<Testimonial[]> {
  if (!supabaseConfigured()) return [];
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 8);
  try {
    let query = contentClient()
      .from('testimonials')
      .select(TESTIMONIAL_COLUMNS)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })
      .limit(limit);
    if (opts.placement) query = query.contains('placements', [opts.placement]);
    if (opts.portfolioId) query = query.eq('portfolio_id', opts.portfolioId);
    const { data, error } = await query;
    if (error) {
      reportLoadError('testimonials', error);
      return [];
    }
    return parseRows(TestimonialRowSchema, data ?? [], 'testimonial').map((r) => ({
      slug: r.slug,
      quote: r.quote,
      authorName: r.author_name,
      authorRole: r.author_role,
      avatar: imageRef(r.avatar),
    }));
  } catch (err) {
    reportLoadError('testimonials', err);
    return [];
  }
}
