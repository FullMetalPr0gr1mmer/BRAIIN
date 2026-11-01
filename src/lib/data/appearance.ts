import { HEADER_DEFAULTS, type HeaderSettings } from '@schemas/appearance';
import { supabaseConfigured } from '@/lib/supabase/client';
import { headerFromRow } from '@/lib/appearance/header';
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
