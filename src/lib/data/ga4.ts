import { GA4_ID } from '@schemas/integrations';
import { supabaseConfigured } from '@/lib/supabase/client';
import { reportLoadError } from './parse';
import { contentClient } from './source';

// The GA4 measurement id a public page loads Google Analytics with (Admin v2 U15): the one
// `site_integrations` column anon reads beside U11's Search Console code (migration 0113),
// under 0105's policy fenced to the launch tenant. Public by nature: every page that loads
// GA4 carries it. Read only by src/middleware.ts, and only while the code-owned switch is on
// and the route loads GA4 (src/lib/http/ga4.ts), so with the switch off no request reads it.
//
// Never throws, and never fails the page: no id is no GA4, which is harmless (the first-party
// analytics are the numbers of record, CLAUDE.md §2). An unconfigured database, a refused or
// failed read, no row and a value that is not a measurement id (the CHECK and this pattern
// are the same, packages/schemas/integrations.ts) all answer null, the last three reported.

/** The column a visitor may read for GA4, and the only one this asks for. */
export const GA4_COLUMN = 'ga4_measurement_id';

export async function getGa4MeasurementId(): Promise<string | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await contentClient()
      .from('site_integrations')
      .select(GA4_COLUMN)
      .maybeSingle();
    if (error) {
      reportLoadError('site_integrations', error);
      return null;
    }
    const id = (data as Record<string, unknown> | null)?.[GA4_COLUMN];
    if (id === null || id === undefined) return null;
    if (typeof id !== 'string' || !GA4_ID.test(id)) {
      reportLoadError('site_integrations', new Error('the GA4 id is not a measurement id'));
      return null;
    }
    return id;
  } catch (err) {
    reportLoadError('site_integrations', err);
    return null;
  }
}
