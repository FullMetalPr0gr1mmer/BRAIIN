import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { readError } from './read';
import { realtimeOf, type RealtimeView } from './realtimeView';

// Realtime for the stats screen, its JSON route and the dashboard's "Right now" widget
// (Admin v2 G1b): one read of public.realtime_summary (migration 0071), an invoker over
// rollup_minute_activity, so analytics.read decides; never the raw events (Pillar 4).

export async function loadRealtime(sb: SupabaseClient, auth: AuthContext): Promise<RealtimeView> {
  const { data, error } = await sb.rpc('realtime_summary', { p_tenant: auth.tenantId });
  if (error) throw await readError('admin:stats', 'Realtime', error);
  return realtimeOf(data);
}
