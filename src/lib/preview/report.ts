// What one preview render did, and whether its page can be trusted (Admin v2 R8;
// docs/admin-v2/README.md "Preview": a fail-closed ribbon when a render touched the anon
// client or served zero overlay reads). Pure: the dataset and the emulator fill a report,
// `assessPreview` turns it into the ribbon's verdict, and R9 renders the verdict with the
// copy below (P-12: plain, warm, no em or en dashes, never the brand). R8 renders nothing.

/** A pending change that could not be laid over the page, and why. */
export interface InvalidDraft {
  draftId: string;
  entityType: string;
  entityId: string;
  /**
   * `invalid`: its payload fails the entity's schema or rules; `drift`: it writes a column
   * the registry does not allow; `live-missing`: it edits a row that no longer exists;
   * `target-changed`: an SEO change names a different page than its live row.
   */
  reason: 'invalid' | 'drift' | 'live-missing' | 'target-changed';
}

export interface PreviewReport {
  /** Successful top-level reads the emulator answered. */
  reads: number;
  /** The same, per table. */
  tables: Record<string, number>;
  /** Lookups of the content client that found no scope while this one was open. */
  anonLookups: number;
  /** Operations, select forms or tables the emulator refused (names only). */
  unsupported: string[];
  /** What the page asked for that the preview does not show (search, redirects, theme). */
  notPreviewed: string[];
  /** Tables with more rows than the preview reads. */
  truncated: string[];
  /** Tables the person's own client could not read. */
  failedTables: string[];
  /** Rows of another tenant the reader returned (and the dataset dropped). */
  foreignTenantRows: number;
  /** Pending changes laid over the page. */
  overlaid: number;
  /** Pending changes left out, with the reason. */
  invalid: InvalidDraft[];
  /** Pending changes in areas this person may not read: counted, never listed. */
  draftsNotShown: number;
  /** Pending changes this person may read (the ribbon's count), from the raw list. */
  pending: number;
  /**
   * Changes shown that leave a flagged design sample live (`is_placeholder`, 0025/0028).
   * Shown, but production refuses them unless the owner allowed samples on that table
   * (0027): the preview cannot tell which environment it is in (R9).
   */
  samples: number;
}

export function createReport(): PreviewReport {
  return {
    reads: 0,
    tables: {},
    anonLookups: 0,
    unsupported: [],
    notPreviewed: [],
    truncated: [],
    failedTables: [],
    foreignTenantRows: 0,
    overlaid: 0,
    invalid: [],
    draftsNotShown: 0,
    pending: 0,
    samples: 0,
  };
}

/** Adds a name to a list once. */
export function noteOnce(list: string[], name: string): void {
  if (!list.includes(name)) list.push(name);
}

export type UntrustedReason =
  'no-reads' | 'anon-lookup' | 'unsupported' | 'truncated' | 'failed-table' | 'foreign-tenant';

export type PreviewVerdict =
  | {
      state: 'ok';
      pending: number;
      invalid: InvalidDraft[];
      notPreviewed: string[];
      samples: number;
    }
  | { state: 'untrusted'; reasons: UntrustedReason[] };

/**
 * Fail closed: the page is untrusted when the scope was lost entirely (no read went through
 * the overlay), when any lookup reached the anon client while the scope was open, when the
 * emulator refused something (the loader's own try/catch would otherwise show an empty
 * section as if it were the truth), when a table was cut short or could not be read, or
 * when the reader returned another tenant's rows. Invalid drafts and what is not
 * previewed leave the page trustworthy: the ribbon lists them.
 */
export function assessPreview(r: PreviewReport): PreviewVerdict {
  const reasons: UntrustedReason[] = [];
  if (r.reads === 0) reasons.push('no-reads');
  if (r.anonLookups > 0) reasons.push('anon-lookup');
  if (r.unsupported.length > 0) reasons.push('unsupported');
  if (r.truncated.length > 0) reasons.push('truncated');
  if (r.failedTables.length > 0) reasons.push('failed-table');
  if (r.foreignTenantRows > 0) reasons.push('foreign-tenant');
  if (reasons.length > 0) return { state: 'untrusted', reasons };
  return {
    state: 'ok',
    pending: r.pending,
    invalid: [...r.invalid],
    notPreviewed: [...r.notPreviewed],
    samples: r.samples,
  };
}

/**
 * What R9 logs to system_logs once per untrusted render: counts and names only (table
 * names, operation names), never a row, a value, a draft's payload or its id.
 */
export function previewLogFields(r: PreviewReport): Record<string, number | string[]> {
  return {
    reads: r.reads,
    tables: Object.keys(r.tables).sort(),
    anonLookups: r.anonLookups,
    unsupported: [...r.unsupported],
    notPreviewed: [...r.notPreviewed],
    truncated: [...r.truncated],
    failedTables: [...r.failedTables],
    foreignTenantRows: r.foreignTenantRows,
    overlaid: r.overlaid,
    invalid: r.invalid.length,
    draftsNotShown: r.draftsNotShown,
    pending: r.pending,
    samples: r.samples,
  };
}

/**
 * The ribbon's words, as data: R9 renders them and the help guide quotes them. `{n}` is a
 * count, written with the person's own digits by the renderer.
 */
export const PREVIEW_COPY = {
  ok: {
    none: 'Preview. Not live yet. No unpublished changes.',
    one: 'Preview. Not live yet. 1 unpublished change.',
    other: 'Preview. Not live yet. {n} unpublished changes.',
  },
  /** A page behind a password: the preview shows what visitors get, the prompt (R9). */
  locked: 'Preview of what visitors see.',
  untrusted:
    'This preview may be showing the live site instead of your changes. Reload to try again.',
  reasons: {
    'no-reads': "This page didn't read any of your changes.",
    'anon-lookup': 'Part of this page was read from the live site.',
    unsupported: "Part of this page asks for something the preview can't show yet.",
    truncated: 'There is more content here than the preview can read at once.',
    'failed-table': "Part of this page couldn't be loaded.",
    'foreign-tenant': 'Some content came back that this preview should never see.',
  } satisfies Record<UntrustedReason, string>,
  invalid: {
    one: "1 change can't be shown. Open it to fix it.",
    other: "{n} changes can't be shown. Open them to fix them.",
  },
  samples: {
    one: '1 change puts a design sample on the page. The live site refuses that unless the owner has allowed samples there.',
    other:
      '{n} changes put design samples on the page. The live site refuses that unless the owner has allowed samples there.',
  },
  /**
   * A published version shown as it was (Admin v2 R10, `?v=`): its content over today's code,
   * so the lead says so; what the preview does not show is as it is now, not "when you publish".
   */
  version: {
    lead: "Preview of version {v}, as it was published. It's shown with today's design and pictures.",
    invalid: {
      one: "1 item of this version can't be shown as it was.",
      other: "{n} items of this version can't be shown as they were.",
    },
    notPreviewed: 'Redirects, the theme and who can see a page are shown as they are now.',
  },
  notPreviewed: {
    search: "Search results aren't previewed.",
    rpc: "Part of this page isn't previewed.",
    redirect: "Redirect changes aren't previewed. They apply when you publish.",
    custom_theme: "Theme changes aren't previewed here yet.",
    page_visibility: "Changes to who can see a page aren't previewed. They apply when you publish.",
  },
} as const;

export type NotPreviewedKey = keyof typeof PREVIEW_COPY.notPreviewed;

/**
 * The copy key for one `notPreviewed` name: `rpc:search_content` and `rpc:search_suggest`
 * read as search, any other function as a part of the page, a registry type as itself.
 */
export function notPreviewedKey(name: string): NotPreviewedKey {
  if (name.startsWith('rpc:')) return name.startsWith('rpc:search_') ? 'search' : 'rpc';
  return name in PREVIEW_COPY.notPreviewed ? (name as NotPreviewedKey) : 'rpc';
}
