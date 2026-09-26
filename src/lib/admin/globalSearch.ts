import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { ROLE_CAPS, type Access } from '@/lib/authz/matrix';
import type { ResourceConfig } from './resource';
import {
  aiQuestionResource,
  aiStyleResource,
  categoryResource,
  certificationResource,
  mediaResource,
  pageResource,
  partnerLogoResource,
  portfolioResource,
  postResource,
  redirectResource,
  serviceResource,
  statisticResource,
  teamResource,
  themeResource,
} from './resources';

// The header search, server-side. One ilike per entity the caller's role can read,
// reusing each resource's own config so the entity list, its capabilities and its
// columns cannot drift from the CRUD endpoints they mirror.
//
// Deliberate boundaries:
//
//   - SERVER-RENDERED, not a live combobox. A GET form to /admin/search costs zero
//     client JS, is fully keyboard- and screen-reader-accessible for free, and cannot
//     leak a result the server did not authorize. Live suggestions are a later nicety.
//   - LEADS ARE EXCLUDED. Lead data is Admin+Developer-gated PII behind its own page
//     and audit trail; surfacing lead names in a cross-entity search box would create
//     a second, less-guarded read path — the exact thing §5's column gates exist to
//     prevent. The leads page has its own search.
//   - Per-entity capability gating uses the SAME rule as the sidebar (nav.ts): any of
//     the resource's read caps at full/view/meta. This is UX-layer filtering on top of
//     RLS — an entity the role cannot read returns zero rows from Postgres regardless.
//   - One ilike COLUMN per entity, no .or() chains: PostgREST's or-filter syntax gives
//     commas and parens meaning, which turns user input into filter grammar — the
//     search-safety class of bug §9(e) tests for. A single .ilike() argument is
//     parameter-encoded by supabase-js and carries no grammar.

interface SearchTarget {
  config: ResourceConfig;
  /** URL segment of the editor route: /admin/<uiSlug>/<id>. */
  uiSlug: string;
  /** Group heading on the results page. */
  group: string;
  /** Column matched by ilike. `title->>en` for the bilingual-JSONB content types. */
  column: string;
}

const TARGETS: readonly SearchTarget[] = [
  { config: serviceResource, uiSlug: 'services', group: 'Services', column: 'title->>en' },
  { config: postResource, uiSlug: 'blog', group: 'Blog', column: 'title->>en' },
  { config: portfolioResource, uiSlug: 'portfolio', group: 'Portfolio', column: 'title->>en' },
  { config: pageResource, uiSlug: 'pages', group: 'Pages', column: 'title->>en' },
  { config: categoryResource, uiSlug: 'categories', group: 'Categories', column: 'slug' },
  { config: teamResource, uiSlug: 'team', group: 'Team & authors', column: 'name' },
  {
    config: certificationResource,
    uiSlug: 'certifications',
    group: 'Certifications',
    column: 'name',
  },
  { config: statisticResource, uiSlug: 'statistics', group: 'Statistics', column: 'slug' },
  { config: partnerLogoResource, uiSlug: 'partner-logos', group: 'Partner logos', column: 'name' },
  { config: redirectResource, uiSlug: 'redirects', group: 'Redirects', column: 'source_path' },
  { config: mediaResource, uiSlug: 'media', group: 'Media', column: 'storage_path' },
  { config: themeResource, uiSlug: 'themes', group: 'Themes', column: 'name' },
  {
    config: aiQuestionResource,
    uiSlug: 'ai-questions',
    group: 'Style-Finder questions',
    column: 'slug',
  },
  { config: aiStyleResource, uiSlug: 'ai-styles', group: 'Style-Finder styles', column: 'slug' },
];

const NAV_ACCESS: readonly Access[] = ['full', 'view', 'meta'];
const PER_ENTITY_LIMIT = 5;
export const MAX_QUERY_LENGTH = 64;

export interface SearchHit {
  href: string;
  label: string;
  detail: string | null;
}

export interface SearchGroup {
  group: string;
  hits: SearchHit[];
}

export interface SearchOutcome {
  groups: SearchGroup[];
  /** Groups skipped because their query errored — rendered as a notice, not hidden. */
  failed: string[];
}

function canRead(auth: AuthContext, config: ResourceConfig): boolean {
  const caps = config.readCaps ?? [config.writeCap];
  return caps.some((cap) => NAV_ACCESS.includes(ROLE_CAPS[auth.role][cap]));
}

/** Escape ilike wildcards so a `%` in the query matches a literal `%`. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

/** Sanitise per the public-search rule (§7): length-capped, control chars stripped. */
export function cleanQuery(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

/** First human-readable string in a row value: bilingual JSONB `{en, ar}` or scalar. */
function textOf(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const doc = value as Record<string, unknown>;
    if (typeof doc['en'] === 'string' && doc['en'].length > 0) return doc['en'];
    if (typeof doc['ar'] === 'string' && doc['ar'].length > 0) return doc['ar'];
  }
  return null;
}

function labelOf(row: Record<string, unknown>): string {
  return (
    textOf(row['title']) ??
    textOf(row['name']) ??
    textOf(row['label']) ??
    textOf(row['slug']) ??
    textOf(row['source_path']) ??
    textOf(row['storage_path']) ??
    String(row['id'])
  );
}

function detailOf(row: Record<string, unknown>): string | null {
  const slug = textOf(row['slug']);
  if (slug) return `/${slug}`;
  return textOf(row['source_path']) ?? textOf(row['storage_path']);
}

export async function searchAdmin(
  sb: SupabaseClient,
  auth: AuthContext,
  query: string,
): Promise<SearchOutcome> {
  const q = cleanQuery(query);
  const groups: SearchGroup[] = [];
  const failed: string[] = [];
  if (q.length < 2) return { groups, failed };

  const pattern = `%${escapeLike(q)}%`;

  // Sequential, not Promise.all: each call shares the caller's RLS-bound client, the
  // per-entity limit keeps every query trivial, and one slow entity failing fast-first
  // beats fourteen concurrent queries hitting the pooler from one keystroke.
  for (const target of TARGETS) {
    if (!canRead(auth, target.config)) continue;

    const { data, error } = await sb
      .from(target.config.table)
      .select(target.config.listColumns)
      .eq('tenant_id', auth.tenantId)
      .ilike(target.column, pattern)
      .limit(PER_ENTITY_LIMIT);

    if (error) {
      failed.push(target.group);
      continue;
    }
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    if (rows.length === 0) continue;

    groups.push({
      group: target.group,
      hits: rows.map((row) => ({
        href: `/admin/${target.uiSlug}/${String(row['id'])}`,
        label: labelOf(row),
        detail: detailOf(row),
      })),
    });
  }

  return { groups, failed };
}
