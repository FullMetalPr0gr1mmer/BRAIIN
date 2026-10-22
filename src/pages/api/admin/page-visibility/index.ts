import { PageVisibilityWriteSchema } from '@schemas/visibility';
import { defineAdminRoute } from '@/lib/admin/route';
import { purgeAfterSave } from '@/lib/http/purge';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { listVisibility, saveVisibility, settingOfRow } from '@/lib/admin/pageVisibility';
import {
  edgeVisibilityStatus,
  syncVisibilityToEdge,
  visibilityPurgeTags,
} from '@/lib/admin/visibilitySync';

// Page visibility (Admin v2 U14a), `maintenance.manage` (Admin + Developer, §5 "Maintenance /
// hidden pages / page visibility"). RLS agrees in both layers (0057: the JWT role and the
// live profile), so this route is the secondary check, never the only one.
//
//   GET  every page of the route map that has a `pages` row, then the two templates, each
//        with its setting or none (public), and what the edge holds.
//   PUT  one page's or template's setting (packages/schemas/visibility.ts). The person is
//        re-read first (liveRecheck: a demoted Developer's next save is a 403 now, not at the
//        token's expiry); then the save (insert at version 0, else versioned, 409 when
//        someone saved first); then the whole snapshot is rebuilt into KV, and the answer
//        says whether the edge took it (`kvSynced`). Immediate until releases switch on
//        (D8): R3 adds the staged branch here, and R7 re-syncs after an apply or a rollback.
//
// `purgeTags` is what a cache in front of the Worker has to clear for this change (a page that
// leaves public must leave every cached copy): after the save they are purged through the
// purge seam (Admin v2 R7, src/lib/http/purge.ts), which sends nothing while no cache zone is
// set up (O-3), so the answer is as before.

export const prerender = false;

export const GET = defineAdminRoute({
  cap: 'maintenance.manage',
  handler: async ({ auth, sb }) => {
    const [list, edge] = await Promise.all([listVisibility(sb, auth), edgeVisibilityStatus()]);
    return { ...list, edge };
  },
});

export const PUT = defineAdminRoute({
  cap: 'maintenance.manage',
  input: PageVisibilityWriteSchema,
  handler: async ({ auth, sb, input, audit }) => {
    await liveRecheck(auth);
    const { row, fields, target } = await saveVisibility(sb, auth, input);
    const sync = await syncVisibilityToEdge(sb, auth);
    const purgeTags = visibilityPurgeTags(
      target.kind === 'page' ? { kind: 'page', slug: target.slug } : target,
    );
    await purgeAfterSave(auth.tenantId, purgeTags, 'visibility');
    // Audited whether or not the edge took it: a `kvSynced: false` row is how "the change was
    // never live" is found later. Field names only.
    audit({
      action: 'page_visibility.update',
      ...(target.kind === 'page'
        ? { entityType: 'page', entityId: target.id }
        : { entityType: 'page_visibility', entityId: String(row['id']) }),
      detail: {
        mode: input.mode,
        fields,
        ...(target.kind === 'page' ? { page: target.slug } : { template: target.template }),
        kvSynced: sync.kvSynced,
      },
    });
    return {
      setting: settingOfRow(row),
      kvSynced: sync.kvSynced,
      purgeTags,
    };
  },
});
