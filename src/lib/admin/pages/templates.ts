import type { SupabaseClient } from '@supabase/supabase-js';
import type { TemplateKind } from '@schemas/templateCopyKeys';
import type { AuthContext, Role } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';
import { builtInTemplateCopy } from '@/lib/templates/copy';
import type {
  TemplateEditorAccess,
  TemplateEditorSetup,
  TemplateItem,
  TemplateItemGroup,
} from '@/components/admin/screens/templateEditor/types';
import { previewable } from './editor';

// The template editors' server half (Admin v2 E3, docs/admin-v2/ui.md "Template editors
// (AV-31)"). SERVER ONLY: /admin/pages/template/service and /project call it and hand the
// result to the AdminTemplateEditor island.
//   mayEditTemplates   who opens them: the holders of pages.write (Admin, Content Creator);
//   templateAccess     what the role may do there (pure; UX only);
//   templateGroups     the picker's groups from the rows read (pure): services by discipline in
//                      the site's order (a service in no discipline last, under "No
//                      discipline"), projects one flat list in the catalogue's order;
//   pickItem           the item shown first: the address's, else the first published one;
//   loadTemplateEditor the rows, read under the person's RLS, archived ones left out.
// The item's own fields, its history and the shared text are read by the island through the
// resource and singleton routes, which lay pending changes over live while releases are on.

type Row = Record<string, unknown>;

/** Each template editor's address. */
export const TEMPLATE_EDITOR_PATHS: Readonly<Record<TemplateKind, string>> = {
  service: '/admin/pages/template/service',
  project: '/admin/pages/template/project',
};

/** Who may open a template editor: a role that edits pages (the shared text is page content). */
export function mayEditTemplates(role: Role): boolean {
  return can(role, 'pages.write') === 'full';
}

export function templateAccess(role: Role, kind: TemplateKind): TemplateEditorAccess {
  return {
    item: can(role, kind === 'service' ? 'services.write' : 'portfolio.write') === 'full',
    shared: can(role, 'pages.write') === 'full',
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bi(value: unknown, fallback: string) {
  const v = (value && typeof value === 'object' ? value : {}) as Row;
  const en = typeof v['en'] === 'string' && v['en'].trim() ? v['en'] : fallback;
  return { en, ar: typeof v['ar'] === 'string' ? v['ar'] : '' };
}

/** A service or project row as the picker offers it, or null for a row it cannot name. */
export function templateItem(kind: TemplateKind, row: Row): TemplateItem | null {
  const id = typeof row['id'] === 'string' ? row['id'] : '';
  const slug = typeof row['slug'] === 'string' ? row['slug'] : '';
  if (!UUID.test(id) || !slug) return null;
  const path = `/${kind === 'service' ? 'services' : 'portfolio'}/${slug}`;
  return {
    id,
    slug,
    title: bi(row['title'], slug),
    status: typeof row['status'] === 'string' ? row['status'] : 'draft',
    path,
    previewable: previewable(path),
  };
}

/** The picker's groups from the rows read (in the order the queries gave them). */
export function templateGroups(
  kind: TemplateKind,
  items: readonly Row[],
  disciplines: readonly Row[] = [],
): TemplateItemGroup[] {
  if (kind === 'project') {
    const flat = items.flatMap((row) => templateItem(kind, row) ?? []);
    return flat.length > 0 ? [{ label: null, items: flat }] : [];
  }
  const groups: TemplateItemGroup[] = disciplines.map((d) => ({
    label: bi(d['name'], 'Discipline').en,
    items: items
      .filter((row) => row['discipline_id'] === d['id'])
      .flatMap((row) => templateItem(kind, row) ?? []),
  }));
  const known = new Set(disciplines.map((d) => d['id']));
  const loose = items
    .filter((row) => !known.has(row['discipline_id']))
    .flatMap((row) => templateItem(kind, row) ?? []);
  if (loose.length > 0) groups.push({ label: 'No discipline', items: loose });
  return groups.filter((group) => group.items.length > 0);
}

/** The item shown first: the address's when it is offered, else the first published one. */
export function pickItem(
  groups: readonly TemplateItemGroup[],
  wanted: string | null,
): string | null {
  const items = groups.flatMap((group) => group.items);
  return (
    items.find((item) => item.id === wanted)?.id ??
    items.find((item) => item.status === 'published')?.id ??
    items[0]?.id ??
    null
  );
}

/** The most items one read offers (far above the catalogue: 28 services, a few dozen projects). */
const ITEM_LIMIT = 200;

export async function loadTemplateEditor(
  sb: SupabaseClient,
  auth: AuthContext,
  kind: TemplateKind,
  wanted: string | null,
): Promise<TemplateEditorSetup> {
  const [items, disciplines] = await Promise.all([
    sb
      .from(kind === 'service' ? 'services' : 'portfolio')
      .select(kind === 'service' ? 'id,slug,title,status,discipline_id' : 'id,slug,title,status')
      .eq('tenant_id', auth.tenantId)
      .neq('status', 'archived')
      .order('sort_order', { ascending: true })
      .limit(ITEM_LIMIT),
    kind === 'service'
      ? sb
          .from('disciplines')
          .select('id,name')
          .eq('tenant_id', auth.tenantId)
          .neq('status', 'archived')
          .order('sort_order', { ascending: true })
      : Promise.resolve({ data: [] as Row[], error: null }),
  ]);
  if (items.error) throw new Error(`read ${kind} items: ${items.error.message}`);
  if (disciplines.error) throw new Error(`read disciplines: ${disciplines.error.message}`);
  const groups = templateGroups(
    kind,
    (items.data ?? []) as unknown as Row[],
    (disciplines.data ?? []) as unknown as Row[],
  );
  return {
    kind,
    groups,
    selected: pickItem(groups, wanted),
    builtIn: builtInTemplateCopy(kind),
    access: templateAccess(auth.role, kind),
  };
}
