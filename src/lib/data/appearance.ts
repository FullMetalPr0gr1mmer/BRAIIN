import {
  HEADER_DEFAULTS,
  INTRO_DEFAULTS,
  type HeaderSettings,
  type IntroSettings,
} from '@schemas/appearance';
import { supabaseConfigured } from '@/lib/supabase/client';
import { headerFromRow } from '@/lib/appearance/header';
import { introFromRow } from '@/lib/appearance/intro';
import { reportLoadError } from './parse';
import { contentClient } from './source';

// The published appearance settings (Admin v2 E5, `public.site_appearance`): anon-readable (the
// header is on every public page), tenant-fenced by RLS like every public read, through the
// content seam, so the releases preview lays a pending change over it.
//
// Never throws. No row (the header as built), an unconfigured database, a failed read or an
// unreadable option all give the header as built (option by option, headerFromRow), and a
// failed read is logged. The header is on every page: it must never be the reason one fails.

/** anon's columns (the E5 migration's column grant): the header's options. */
export const SITE_APPEARANCE_HEADER_COLUMNS =
  'header_logo_position,header_logo_size,header_menu_align,header_sticky,header_hide_on_scroll,header_solid_after_hero,header_tint,header_blur,header_mobile_menu,header_cta_show,header_cta_label,header_cta_href';

/**
 * anon's columns for the loading screen (Admin v2 E7, the loading screen migration's column
 * grant): read by the home routes only, the one place the intro plate renders. A string
 * literal, as the header's: the preview's loader scan reads it from the source
 * (tests/lib/loaderQueries.ts); a spec holds it equal to INTRO_COLUMNS.
 */
export const SITE_APPEARANCE_INTRO_COLUMNS =
  'intro_backdrop,intro_bar,intro_tagline,intro_hold_ms,intro_fade_ms';

/**
 * The loading screen's look (the home page's intro plate). Never throws: no row, an
 * unconfigured database, a failed read or an unreadable option give the intro as built, and a
 * failed read is logged. Whether the plate shows at all is the home hero section's `intro`.
 */
export async function getIntroSettings(): Promise<IntroSettings> {
  if (!supabaseConfigured()) return { ...INTRO_DEFAULTS };
  try {
    const { data, error } = await contentClient()
      .from('site_appearance')
      .select(SITE_APPEARANCE_INTRO_COLUMNS)
      .maybeSingle();
    if (error) {
      reportLoadError('site_appearance', error);
      return { ...INTRO_DEFAULTS };
    }
    return introFromRow(data as Record<string, unknown> | null);
  } catch (err) {
    reportLoadError('site_appearance', err);
    return { ...INTRO_DEFAULTS };
  }
}

export async function getHeaderSettings(): Promise<HeaderSettings> {
  if (!supabaseConfigured()) return { ...HEADER_DEFAULTS };
  try {
    const { data, error } = await contentClient()
      .from('site_appearance')
      .select(SITE_APPEARANCE_HEADER_COLUMNS)
      .maybeSingle();
    if (error) {
      reportLoadError('site_appearance', error);
      return { ...HEADER_DEFAULTS };
    }
    return headerFromRow(data as Record<string, unknown> | null);
  } catch (err) {
    reportLoadError('site_appearance', err);
    return { ...HEADER_DEFAULTS };
  }
}
