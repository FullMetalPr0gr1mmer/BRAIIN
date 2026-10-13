import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { writeSystemLog } from '@/lib/data/systemLog';
import {
  HelpArticleSchema,
  HelpEntrySchema,
  type HelpArticleRow,
  type HelpEntryRow,
} from '@schemas/help';
import { logSafeError } from '../globalSearch';
import { mayRead } from './access';
import {
  MIN_QUERY,
  cleanHelpQuery,
  isOnScreen,
  type HelpArticle,
  type HelpGuide,
  type HelpIndex,
} from './model';

export * from './model';
export { mayRead } from './access';
export { PAGE_GUIDES, pageGuideFor, type PageGuide } from './pageGuides';

// The help centre, server side (Admin v2 U16): the guides of `help_articles` (migration
// 0046) a signed-in staff member may read, the ones for the screen they are on, a search,
// and one guide to read. Every read goes through the caller's RLS-bound client, scoped to
// the caller's tenant; RLS gives every staff member of the tenant every guide.
//
// Which guides a ROLE is shown is decided here, from ROLE_CAPS (`mayRead`, ./access.ts):
// every list, search and guide below is filtered by it before it leaves the server.

/** At most this many guides are read for a list (the set holds a dozen). */
export const MAX_GUIDES = 100;

const INDEX_COLUMNS = 'slug,title,title_ar,minutes,tags,screens,caps,sort_order';
const ARTICLE_COLUMNS = `${INDEX_COLUMNS},body`;

function toGuide(row: HelpEntryRow): HelpGuide {
  return { slug: row.slug, title: row.title, minutes: row.minutes, tags: row.tags };
}

function toArticle(row: HelpArticleRow): HelpArticle {
  return { ...toGuide(row), titleAr: row.title_ar, body: row.body };
}

const slugOf = (row: unknown) =>
  String((row as { slug?: unknown } | null)?.slug ?? '?').slice(0, 64);

/** Guides the schema refused: left out of the answer and logged, never shown half-read. */
async function logRefused(where: string, slugs: readonly string[]): Promise<void> {
  if (slugs.length === 0) return;
  await writeSystemLog({
    level: 'warn',
    source: 'admin:help',
    message: `${slugs.length} help guide(s) do not match the schema (${where})`,
    detail: { slugs },
  });
}

/**
 * Rows as the schema reads them; one that fails it is left out and logged (the table's
 * CHECKs make that a defect, not an input).
 */
async function parseRows(rows: readonly unknown[], where: string): Promise<HelpEntryRow[]> {
  const out: HelpEntryRow[] = [];
  const bad: string[] = [];
  for (const row of rows) {
    const parsed = HelpEntrySchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
    else bad.push(slugOf(row));
  }
  await logRefused(where, bad);
  return out;
}

/** A read the database refused: logged, then thrown, so the route answers 500. */
async function failed(where: string, message: string, terms: readonly string[] = []) {
  await writeSystemLog({
    level: 'error',
    source: 'admin:help',
    message: `Help ${where} could not be read`,
    detail: { error: logSafeError(message, terms) },
  });
  return new Error(`help ${where} could not be read`);
}

/** Every guide the caller may read, and which of them are for `screen` (null: none). */
export async function loadHelpIndex(
  sb: SupabaseClient,
  auth: AuthContext,
  screen: string | null,
): Promise<HelpIndex> {
  const { data, error } = await sb
    .from('help_articles')
    .select(INDEX_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .order('sort_order', { ascending: true })
    .order('slug', { ascending: true })
    .limit(MAX_GUIDES);
  if (error) throw await failed('index', error.message);
  const rows = (await parseRows(data ?? [], 'index')).filter((row) => mayRead(auth.role, row.caps));
  return {
    guides: rows.map(toGuide),
    onScreen:
      screen === null
        ? []
        : rows.filter((row) => isOnScreen(row.screens, screen)).map((row) => row.slug),
  };
}

/**
 * The guides matching a search the caller may read, best first (public.help_search: a
 * title match first, then the set's order; at most 20). The query is cleaned as the
 * header search cleans one; under two characters searches nothing.
 */
export async function searchHelp(
  sb: SupabaseClient,
  auth: AuthContext,
  raw: string,
): Promise<HelpGuide[]> {
  const q = cleanHelpQuery(raw);
  if (q.length < MIN_QUERY) return [];
  const { data, error } = await sb.rpc('help_search', { p_tenant: auth.tenantId, p_q: q });
  if (error) throw await failed('search', error.message, [q]);
  const rows = Array.isArray(data) ? (data as unknown[]) : [];
  return (await parseRows(rows, 'search'))
    .filter((row) => mayRead(auth.role, row.caps))
    .map(toGuide);
}

/** One guide to read, or null when there is none by that slug the caller may read. */
export async function loadHelpArticle(
  sb: SupabaseClient,
  auth: AuthContext,
  slug: string,
): Promise<HelpArticle | null> {
  const { data, error } = await sb
    .from('help_articles')
    .select(ARTICLE_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw await failed('article', error.message);
  if (!data) return null;
  const parsed = HelpArticleSchema.safeParse(data);
  if (!parsed.success) {
    await logRefused('article', [slugOf(data)]);
    return null;
  }
  return mayRead(auth.role, parsed.data.caps) ? toArticle(parsed.data) : null;
}
