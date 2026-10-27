import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext, Role } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';
import { SECTION_COPY } from '@/lib/sections/copy';
import { pagePath } from '@/lib/seo/entityPaths';
import type {
  BuiltInLooks,
  PageEditorAccess,
  PageEditorPage,
} from '@/components/admin/screens/pageEditor/types';
import { collectionScreens } from '@/components/admin/screens/pageEditor/library';
import { seoAccess } from '../editorAccess';
import { reachableHrefs } from '../nav';
import type { VisibilityModeKey } from '../visibilityCopy';

// The page editor's server half (Admin v2 E1, docs/admin-v2/ui.md "Page editor"). SERVER
// ONLY: /admin/pages/[id] calls it and hands the result to the AdminPageEditor island.
//   pageEditorAccess  what the role may do, from ROLE_CAPS (pure; UX only);
//   builtInLooks      every section type's built-in copy (F6's SECTION_COPY), each look with
//                     its `notVerbatim` fields left out (F5b's contract: a field whose
//                     built-in the type does not render verbatim when stored is never
//                     prefilled). Here, on the server, so the copy adds nothing to the
//                     admin bundle: it reaches the browser as the island's props;
//   loadEditorPage    the page row and its visibility mode, read under the person's RLS.
// The sections, the page's own form, its SEO row and its history are read by the island
// through the resource routes, which overlay pending changes while releases are on.

type Row = Record<string, unknown>;

/** Who may open the page editor at all: a role that edits pages or reads their SEO. */
export function mayOpenPages(role: Role): boolean {
  return can(role, 'pages.write') === 'full' || can(role, 'seo.entityMeta') !== 'none';
}

export function pageEditorAccess(role: Role): PageEditorAccess {
  const reachable = reachableHrefs(role);
  return {
    sections: can(role, 'pages.write') === 'full',
    remove: can(role, 'content.archiveDelete') === 'full',
    publish: can(role, 'content.publish') === 'full',
    seo: seoAccess(role),
    visibility: can(role, 'maintenance.manage') === 'full',
    opens: collectionScreens().filter((href) => reachable.includes(href)),
  };
}

/** Every type's looks, as the editor prefills them: no `notVerbatim` field. */
export function builtInLooks(): BuiltInLooks {
  const out: Record<string, Record<string, Row>> = {};
  for (const [type, copy] of Object.entries(SECTION_COPY)) {
    const looks: Record<string, Row> = {};
    for (const [look, content] of Object.entries(copy.content)) {
      const row: Row = { ...(content as Row) };
      for (const field of copy.notVerbatim) delete row[field];
      looks[look] = row;
    }
    out[type] = looks;
  }
  return out;
}

const MODES: readonly VisibilityModeKey[] = ['public', 'hidden', 'link', 'password'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The page as the editor opens on it, or null when the id names no page of the tenant. */
export async function loadEditorPage(
  sb: SupabaseClient,
  auth: AuthContext,
  id: string,
): Promise<PageEditorPage | null> {
  if (!UUID.test(id)) return null;
  const [page, visibility] = await Promise.all([
    sb
      .from('pages')
      .select('id,slug,title,status')
      .eq('tenant_id', auth.tenantId)
      .eq('id', id)
      .maybeSingle(),
    sb
      .from('page_visibility')
      .select('mode')
      .eq('tenant_id', auth.tenantId)
      .eq('page_id', id)
      .maybeSingle(),
  ]);
  if (page.error) throw new Error(`read pages: ${page.error.message}`);
  if (visibility.error) throw new Error(`read page_visibility: ${visibility.error.message}`);
  const row = page.data as Row | null;
  if (!row) return null;
  const slug = String(row['slug'] ?? '').toLowerCase();
  const title = (row['title'] && typeof row['title'] === 'object' ? row['title'] : {}) as Row;
  const mode = (visibility.data as Row | null)?.['mode'];
  return {
    id: String(row['id']),
    slug,
    title: {
      en: typeof title['en'] === 'string' && title['en'].trim() ? title['en'] : slug,
      ar: typeof title['ar'] === 'string' ? title['ar'] : '',
    },
    status: typeof row['status'] === 'string' ? row['status'] : 'draft',
    path: pagePath(slug),
    visibility: MODES.includes(mode as VisibilityModeKey) ? (mode as VisibilityModeKey) : 'public',
  };
}
