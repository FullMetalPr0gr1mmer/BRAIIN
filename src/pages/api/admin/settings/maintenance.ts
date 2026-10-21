import { env } from 'cloudflare:workers';
import { MaintenanceInputSchema, maintenanceInForce } from '@schemas/maintenance';
import { defineAdminRoute } from '@/lib/admin/route';
import { OptimisticLockError } from '@/lib/admin/errors';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { formOf, planMaintenanceSave } from '@/lib/admin/maintenance';
import { clientIp, putMaintenanceState, readMaintenanceSnapshot } from '@/lib/http/maintenance';
import { readContact } from '@/lib/maintenance/contact';

// Maintenance mode v2 (`maintenance.manage`: Admin + Developer; Admin v2 U9b).
//
// Two writes, in this order, and the order is the whole design:
//   1. `site_settings.maintenance`: durable, audited, RLS-gated (and, since 0099, behind the
//      RESTRICTIVE live check) source of truth;
//   2. the KV snapshot the middleware's pre-cache check actually reads.
//
// If KV fails we report `kvSynced: false` rather than pretending success, because the
// operator's next action depends on it: the row says "maintenance on", the edge says
// "off", and the site is still serving. Silently returning 200 there is how a
// maintenance window turns into a deploy over live traffic.
//
// The value v2 carries the copy, the background, the contact buttons (a snapshot of
// site_profile, read here), "Back on" (its instant: 00:00 that day in the studio's zone,
// site_settings.timezone) and the staff bypass. The flat form shape goes both ways, so the
// panel is a `useEntitySave` singleton target; GET adds what is in force now (`effective`) and
// whether the edge agrees (`edgeActive`).

export const prerender = false;

const DEFAULT_VALUE = { active: false, allowlist: [] };

/** The audit action of a save: a flip as visitors see it, or a change of the settings. */
const AUDIT_ACTIONS = {
  on: { action: 'maintenance.enable' },
  off: { action: 'maintenance.disable' },
  update: { action: 'maintenance.update' },
} as const;

export const GET = defineAdminRoute({
  cap: 'maintenance.manage',
  handler: async ({ auth, sb }) => {
    const { data, error } = await sb
      .from('site_settings')
      .select('maintenance,version')
      .eq('tenant_id', auth.tenantId)
      .maybeSingle<{ maintenance: unknown; version: number }>();
    if (error) throw new Error(`read maintenance: ${error.message}`);
    const now = Date.now();
    const edge = await readMaintenanceSnapshot(env);
    return {
      ...formOf(data?.maintenance ?? DEFAULT_VALUE, now),
      version: data?.version ?? 0,
      // Whether the edge has maintenance in force now (null: its value cannot be read).
      edgeActive: edge === null ? null : maintenanceInForce(edge, now),
    };
  },
});

export const PATCH = defineAdminRoute({
  cap: 'maintenance.manage',
  input: MaintenanceInputSchema,
  handler: async ({ auth, sb, input, audit, request, studioTimeZone }) => {
    // Switching the public site off is a privileged act: the profile is re-read now, so a
    // demoted or switched-off person cannot, whatever their token says (CLAUDE.md §7).
    await liveRecheck(auth);

    const { data: existing, error: readError } = await sb
      .from('site_settings')
      .select('version,maintenance')
      .eq('tenant_id', auth.tenantId)
      .maybeSingle<{ version: number; maintenance: unknown }>();
    if (readError) throw new Error(`read settings: ${readError.message}`);
    if (!existing && input.version !== 0 && input.version !== 1) {
      throw new OptimisticLockError('site_settings');
    }
    if (existing && existing.version !== input.version) {
      throw new OptimisticLockError('site_settings');
    }

    const now = Date.now();
    const [tz, contact] = await Promise.all([studioTimeZone(), readContact(sb, auth.tenantId)]);
    const plan = planMaintenanceSave(existing?.maintenance ?? DEFAULT_VALUE, input, {
      now,
      tz,
      contact,
    });

    let version: number;
    if (!existing) {
      const { data, error } = await sb
        .from('site_settings')
        .insert({ tenant_id: auth.tenantId, maintenance: plan.next })
        .select('version')
        .single<{ version: number }>();
      if (error) {
        // 23505: someone created the row between our read and our write.
        if (error.code === '23505') throw new OptimisticLockError('site_settings');
        throw new Error(`create settings: ${error.message}`);
      }
      version = data.version;
    } else {
      const { data, error } = await sb
        .from('site_settings')
        .update({ maintenance: plan.next })
        .eq('tenant_id', auth.tenantId)
        .eq('version', input.version)
        .select('version')
        .maybeSingle<{ version: number }>();
      if (error) throw new Error(`update settings: ${error.message}`);
      // No row: a newer version, or the live check (0099) filtered it: either way not saved.
      if (!data) throw new OptimisticLockError('site_settings');
      version = data.version;
    }

    const kvSynced = await putMaintenanceState(env, plan.next);

    // Turning maintenance ON or OFF is a sitewide availability change; the operator's own IP
    // is recorded so "who took the site down at 03:00" has an answer. Field NAMES only.
    const form = formOf(plan.next, now);
    const kind = !plan.flipped ? 'update' : form.effective.active ? 'on' : 'off';
    audit({
      ...AUDIT_ACTIONS[kind],
      entityType: 'site_settings',
      entityId: auth.tenantId,
      detail: {
        fields: plan.fields,
        allowlistSize: plan.next.allowlist.length,
        staffBypass: plan.next.staffBypass,
        until: plan.next.until,
        kvSynced,
        ip: clientIp(request) ?? null,
      },
    });

    return { ...form, version, kvSynced, edgeActive: kvSynced ? form.effective.active : null };
  },
});
