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
  ROUTE_SLUG_LIST,
  isVisibilityPageSlug,
  pagePathOf,
  takesRedirects,
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

/** The columns a setting is read with (the staged branch reads them too, Admin v2 R14b). */
export const VISIBILITY_ROW_COLUMNS =
  'id,page_id,template,mode,redirect_page_id,hide_from,show_on,note,password_version,version,updated_at';
const ROW_COLUMNS = VISIBILITY_ROW_COLUMNS;

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
  /**
   * Whether a hidden page may send its visitors here (`takesRedirects`): a route page, or a
   * published custom page. The drawer offers only these (E11 code review, CR1).
   */
  redirectable: boolean;
  /** The live setting, or null for a page that has none (visible to everyone). */
  setting: VisibilitySetting | null;
  /** Release mode only (Admin v2 R14b): the setting's unpublished change, or null. */
  pending?: VisibilityPending | null;
}

export interface VisibilityTemplateItem {
  kind: 'template';
  template: VisibilityTemplate;
  title: string;
  path: string;
  /** Published pages it renders now, or null when the count could not be read. */
  count: number | null;
  /** The live setting, or null for a template that has none (visible to everyone). */
  setting: VisibilitySetting | null;
  /** Release mode only (Admin v2 R14b): the setting's unpublished change, or null. */
  pending?: VisibilityPending | null;
}

/**
 * A setting's unpublished change (Admin v2 R14b, src/lib/release/stagedPageVisibility.ts):
 * what the setting will be once it is published (live with the change laid over it), and the
 * change the next save names. Never on an answer while releases are off.
 */
export interface VisibilityPending {
  /** The setting as published would leave it; null when the stored change cannot be read. */
  setting: VisibilitySetting | null;
  draftId: string;
  draftVersion: number;
  op: 'create' | 'update' | 'delete';
  /** A scheduled release holds it: it cannot change until it goes live or is unscheduled. */
  scheduled: boolean;
  /** Columns the live setting moved in since the change was made. */
  conflict: string[];
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

/** A CMS page as page visibility reads it: its id, slug, title and status. */
export interface VisibilityPageRow {
  id: string;
  slug: VisibilityPageSlug;
  title: unknown;
  status: unknown;
}

const PAGE_COLUMNS = 'id,slug,title,status';

/**
 * Custom pages one read takes, and the most reads a listing makes: the screen lists at most
 * 2,000 custom pages, by address (E11 code review, CR2). The route pages are read apart, so
 * custom pages never crowd them out.
 */
export const VISIBILITY_PAGE_BATCH = 200;
export const VISIBILITY_PAGE_BATCHES = 10;

function pageRows(data: unknown): VisibilityPageRow[] {
  return ((data ?? []) as Row[])
    .map((row) => ({
      id: String(row['id']),
      slug: String(row['slug'] ?? '').toLowerCase(),
      title: row['title'],
      status: row['status'],
    }))
    .filter((row): row is VisibilityPageRow => isVisibilityPageSlug(row.slug));
}

/**
 * The tenant's CMS pages a route renders: the route map's, in its order, then the custom pages
 * (Admin v2 E11) by slug. With `ids`, only those pages (a save names its page and its
 * redirect's: one read, whatever the tenant holds). Without, the listing: the route pages in
 * one read, then the custom pages ordered by slug and id, a batch at a time, so the seven
 * route pages are never cut by a bound the custom pages fill (E11 code review, CR2).
 */
export async function readVisibilityPages(
  sb: SupabaseClient,
  auth: AuthContext,
  ids?: readonly string[],
): Promise<VisibilityPageRow[]> {
  const order = Object.keys(PAGE_PATHS);
  const at = (slug: string) => {
    const i = order.indexOf(slug);
    return i === -1 ? order.length : i;
  };
  const sorted = (rows: VisibilityPageRow[]) =>
    rows.sort((a, b) => at(a.slug) - at(b.slug) || a.slug.localeCompare(b.slug));

  if (ids !== undefined) {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return [];
    const { data, error } = await sb
      .from('pages')
      .select(PAGE_COLUMNS)
      .eq('tenant_id', auth.tenantId)
      .in('id', wanted);
    if (error) throw new Error(`read pages: ${error.message}`);
    return sorted(pageRows(data).filter((row) => wanted.includes(row.id)));
  }

  const route = await sb
    .from('pages')
    .select(PAGE_COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .in('slug', order);
  if (route.error) throw new Error(`read pages: ${route.error.message}`);
  const out = pageRows(route.data).filter((row) => order.includes(row.slug));
  for (let batch = 0; batch < VISIBILITY_PAGE_BATCHES; batch += 1) {
    const from = batch * VISIBILITY_PAGE_BATCH;
    const { data, error } = await sb
      .from('pages')
      .select(PAGE_COLUMNS)
      .eq('tenant_id', auth.tenantId)
      .not('slug', 'in', ROUTE_SLUG_LIST)
      .order('slug', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + VISIBILITY_PAGE_BATCH - 1);
    if (error) throw new Error(`read pages: ${error.message}`);
    const rows = (data ?? []) as Row[];
    out.push(...pageRows(rows).filter((row) => !order.includes(row.slug)));
    if (rows.length < VISIBILITY_PAGE_BATCH) break;
  }
  return sorted(out);
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
  return (await listVisibilityWithRows(sb, auth)).list;
}

/**
 * The listing, and the live rows it was built from (Admin v2 R14b: the staged branch lays each
 * row's pending change over it, src/lib/release/stagedPageVisibility.ts). The same reads as the
 * listing alone: nothing more is asked.
 */
export async function listVisibilityWithRows(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<{
  list: { pages: VisibilityPageItem[]; templates: VisibilityTemplateItem[] };
  rows: Row[];
}> {
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
  const list = {
    pages: pages.map((page) => ({
      kind: 'page' as const,
      id: page.id,
      slug: page.slug,
      title: titleOf(page.title, page.slug),
      path: pagePathOf(page.slug),
      redirectable: takesRedirects(page.slug, page.status),
      setting: settingOf(byPage.get(page.id)),
    })),
    templates: (['service', 'case_study'] as const).map((template) => ({
      kind: 'template' as const,
      template,
      title: TEMPLATE_LABELS[template].title,
      path: TEMPLATE_LABELS[template].path,
      count: template === 'service' ? services : projects,
      setting: settingOf(byTemplate.get(template)),
    })),
  };
  return { list, rows };
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

/** What a save says when the page it would send visitors to cannot take them (CR1). */
export const REDIRECT_UNPUBLISHED =
  'That page is not published, so its visitors would find nothing there. Choose a published page.';

/**
 * Saves one page's or template's setting: insert at version 0, else an optimistic update
 * (409 when someone saved first). Checks first what the database refuses too: the homepage
 * stays visible, a redirect goes to another page the route map knows, the window is in order.
 * And one rule the database does not hold: a redirect goes to a page that renders, a route
 * page or a PUBLISHED custom page (E11 code review, CR1). A target unpublished or deleted
 * later is dropped from the edge's snapshot instead (visibilitySync.ts), its visitors then
 * seeing the 404 a hidden page with no redirect shows.
 */
export async function saveVisibility(
  sb: SupabaseClient,
  auth: AuthContext,
  input: PageVisibilityWrite,
): Promise<VisibilitySaveResult> {
  const target = await checkVisibilityWrite(sb, auth, input);
  return writeVisibility(sb, auth, input, target);
}

/**
 * The rules a setting is held to before anything is written, live or staged (Admin v2 R14b:
 * the staged branch runs them too, at stage time): the page exists, the homepage stays
 * visible, a redirect goes to another page that renders. Returns what the change touches.
 */
export async function checkVisibilityWrite(
  sb: SupabaseClient,
  auth: AuthContext,
  input: PageVisibilityWrite,
): Promise<VisibilitySaveResult['target']> {
  // Only the pages this save names: its own and its redirect's (CR2: one read, never a bound).
  const pages = await readVisibilityPages(sb, auth, [
    ...('pageId' in input.target ? [input.target.pageId] : []),
    ...(input.redirectPageId !== null ? [input.redirectPageId] : []),
  ]);

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
    const to = pages.find((p) => p.id === input.redirectPageId);
    if (!to) {
      throw new ValidationError('Choose one of the pages in the list.', 'redirectPageId');
    }
    if (!takesRedirects(to.slug, to.status)) {
      throw new ValidationError(REDIRECT_UNPUBLISHED, 'redirectPageId');
    }
  }
  return target;
}

/** The live write of a checked setting (releases off). */
async function writeVisibility(
  sb: SupabaseClient,
  auth: AuthContext,
  input: PageVisibilityWrite,
  target: VisibilitySaveResult['target'],
): Promise<VisibilitySaveResult> {
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
  const pages = await readVisibilityPages(sb, auth, [input.pageId]);
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
