import { IntakeRequestSchema } from '@schemas/release';
import { assertCap } from '@/lib/authz/matrix';
import { defineAdminRoute } from '@/lib/admin/route';
import { OptimisticLockError } from '@/lib/admin/errors';
import { rethrowWriteError } from '@/lib/admin/singleton';
import { siteProfileSingleton } from '@/lib/admin/singletons/siteProfile';

// The job-application intake switch, `site_profile.accepting_applications` (Admin v2 R3b;
// releases.md §1.2 and edge case 20). It is never part of a release: `/api/apply` and
// `/api/apply/status` read it live, so opening or closing applications happens at once, with
// releases on or off (decision D7). The legacy PATCH /api/admin/site-profile still writes it
// while releases are off; with them on, that route refuses a changed switch and points here.
//
// Admin only, in both server layers (Pillar 1): the kernel's `applications.manage` (Admin only
// in ROLE_CAPS) plus `settings.general` (the row's own write capability) and `guardWrite` in
// the Worker; the 0019 guard trigger in the database (42501 → 403). No version: the write names
// one boolean and is idempotent, so a stale form cannot overwrite anything else.

export const prerender = false;

const COLUMNS = 'version,accepting_applications';

export const PATCH = defineAdminRoute({
  cap: 'applications.manage',
  input: IntakeRequestSchema,
  handler: async ({ auth, sb, input, audit }) => {
    assertCap(auth, 'settings.general');
    const next = input.acceptingApplications;

    const { data: existing, error: readError } = await sb
      .from('site_profile')
      .select(COLUMNS)
      .eq('tenant_id', auth.tenantId)
      .maybeSingle<{ version: number; accepting_applications: boolean }>();
    if (readError) throw new Error(`read site_profile: ${readError.message}`);
    const values = { accepting_applications: next };
    siteProfileSingleton.guardWrite?.(auth, existing ?? null, values);

    const before = existing ? existing.accepting_applications === true : false;
    // Nothing to change: no write, no audit row (the switch is already where it was asked).
    if (next === before) {
      return { acceptingApplications: next, version: existing?.version ?? 0 };
    }

    let row: { version: number; accepting_applications: boolean } | null;
    if (!existing) {
      // No identity row yet: create it, as the settings form's first save would, with the
      // switch as asked (the defaults leave it closed).
      const { data, error } = await sb
        .from('site_profile')
        .insert({ ...siteProfileSingleton.defaults, ...values, tenant_id: auth.tenantId })
        .select(COLUMNS)
        .single<{ version: number; accepting_applications: boolean }>();
      if (error) {
        if (error.code === '23505') throw new OptimisticLockError('site_profile');
        rethrowWriteError('site_profile', 'settings.general', 'create', error);
      }
      row = data;
    } else {
      const { data, error } = await sb
        .from('site_profile')
        .update(values)
        .eq('tenant_id', auth.tenantId)
        .select(COLUMNS)
        .maybeSingle<{ version: number; accepting_applications: boolean }>();
      if (error) rethrowWriteError('site_profile', 'settings.general', 'update', error);
      if (!data) throw new OptimisticLockError('site_profile');
      row = data;
    }

    audit({
      action: 'site_profile.intake',
      entityType: 'site_profile',
      entityId: auth.tenantId,
      detail: { open: next },
    });
    return {
      acceptingApplications: row?.accepting_applications === true,
      version: row?.version ?? 0,
    };
  },
});
