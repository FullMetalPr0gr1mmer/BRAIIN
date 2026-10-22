import { z } from 'zod';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { saveVisibility, settingOfRow } from '@/lib/admin/pageVisibility';
import { syncVisibilityToEdge, visibilityPurgeTags } from '@/lib/admin/visibilitySync';
import { purgeAfterSave } from '@/lib/http/purge';

// The legacy page visibility toggle, `maintenance.manage` (Admin + Developer), kept as an
// alias over `page_visibility` (Admin v2 U14a): `navVisible: true` is "visible to everyone",
// `false` is "only people with the link" (out of the menus, the sitemap and search engines;
// the link still works). It used to write `pages.nav_visible`, which nothing public read and
// which RLS refused for Developer (`pages_write` needs `app.can_write_content()`), so §5's
// Developer row could not be exercised; page_visibility is Admin + Developer in both layers.
// `nav_visible` stays in `pages` until a contraction drops it.
//
// `version` is the setting's own (0 while the page has none), as on the screen's route: a
// caller that held the page's version gets a 409 and reads the setting again.

export const prerender = false;

const VisibilitySchema = z
  .object({
    navVisible: z.boolean(),
    version: z.number().int().min(0),
  })
  .strict();

export const PATCH = defineAdminRoute({
  cap: 'maintenance.manage',
  input: VisibilitySchema,
  handler: async ({ auth, sb, input, params, audit }) => {
    const id = params['id'];
    if (!id || !z.string().uuid().safeParse(id).success) throw new NotFoundError('page');
    await liveRecheck(auth);
    const mode = input.navVisible ? 'public' : 'link';
    const { row, fields, target } = await saveVisibility(sb, auth, {
      target: { pageId: id },
      mode,
      redirectPageId: null,
      hideFrom: null,
      showOn: null,
      version: input.version,
    });
    const sync = await syncVisibilityToEdge(sb, auth);
    // What a cache in front of the Worker clears (Admin v2 R7; nothing is sent while no cache
    // zone is set up, O-3).
    const purgeTags = target.kind === 'page' ? visibilityPurgeTags(target) : [];
    await purgeAfterSave(auth.tenantId, purgeTags, 'visibility');
    audit({
      action: 'page_visibility.update',
      entityType: 'page',
      entityId: id,
      detail: {
        mode,
        fields,
        ...(target.kind === 'page' ? { page: target.slug } : {}),
        via: 'nav_visible',
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
