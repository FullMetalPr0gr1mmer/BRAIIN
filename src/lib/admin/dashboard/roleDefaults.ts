import type { SupabaseClient } from '@supabase/supabase-js';
import {
  readDashboardLayout,
  readQuickActions,
  type DashboardLayout,
  type QuickLibraryItem,
  type RoleDefaultsPut,
} from '@schemas/dashboard';
import { isRole, ROLES, type AuthContext, type Role } from '@/lib/auth/types';
import { AuthorizationError } from '@/lib/authz/errors';
import { OptimisticLockError, ValidationError } from '../errors';
import { forbiddenActions, forbiddenWidgets, keepReleasePlacement } from './layout';

// The owner's presets (Admin v2 U1, verification.md "Quick actions pre-set per role by the
// owner"; README U1 D1 to D3): admin_role_defaults (0060), one row per tenant and role, a
// layout and library-only quick actions. An Admin writes them (users.manage; the database
// asks the same of the LIVE role); every staff member reads their own role's (the dashboard,
// when they never arranged theirs). Through the caller's RLS-bound client.

const COLUMNS = 'role,dashboard,quick_actions,version,updated_at';
const UNIQUE_VIOLATION = '23505';

export interface RolePreset {
  role: Role;
  /** 0 when the role has no preset (the code's default applies). */
  version: number;
  /** The stored layout, raw (readDashboardLayout reads it). */
  dashboard: unknown;
  quickActions: unknown;
  updatedAt: string | null;
}

interface PresetRow {
  role: string;
  dashboard: unknown;
  quick_actions: unknown;
  version: number;
  updated_at: string | null;
}

const none = (role: Role): RolePreset => ({
  role,
  version: 0,
  dashboard: {},
  quickActions: [],
  updatedAt: null,
});

const toPreset = (row: PresetRow): RolePreset | null =>
  isRole(row.role)
    ? {
        role: row.role,
        version: row.version,
        dashboard: row.dashboard ?? {},
        quickActions: row.quick_actions ?? [],
        updatedAt: row.updated_at,
      }
    : null;

/** The caller's own role's preset (RLS returns no other to a role that is not Admin). */
export async function readMyRolePreset(sb: SupabaseClient, auth: AuthContext): Promise<RolePreset> {
  const { data, error } = await sb
    .from('admin_role_defaults')
    .select(COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('role', auth.role)
    .maybeSingle<PresetRow>();
  if (error) throw new Error(`role preset: ${error.code ?? error.message}`);
  return (data && toPreset(data)) ?? none(auth.role);
}

/** Every role's preset, in ROLES order, a role with none at version 0 (Admin's screen). */
export async function readRolePresets(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<RolePreset[]> {
  const { data, error } = await sb
    .from('admin_role_defaults')
    .select(COLUMNS)
    .eq('tenant_id', auth.tenantId);
  if (error) throw new Error(`role presets: ${error.code ?? error.message}`);
  const byRole = new Map<Role, RolePreset>();
  for (const row of (data ?? []) as PresetRow[]) {
    const preset = toPreset(row);
    if (preset) byRole.set(preset.role, preset);
  }
  return ROLES.map((role) => byRole.get(role) ?? none(role));
}

/**
 * What a preset save stores: the layout (marked `quickSet` when it carries quick actions too,
 * D8), the quick actions. Ids the TARGET role may not use are refused, not dropped: an Admin
 * saving their own layout for Content Creator is told what that role cannot have (the
 * modal sends only what the role may use, so this is a direct call's answer).
 */
export function presetValues(
  role: Role,
  input: Pick<RoleDefaultsPut, 'dashboard' | 'quickActions'>,
  stored: RolePreset,
): { dashboard: DashboardLayout; quick_actions: QuickLibraryItem[] } {
  if (input.dashboard) {
    const bad = forbiddenWidgets(input.dashboard, role);
    if (bad.length > 0) {
      throw new ValidationError(`Not available to this role: ${bad.join(', ')}`, 'dashboard');
    }
  }
  if (input.quickActions) {
    const bad = forbiddenActions(input.quickActions, role);
    if (bad.length > 0) {
      throw new ValidationError(`Not available to this role: ${bad.join(', ')}`, 'quickActions');
    }
  }
  const storedQuick = readQuickActions(stored.quickActions).filter(
    (item): item is QuickLibraryItem => !('href' in item),
  );
  const quick = input.quickActions ?? storedQuick;
  // A release widget the saved board names nowhere keeps the preset's own placement (R14-prep
  // code review 1): the board never shows it while releases are off.
  const base = input.dashboard
    ? keepReleasePlacement(input.dashboard, stored.dashboard, role)
    : readDashboardLayout(stored.dashboard);
  const quickSet =
    input.quickActions !== undefined || readDashboardLayout(stored.dashboard).quickSet === true;
  const dashboard: DashboardLayout = {
    top: [...base.top],
    left: [...base.left],
    right: [...base.right],
    hidden: [...base.hidden],
    ...(quickSet ? { quickSet: true } : {}),
  };
  return { dashboard, quick_actions: quick.map((item) => ({ id: item.id })) };
}

/** Saves a role's preset under the version the Admin read (0: the role has none). */
export async function saveRolePreset(
  sb: SupabaseClient,
  auth: AuthContext,
  role: Role,
  input: RoleDefaultsPut,
): Promise<RolePreset> {
  const stored = await readRolePresetFor(sb, auth, role);
  if (stored.version !== input.version) throw new OptimisticLockError('admin_role_defaults');
  const values = presetValues(role, input, stored);
  if (input.version === 0) {
    const { data, error } = await sb
      .from('admin_role_defaults')
      .insert({ tenant_id: auth.tenantId, role, ...values })
      .select(COLUMNS)
      .maybeSingle<PresetRow>();
    if (error?.code === UNIQUE_VIOLATION) throw new OptimisticLockError('admin_role_defaults');
    if (error) throw writeError(error);
    return (data && toPreset(data)) ?? none(role);
  }
  const { data, error } = await sb
    .from('admin_role_defaults')
    .update(values)
    .eq('tenant_id', auth.tenantId)
    .eq('role', role)
    .eq('version', input.version)
    .select(COLUMNS)
    .maybeSingle<PresetRow>();
  if (error) throw writeError(error);
  if (!data) throw new OptimisticLockError('admin_role_defaults');
  return toPreset(data) ?? none(role);
}

/** Back to the code's default: the role's preset removed. True when there was one. */
export async function resetRolePreset(
  sb: SupabaseClient,
  auth: AuthContext,
  role: Role,
): Promise<boolean> {
  const { data, error } = await sb
    .from('admin_role_defaults')
    .delete()
    .eq('tenant_id', auth.tenantId)
    .eq('role', role)
    .select('role');
  if (error) throw writeError(error);
  return Array.isArray(data) && data.length > 0;
}

async function readRolePresetFor(
  sb: SupabaseClient,
  auth: AuthContext,
  role: Role,
): Promise<RolePreset> {
  const { data, error } = await sb
    .from('admin_role_defaults')
    .select(COLUMNS)
    .eq('tenant_id', auth.tenantId)
    .eq('role', role)
    .maybeSingle<PresetRow>();
  if (error) throw new Error(`role preset: ${error.code ?? error.message}`);
  return (data && toPreset(data)) ?? none(role);
}

/** A refused write: the CHECK (23514) a 422, RLS (42501: the live check) a 403. */
function writeError(error: { code?: string; message: string }): Error {
  if (error.code === '23514') return new ValidationError('That preset cannot be stored.');
  if (error.code === '42501') {
    return new AuthorizationError('users.manage', 'the database refused the write (live check)');
  }
  return new Error(`role preset write: ${error.code ?? error.message}`);
}
