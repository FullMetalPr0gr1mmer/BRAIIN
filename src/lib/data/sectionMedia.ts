import { PUBLIC_MEDIA_COLUMNS, PublicMediaRowSchema } from '@schemas/content';
import { UuidSchema } from '@schemas/primitives';
import { anonClient, supabaseConfigured } from '@/lib/supabase/client';
import { imageRef, type ImageRef } from '@/lib/media/resolve';
import { parseRows, reportLoadError } from './parse';

// Media a page SECTION references by id (`{ mediaId }` inside page_sections.content —
// e.g. Our Work's intro frames). Tier A SSR read under RLS: anon sees a media row only
// while a visible section of a published page references it by that exact key (0024's
// `$.**.mediaId` branch), plus the 0024 column grant — so a draft page's image, or an id
// typed into content that nothing publishes, resolves to nothing here.
//
// Resolved through the same provider gate as every other public image (media/resolve.ts):
// a non-static row, or a key the stills registry does not know, is dropped. Resilient:
// an empty map on any error (the section then renders without that frame).

const MAX_IDS = 12;

export async function getSectionImages(ids: readonly string[]): Promise<Map<string, ImageRef>> {
  const wanted = [...new Set(ids)].filter((id) => UuidSchema.safeParse(id).success);
  if (wanted.length === 0 || !supabaseConfigured()) return new Map();
  try {
    const { data, error } = await anonClient()
      .from('media_assets')
      .select(PUBLIC_MEDIA_COLUMNS)
      .in('id', wanted.slice(0, MAX_IDS));
    if (error) {
      reportLoadError('section_media', error);
      return new Map();
    }
    const out = new Map<string, ImageRef>();
    for (const row of parseRows(PublicMediaRowSchema, data ?? [], 'media')) {
      const ref = imageRef(row);
      if (ref) out.set(row.id, ref);
    }
    return out;
  } catch (err) {
    reportLoadError('section_media', err);
    return new Map();
  }
}
