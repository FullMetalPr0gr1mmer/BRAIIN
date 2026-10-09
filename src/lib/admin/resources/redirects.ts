import { RedirectUpdateSchema, RedirectWriteSchema } from '@schemas/admin';
import { sanitizeHref } from '@/lib/content/tiptap';
import { ValidationError } from '../errors';
import {
  REDIRECT_MAP_LIMIT,
  isReservedRedirectPath,
  normalizeRedirectPath,
} from '@/lib/http/redirects';
import { chainRefusal, liveRouteRefusal, type RedirectRow } from '../redirectRules';
import { syncRedirectsToEdge } from '../redirectSync';
import type { ResourceConfig } from '../resource';
import { pick, type Input } from './shared';

// Redirects (Admin + SEO).

/**
 * What a redirect's audit row and response carry beside the sync outcome: the rule itself.
 * Paths are public URLs, not PII, and "which rule, and did the edge take it" belongs in
 * one row — an audit entry naming only an id is useless once the row is deleted.
 */
const ruleOf = (row: Record<string, unknown>) => ({
  source_path: row['source_path'] ?? null,
  target_path: row['target_path'] ?? null,
  status: row['status'] ?? null,
});

/**
 * Every save and delete rebuilds the tenant's edge snapshot (src/lib/admin/redirectSync.ts,
 * design-port R3-1). Both hooks run through the kernel's `runHook`, so a KV failure is
 * `kvSynced: false` in the response and the audit row — never a failed save.
 *
 * The domain rules live in `assertWritable`, which judges the MERGED row: the old
 * `toRow` loop check saw only the patch, so a PATCH sending only `targetPath` equal to
 * the stored source sailed through and made a loop.
 */
export const redirectResource: ResourceConfig = {
  table: 'redirects',
  entity: 'redirect',
  writeCap: 'redirects.manage',
  // §5 grants SEO the whole module ("full"), deletes included — the content default
  // (`content.archiveDelete`, Admin-only) would refuse the role that owns the table.
  deleteCap: 'redirects.manage',
  listColumns: 'id,source_path,target_path,status,version,created_at',
  columns: 'id,source_path,target_path,status,version,created_at,updated_at',
  orderBy: { column: 'source_path', ascending: true },
  searchColumn: 'source_path',
  createSchema: RedirectWriteSchema,
  updateSchema: RedirectUpdateSchema,
  constraintFields: {
    redirects_tenant_id_source_path_key: {
      field: 'sourcePath',
      message: 'A rule for this source already exists — edit that one.',
    },
  },
  toRow: (input) => {
    const values = pick(input as Input, {
      sourcePath: 'source_path',
      targetPath: 'target_path',
      status: 'status',
    });
    if (typeof values['source_path'] === 'string') {
      // One spelling per source: the edge map is keyed by the normalised path, and two
      // rows differing only by a trailing slash would silently shadow each other.
      values['source_path'] = normalizeRedirectPath(values['source_path']);
    }
    if ('target_path' in values) {
      // The target becomes a Location header. Same scheme allowlist as nav links and
      // rich-text hrefs: the schema already limits it to site-relative or https://, this
      // is the shared belt-and-braces.
      const href = sanitizeHref(values['target_path']);
      if (!href) throw new ValidationError('unsupported link scheme', 'targetPath');
      values['target_path'] = href;
    }
    return values;
  },
  assertWritable: async (merged, { changed, sb, auth }) => {
    if (!('source_path' in changed) && !('target_path' in changed)) return;
    const source = String(merged['source_path'] ?? '');
    const target = String(merged['target_path'] ?? '');

    if (isReservedRedirectPath(source)) {
      throw new ValidationError(
        'this path is reserved (the admin, its API, the health probe and the asset routes cannot be redirected)',
        'sourcePath',
      );
    }

    const own: RedirectRow = {
      id: typeof merged['id'] === 'string' ? merged['id'] : undefined,
      source_path: source,
      target_path: target,
    };
    // Self-loop first (pure) so the obvious mistake costs no reads.
    const selfLoop = chainRefusal(own, []);
    if (selfLoop) throw new ValidationError(selfLoop.message, selfLoop.field);

    // The tenant's whole rule set, so the chain check is complete: a prefix read
    // (`LIKE '/old%'`, capped) let an exact `/old` hide behind look-alike rows, and the
    // /ar twin fallback means the rows that interact are not a prefix of anything. One
    // parameter-encoded read — never a PostgREST `.or()` string built from editor input
    // — bounded like the snapshot this same request rebuilds next.
    const { data, error } = await sb
      .from('redirects')
      .select('id,source_path,target_path')
      .eq('tenant_id', auth.tenantId)
      .order('source_path', { ascending: true })
      .limit(REDIRECT_MAP_LIMIT);
    if (error) throw new Error(`read redirects: ${error.message}`);
    const chain = chainRefusal(own, (data ?? []) as RedirectRow[]);
    if (chain) throw new ValidationError(chain.message, chain.field);

    if ('source_path' in changed) {
      const live = await liveRouteRefusal(source, sb, auth);
      if (live) throw new ValidationError(live.message, live.field);
    }
  },
  afterWrite: async ({ auth, sb, row }) => ({
    ...ruleOf(row),
    ...(await syncRedirectsToEdge(sb, auth)),
  }),
  afterDelete: async ({ auth, sb, row }) => ({
    ...ruleOf(row),
    ...(await syncRedirectsToEdge(sb, auth)),
  }),
};
