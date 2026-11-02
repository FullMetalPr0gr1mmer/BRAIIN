import type { SupabaseClient } from '@supabase/supabase-js';

// Which theme the editor edits (Admin v2 E4): the tenant's one v1 theme (a row with settings,
// custom_themes_one_theme_v1), read under the person's own RLS (staff read their tenant's
// themes). With releases on, a theme nobody has published yet is a pending create: its id is
// the draft's entity id, so a second save stages onto it rather than a second create (which
// the unique index would refuse at publish). Null: the first save creates the theme. A failed
// read is null too: the save then creates, and a duplicate is refused by the index, never
// written.

export async function findThemeId(
  sb: SupabaseClient,
  releaseMode: boolean,
): Promise<string | null> {
  const live = await sb
    .from('custom_themes')
    .select('id')
    .not('settings', 'is', null)
    .limit(1)
    .maybeSingle();
  const liveId = (live.data as { id?: unknown } | null)?.id;
  if (typeof liveId === 'string') return liveId;
  if (!releaseMode) return null;
  const pending = await sb
    .from('content_drafts')
    .select('entity_id')
    .eq('entity_type', 'custom_theme')
    .eq('op', 'create')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const pendingId = (pending.data as { entity_id?: unknown } | null)?.entity_id;
  return typeof pendingId === 'string' ? pendingId : null;
}
