import { GSC_TOKEN } from '@schemas/integrations';
import { supabaseConfigured } from '@/lib/supabase/client';
import { reportLoadError } from './parse';
import { contentClient } from './source';

// The Search Console verification code (Admin v2 U11): the content of Google's
// `google-site-verification` meta tag, which SeoHead emits on the home pages once an Admin or
// SEO has set it on /admin/integrations. Public by design (Google reads it from the page), so
// anon reads it: `site_integrations`' one anon column, under a policy fenced to the launch
// tenant (migration 0105). Nothing else of the row reaches a visitor.
//
// Never throws, and never fails the page: no tag is harmless (the site was verified, or is
// not yet), so an unconfigured database, a refused or failed read, no row and a value that is
// not a code (the CHECK and this pattern are the same, packages/schemas/integrations.ts) all
// answer null, the last three reported.

/** The column a visitor may read, and the only one this asks for. */
export const SEARCH_CONSOLE_COLUMN = 'search_console_token';

export async function getSearchConsoleToken(): Promise<string | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data, error } = await contentClient()
      .from('site_integrations')
      .select(SEARCH_CONSOLE_COLUMN)
      .maybeSingle();
    if (error) {
      reportLoadError('site_integrations', error);
      return null;
    }
    const token = (data as Record<string, unknown> | null)?.[SEARCH_CONSOLE_COLUMN];
    if (token === null || token === undefined) return null;
    if (typeof token !== 'string' || !GSC_TOKEN.test(token)) {
      reportLoadError('site_integrations', new Error('the verification code is not a code'));
      return null;
    }
    return token;
  } catch (err) {
    reportLoadError('site_integrations', err);
    return null;
  }
}
