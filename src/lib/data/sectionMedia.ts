import { PUBLIC_MEDIA_COLUMNS, PublicMediaRowSchema } from '@schemas/content';
import { UuidSchema } from '@schemas/primitives';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { imageRef, type ImageRef } from '@/lib/media/resolve';
import { parseRow, reportLoadError } from './parse';

// A media asset a SECTION references by id (`page_sections.content.mediaId` — About's
// "who we are" poster). Tier A SSR reads under RLS: migration 0024 lets anon read an asset
// only while a visible section of a published page names it, so a poster chosen for a
// draft page stays invisible. Resolved through imageRef (static stills today; an unknown
// provider or key renders nothing — fail closed). Resilient: null on any error.

export async function getSectionImage(mediaId: string | undefined): Promise<ImageRef | null> {
  if (!mediaId || !UuidSchema.safeParse(mediaId).success || !supabaseConfigured()) return null;
  try {
    const { data, error } = await anonClient()
      .from('media_assets')
      .select(PUBLIC_MEDIA_COLUMNS)
      .eq('id', mediaId)
      .maybeSingle();
    if (error) {
      reportLoadError('media_asset', error);
      return null;
    }
    return data ? imageRef(parseRow(PublicMediaRowSchema, data, 'media_asset')) : null;
  } catch (err) {
    reportLoadError('media_asset', err);
    return null;
  }
}
