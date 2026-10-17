import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import {
  PageVisibilityWriteSchema,
  riyadhDayOf,
  riyadhMidnight,
  type PageNote,
  type PagePasswordWrite,
  type PageVisibilityWrite,
} from '@schemas/visibility';
import {
  HOME_SLUG,
  PAGE_PATHS,
  isVisibilityPageSlug,
  type VisibilityPageSlug,
  type VisibilityTemplate,
} from '@/lib/visibility/routes';
import { AuthorizationError } from '@/lib/authz/errors';
import { NotFoundError, OptimisticLockError, ValidationError } from './errors';
import { HOME_REFUSAL } from './visibilityCopy';
import { translateWriteError, updateRow, type ConstraintFields } from './crud';

// Page visibility's server half (Admin v2 U14a): what `/api/admin/page-visibility` lists and
// how it saves one setting, shared by the screen's route and the legacy `nav_visible` alias.
// Under the caller's RLS-bound client throughout: `page_visibility` is Admin + Developer in
// both layers (0057), and the rules the database holds are checked here first, so an editor
// reads a sentence, never a constraint name.

/** Payload key → the columns it writes; the target's only on create (a row never moves). */
const MODE_KEYS = {
  mode: 'mode',
  redirectPageId: 'redirect_page_id',
  hideFrom: 'hide_from',
  showOn: 'show_on',
} as const;

/**
 * The entity as the release registry binds it (src/lib/release/registry.ts, Admin v2 R2's
 * contract): its table, capability, schema, and the payload → column mapping a save and a
 * staged change share. A write is a full replace, as entity SEO's: every extra a payload
 * leaves out is written as null.
 */
export const PAGE_VISIBILITY = {
  table: 'page_visibility',
  entity: 'page_visibility',
  writeCap: 'maintenance.manage',
  readCaps: ['maintenance.manage'],
  WriteSchema: PageVisibilityWriteSchema,
  /** The mode and its extras, the dates as their Riyadh midnights. */
  toRow: (input: Pick<PageVisibilityWrite, keyof typeof MODE_KEYS>) => ({
    mode: input.mode,
    redirect_page_id: input.redirectPageId,
    hide_from: input.hideFrom ? riyadhMidnight(input.hideFrom) : null,
    show_on: input.showOn ? riyadhMidnight(input.showOn) : null,
  }),
  /** The target's column, written only on the insert. */
  target: (input: Pick<PageVisibilityWrite, 'target'>) =>
    'pageId' in input.target
      ? { page_id: input.target.pageId }
      : { template: input.target.template },
  fields: {
    target: ['page_id', 'template'],
    ...Object.fromEntries(Object.entries(MODE_KEYS).map(([key, column]) => [key, [column]])),
  } as Readonly<Record<string, readonly string[]>>,
  /**
   * Columns a release may carry that no payload key of this schema writes. `note`, the
   * password gate's message, is written by the password door (`savePagePassword`, which has
   * its own schema) because setting it is setting a password; a release still stages it,
   * as 0061's registry row says.
   */
  restoreOnlyColumns: ['note'] as readonly string[],
  /**
   * Written by the database alone, and never staged (0061's exempt set): the version a
   * password was set with. A secret is immediate (P-3), so the number that ends one is too.
   */
  immediateColumns: ['password_version'] as readonly string[],
} as const;

export { HOME_REFUSAL } from './visibilityCopy';

/** The two templates, as the screen names them. */
export const TEMPLATE_LABELS: Readonly<
  Record<VisibilityTemplate, { title: string; path: string }>
> = {
  service: { title: 'Service page', path: '/services/…' },
  case_study: { title: 'Case study page', path: '/portfolio/…' },
};

/** The table's rules, each on the field an editor fixes. */
export const VISIBILITY_CONSTRAINTS: ConstraintFields = {
  page_visibility_page_unique: {
    message: 'Someone else just set this page. Reload and try again.',
  },
  page_visibility_template_unique: {
    message: 'Someone else just set this template. Reload and try again.',
  },
  page_visibility_redirect_fk: {
    field: 'redirectPageId',
    message: 'That page no longer exists. Choose another one.',
  },
  page_visibility_redirect_not_self: {
    field: 'redirectPageId',
    message: 'A page cannot send its visitors to itself.',
  },
  page_visibility_dates_order: {
    field: 'showOn',
    message: 'Show again on must be after Hide from.',
  },
  page_visibility_template_modes: {
    field: 'mode',
    message: 'A template is either visible or hidden.',
  },
};

const ROW_COLUMNS =
  'id,page_id,template,mode,redirect_page_id,hide_from,show_on,note,password_version,version,updated_at';

/** A setting as the screen reads it: the dates as Riyadh days. */
export interface VisibilitySetting {
  id: string;
  mode: 'public' | 'hidden' | 'link' | 'password';
  redirectPageId: string | null;
  hideFrom: string | null;
  showOn: string | null;
  /**
   * A password page's message above the box. The password itself is never here: nothing
   * returns it, and the screen asks for it again to change anything about it (0061).
   */
  note: PageNote | null;
  /** How many times a password has been set. Shown as "set", never the password. */
  passwordVersion: number;
  version: number;
  updatedAt: string | null;
}

export interface VisibilityPageItem {
  kind: 'page';
  id: string;
  slug: VisibilityPageSlug;
  title: { en: string; ar?: string };
  path: string;
  setting: VisibilitySetting | null;
}

export interface VisibilityTemplateItem {
  kind: 'template';
  template: VisibilityTemplate;
  title: string;
  path: string;
  /** Published pages it renders now, or null when the count could not be read. */
  count: number | null;
  setting: VisibilitySetting | null;
}

type Row = Record<string, unknown>;

const dayOf = (value: unknown): string | null =>
  typeof value === 'string' ? riyadhDayOf(value) : null;

/** The stored message, as the drawer edits it: {en, ar}, either side absent. */
function noteOf(value: unknown): PageNote | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Row;
  const out: PageNote = {};
  for (const lang of ['en', 'ar'] as const) {
    const line = raw[lang];
    if (typeof line === 'string' && line.trim().length > 0) out[lang] = line;
  }
  return out.en === undefined && out.ar === undefined ? null : out;
}

function settingOf(row: Row | undefined): VisibilitySetting | null {
  if (!row || typeof row['id'] !== 'string') return null;
  const mode = row['mode'];
  return {
    id: row['id'],
    mode: mode === 'hidden' || mode === 'link' || mode === 'password' ? mode : 'public',
    redirectPageId: typeof row['redirect_page_id'] === 'string' ? row['redirect_page_id'] : null,
    hideFrom: dayOf(row['hide_from']),
    showOn: dayOf(row['show_on']),
    note: noteOf(row['note']),
    passwordVersion: typeof row['password_version'] === 'number' ? row['password_version'] : 0,
    version: typeof row['version'] === 'number' ? row['version'] : 1,
    updatedAt: typeof row['updated_at'] === 'string' ? row['updated_at'] : null,
  };
}

function titleOf(value: unknown, fallback: string): { en: string; ar?: string } {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Row;
    const en = typeof v['en'] === 'string' && v['en'].trim() ? v['en'] : fallback;
    return typeof v['ar'] === 'string' && v['ar'].trim() ? { en, ar: v['ar'] } : { en };
  }
  return { en: fallback };
}

/** The tenant's CMS pages the route map knows, in the map's order, by slug. */
export async function readVisibilityPages(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<{ id: string; slug: VisibilityPageSlug; title: unknown }[]> {
  const { data, error } = await sb
    .from('pages')
    .select('id,slug,title')
    .eq('tenant_id', auth.tenantId)
    .limit(200);
  if (error) throw new Error(`read pages: ${error.message}`);
  const order = Object.keys(PAGE_PATHS);
  return ((data ?? []) as Row[])
    .map((row) => ({
      id: String(row['id']),
      slug: String(row['slug'] ?? '').toLowerCase(),
      title: row['title'],
    }))
    .filter((row): row is { id: string; slug: VisibilityPageSlug; title: unknown } =>
      isVisibilityPageSlug(row.slug),
    )
    .sort((a, b) => order.indexOf(a.slug) - order.indexOf(b.slug));
}

async function publishedCount(sb: SupabaseClient, auth: AuthContext, table: string) {
  const { count, error } = await sb
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', auth.tenantId)
    .eq('status', 'published');
  return error ? null : (count ?? 0);
}

/** Every page in the route map that has a row in `pages`, then the two templates. */
export async function listVisibility(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<{ pages: VisibilityPageItem[]; templates: VisibilityTemplateItem[] }> {
  const [pages, rowsResult, services, projects] = await Promise.all([
    readVisibilityPages(sb, auth),
    sb.from('page_visibility').select(ROW_COLUMNS).eq('tenant_id', auth.tenantId).limit(50),
    publishedCount(sb, auth, 'services'),
    publishedCount(sb, auth, 'portfolio'),
  ]);
  if (rowsResult.error) throw new Error(`read page_visibility: ${rowsResult.error.message}`);
  const rows = (rowsResult.data ?? []) as Row[];
  const byPage = new Map(rows.filter((r) => r['page_id']).map((r) => [String(r['page_id']), r]));
  const byTemplate = new Map(
    rows.filter((r) => r['template']).map((r) => [String(r['template']), r]),
  );
  return {
    pages: pages.map((page) => ({
      kind: 'page',
      id: page.id,
      slug: page.slug,
      title: titleOf(page.title, page.slug),
      path: PAGE_PATHS[page.slug],
      setting: settingOf(byPage.get(page.id)),
    })),
    templates: (['service', 'case_study'] as const).map((template) => ({
      kind: 'template',
      template,
      title: TEMPLATE_LABELS[template].title,
      path: TEMPLATE_LABELS[template].path,
      count: template === 'service' ? services : projects,
      setting: settingOf(byTemplate.get(template)),
    })),
  };
}

export interface VisibilitySaveResult {
  row: Row;
  /** The columns the save changed (names only, for the audit row). */
  fields: string[];
  /** What the change touches: a page by its slug, or a template. */
  target:
    | { kind: 'page'; slug: VisibilityPageSlug; id: string }
    | { kind: 'template'; template: VisibilityTemplate };
}

/**
 * Saves one page's or template's setting: insert at version 0, else an optimistic update
 * (409 when someone saved first). Checks first what the database refuses too: the homepage
 * stays visible, a redirect goes to another page the route map knows, the window is in order.
 */
export async function saveVisibility(
  sb: SupabaseClient,
  auth: AuthContext,
  input: PageVisibilityWrite,
): Promise<VisibilitySaveResult> {
  const pages = await readVisibilityPages(sb, auth);

  let target: VisibilitySaveResult['target'];
  if ('pageId' in input.target) {
    const page = pages.find((p) => p.id === (input.target as { pageId: string }).pageId);
    if (!page) throw new NotFoundError('page');
    if (page.slug === HOME_SLUG && input.mode !== 'public') {
      throw new ValidationError(HOME_REFUSAL, 'mode');
    }
    target = { kind: 'page', slug: page.slug, id: page.id };
  } else {
    target = { kind: 'template', template: input.target.template };
  }

  if (input.redirectPageId !== null) {
    if (target.kind === 'page' && input.redirectPageId === target.id) {
      throw new ValidationError('A page cannot send its visitors to itself.', 'redirectPageId');
    }
    if (!pages.some((p) => p.id === input.redirectPageId)) {
      throw new ValidationError('Choose one of the pages in the list.', 'redirectPageId');
    }
  }

  const values = PAGE_VISIBILITY.toRow(input);
  const key = PAGE_VISIBILITY.target(input);

  const existing = await sb
    .from('page_visibility')
    .select(ROW_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .match(key)
    .maybeSingle();
  if (existing.error) throw new Error(`read page_visibility: ${existing.error.message}`);
  const before = existing.data as Row | null;

  if (!before) {
    if (input.version !== 0) throw new OptimisticLockError('page_visibility');
    const { data, error } = await sb
      .from('page_visibility')
      .insert({ ...key, ...values, tenant_id: auth.tenantId })
      .select(ROW_COLUMNS)
      .single();
    if (error) {
      // Someone created the row between the read and the insert: a conflict, not bad input.
      if (error.code === '23505') throw new OptimisticLockError('page_visibility');
      throw translateWriteError(error, 'page_visibility', 'write', VISIBILITY_CONSTRAINTS);
    }
    const fields = Object.entries(values)
      .filter(([column, value]) => column === 'mode' || value !== null)
      .map(([column]) => column);
    return { row: data as Row, fields, target };
  }

  const row = await updateRow<Row>(
    sb,
    'page_visibility',
    auth,
    String(before['id']),
    input.version,
    values,
    ROW_COLUMNS,
    { constraints: VISIBILITY_CONSTRAINTS },
  );
  const same = (column: keyof typeof values) => {
    const was = before[column] ?? null;
    const now = values[column];
    if (column === 'hide_from' || column === 'show_on') {
      return (
        (was === null ? null : Date.parse(String(was))) === (now === null ? null : Date.parse(now))
      );
    }
    return was === now;
  };
  const fields = (Object.keys(values) as (keyof typeof values)[]).filter((c) => !same(c));
  return { row, fields, target };
}

/** A saved row, as the screen reads it. */
export const settingOfRow = settingOf;

/**
 * Puts one page behind a password (Admin v2 U14b). The Worker never sees the secret twice:
 * it hands it straight to `public.set_page_password`, which checks the live role, hashes it
 * with bcrypt, writes the mode, the message and the new version, and chains its own audit
 * row — all in one transaction, so a page is never in password mode without a password.
 * Nothing about the password is returned, logged or kept here.
 *
 * The version the drawer read is checked first, as the ordinary save checks it: a page
 * someone else changed in the meantime is a 409, not a silent overwrite. The homepage and a
 * page of another tenant are refused by the function as well.
 */
export async function savePagePassword(
  sb: SupabaseClient,
  auth: AuthContext,
  input: PagePasswordWrite,
): Promise<{ setting: VisibilitySetting; slug: VisibilityPageSlug; pageId: string }> {
  const pages = await readVisibilityPages(sb, auth);
  const page = pages.find((p) => p.id === input.pageId);
  if (!page) throw new NotFoundError('page');
  if (page.slug === HOME_SLUG) throw new ValidationError(HOME_REFUSAL, 'mode');

  const existing = await sb
    .from('page_visibility')
    .select(ROW_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('page_id', page.id)
    .maybeSingle();
  if (existing.error) throw new Error(`read page_visibility: ${existing.error.message}`);
  const before = settingOf((existing.data ?? undefined) as Row | undefined);
  if ((before?.version ?? 0) !== input.version) throw new OptimisticLockError('page_visibility');

  const { error } = await sb.rpc('set_page_password', {
    p_tenant: auth.tenantId,
    p_page_id: page.id,
    p_password: input.password,
    p_note: input.note,
  });
  if (error) {
    // 42501 is the function's own live check (a demoted token), 22023 its argument checks.
    if (error.code === '42501') throw new AuthorizationError('maintenance.manage', 'live check');
    if (error.code === '22023') {
      throw new ValidationError('That password is too short or too long.', 'password');
    }
    throw translateWriteError(error, 'page_visibility', 'write', VISIBILITY_CONSTRAINTS);
  }

  const after = await sb
    .from('page_visibility')
    .select(ROW_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('page_id', page.id)
    .maybeSingle();
  if (after.error) throw new Error(`read page_visibility: ${after.error.message}`);
  const setting = settingOf((after.data ?? undefined) as Row | undefined);
  if (!setting) throw new NotFoundError('page_visibility');
  return { setting, slug: page.slug, pageId: page.id };
}
