import { PUBLIC_MEDIA_COLUMNS, PublicMediaRowSchema } from '@schemas/content';
import { UuidSchema } from '@schemas/primitives';
import { supabaseConfigured } from '@/lib/supabase/client';
import { imageRef, type ImageRef } from '@/lib/media/resolve';
import { parseRows, reportLoadError } from './parse';
import { contentClient } from './source';
import { serviceClient } from '@/lib/supabase/server';
import { pageAccess } from '@/lib/visibility/scope';

// Media a page SECTION references by id (`{ mediaId }` inside page_sections.content —
// Our Work's intro frames, About's "who we are" poster). Tier A SSR read under RLS: anon sees a media row only
// while a visible section of a published page references it by that exact key (0024's
// `$.**.mediaId` branch), plus the 0024 column grant — so a draft page's image, or an id
// typed into content that nothing publishes, resolves to nothing here.
//
// Resolved through the same provider gate as every other public image (media/resolve.ts):
// a non-static row, or a key the stills registry does not know, is dropped. Resilient:
// an empty map on any error (the section then renders without that frame).
//
// A PAGE BEHIND A PASSWORD (Admin v2 U14b). The media policy's page_sections branch runs
// under anon's own RLS, and the password fence (0061) takes a locked page's sections from
// anon, so a still only that page names is anon-readable while the page is public and gone
// once it is locked, for a visitor who typed the password too. Inside the page-access scope
// (the middleware's `withPageAccess`, the one page this request unlocked) the ids are read
// through `public.page_media_unlocked` as the service role instead: it answers, among these
// ids, the rows a VISIBLE section of that PUBLISHED page names, of a provider the public may
// render, in PUBLIC_MEDIA_COLUMNS, which is what the anon read answers for the same page
// while it is public. So an unlocked page renders its images as a public one would. The
// scope is read BEFORE any query is awaited (src/lib/visibility/scope.ts has the rule), and
// tests/lib/contentSource.spec.ts pins this read, by file and by reason.

const MAX_IDS = 12;

export async function getSectionImages(ids: readonly string[]): Promise<Map<string, ImageRef>> {
  // Read first, before any query is awaited (see the note above).
  const access = pageAccess();
  const wanted = [...new Set(ids)].filter((id) => UuidSchema.safeParse(id).success);
  if (wanted.length === 0 || !supabaseConfigured()) return new Map();
  const unlocked = access !== undefined && access.tenantId.length > 0 ? access : null;
  try {
    const { data, error } =
      unlocked === null
        ? await contentClient()
            .from('media_assets')
            .select(PUBLIC_MEDIA_COLUMNS)
            .in('id', wanted.slice(0, MAX_IDS))
        : await serviceClient().rpc('page_media_unlocked', {
            p_tenant: unlocked.tenantId,
            p_page_id: unlocked.pageId,
            p_ids: wanted.slice(0, MAX_IDS),
          });
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

/** One section's asset (About's poster): the same gated read, for a single id. */
export async function getSectionImage(mediaId: string | undefined): Promise<ImageRef | null> {
  if (!mediaId) return null;
  return (await getSectionImages([mediaId])).get(mediaId) ?? null;
}
