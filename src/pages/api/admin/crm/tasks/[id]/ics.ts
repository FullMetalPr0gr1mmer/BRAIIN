import { PUBLIC_SITE_URL } from 'astro:env/client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { defineAdminRoute } from '@/lib/admin/route';
import { NotFoundError } from '@/lib/admin/errors';
import { getSiteProfile } from '@/lib/data/siteProfile';
import { buildTaskIcs, icsFilename } from '@/lib/crm/ics';
import { requireTaskId, taskError } from '@/lib/crm/tasks';

// One task as a calendar file (Admin v2 C8, crm.md §9): "Download .ics" in the task drawer.
// `crm.tasks`. Written on the server (src/lib/crm/ics.ts) from the task as the caller reads it
// (RLS and the live check decide: an unseen task is a 404). It carries the title and a link
// back to the admin only: never the contact's name, the lead, the note or the owner (data
// minimisation). The brand in its PRODID is the caller's tenant's own (site_profile), and the
// UID's host is the site's (PUBLIC_SITE_URL): data, never hard-coded.
//
// A download, so: `attachment`, `no-store`, `nosniff`. Audited queued (`crm.task.ics`): the
// task's words leave the admin for a calendar.

export const prerender = false;

const NO_STORE = 'private, no-store, max-age=0, must-revalidate';

/** The site's origin and host, or the request's own when PUBLIC_SITE_URL cannot be read. */
function siteOf(url: URL): { origin: string; host: string } {
  try {
    const site = new URL(PUBLIC_SITE_URL);
    return { origin: site.origin, host: site.host };
  } catch {
    return { origin: url.origin, host: url.host };
  }
}

/** The caller's tenant's brand (English), else the public identity's. */
async function brandOf(sb: SupabaseClient, tenantId: string): Promise<string> {
  const { data } = await sb
    .from('site_profile')
    .select('brand_name')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const name = (data as { brand_name?: { en?: unknown } } | null)?.brand_name?.en;
  if (typeof name === 'string' && name.trim()) return name;
  return (await getSiteProfile()).brandName.en;
}

export const GET = defineAdminRoute({
  cap: 'crm.tasks',
  handler: async ({ auth, sb, params, url, audit }) => {
    const id = requireTaskId(params);
    const { data, error } = await sb
      .from('crm_tasks')
      .select('id,title,due_at')
      .eq('tenant_id', auth.tenantId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw taskError(error, 'the task');
    const task = data as { id?: unknown; title?: unknown; due_at?: unknown } | null;
    if (!task || typeof task.title !== 'string' || typeof task.due_at !== 'string') {
      throw new NotFoundError('task');
    }
    const site = siteOf(url);
    const body = buildTaskIcs(
      { id, title: task.title, dueAt: task.due_at },
      {
        host: site.host,
        brand: await brandOf(sb, auth.tenantId),
        // Everyone's list (C8 review, C8-UX-2): My tasks would not show a task someone else
        // or nobody owns, so the anchor would point at nothing.
        link: `${site.origin}/admin/tasks?view=all#task-${id}`,
        now: new Date(),
      },
    );
    audit({ action: 'crm.task.ics', entityType: 'task', entityId: id });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': `attachment; filename="${icsFilename(task.title)}"`,
        'cache-control': NO_STORE,
        'x-content-type-options': 'nosniff',
      },
    });
  },
});
