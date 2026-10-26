import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { DraftOpSchema, ReleaseEntityTypeSchema, type RescheduleRequest } from '@schemas/release';
import type { AuthContext } from '@/lib/auth/types';
import { ROLES } from '@/lib/auth/types';
import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import { json, type AdminRouteContext } from '@/lib/admin/route';
import { liveRecheck } from '@/lib/admin/liveRecheck';
import { serviceClient } from '@/lib/supabase/server';
import { RELEASE_ENTITY_META } from './areas';
import { canPublish, requiredCaps, type ReleaseItemRef } from './caps';
import { RELEASES_OFF_DETAIL, scheduleTimeRefusal } from './endpoints';
import { liveDb } from './overlayDb';
import { registryEntry, type RegistryEntry } from './registry';
import { ReleaseRefusal } from './validate';

// Moving and cancelling a scheduled release (Admin v2 R11; docs/admin-v2/releases.md §4.7,
// "Reschedule / unschedule"). SERVER ONLY. The routes are `PATCH` and `DELETE`
// `/api/admin/releases/[id]` (src/pages/api/admin/releases/[id].ts); R13's versions page calls
// them ("Change time", "Unschedule"), and R12's dialog's "Publish now" on a scheduled release is a
// cancel then a publish with a fresh check.
//
// In order, both: releases on (else 409 `releases-off`, and nothing more is read); the release,
// read under the person's RLS (content_releases is CMS staff's, 0038), and the changes it holds
// (its claimed drafts, by stored metadata only); scheduled (else 409 `not-scheduled`) and at the
// version the person saw (else 409 `conflict` with the current one); every change is the
// person's to publish (`requiredCaps` from ROLE_CAPS, P-2: an Admin always may; else 403 naming
// who could publish all of it), judged as a publish judges it: an edit that sets no status of
// its own is read against the live row's status (`liveStatuses`), because one that keeps an
// archived row archived is an Admin's (hotfix H12); a move's time at least two minutes ahead
// (422); the person
// re-read live (`liveRecheck`). Then `public.reschedule_release` / `public.unschedule_release`
// (0112, the service role) check the person and their role again in the database, under the
// tenant's release lock, and write the audit row in the same transaction. A moved release goes
// live as the person who moved it; a cancelled one releases its drafts (pending changes again).

type Row = Record<string, unknown>;

const Uuid = z.string().uuid();
const VersionQuery = z.coerce.number().int().min(1).max(999_999_999);

/** The SQLSTATEs that mean "try again", as the apply's (src/lib/release/apply.ts). */
const BUSY = new Set(['55P03', '40P01', '40001', '57014']);

const ClaimedDraftSchema = z.object({
  id: Uuid,
  entity_type: ReleaseEntityTypeSchema,
  entity_id: Uuid,
  op: DraftOpSchema,
  status: z.string().nullable().optional(),
});
type ClaimedDraft = z.infer<typeof ClaimedDraftSchema>;

interface Scheduled {
  id: string;
  version: number;
  refs: ReleaseItemRef[];
  draftIds: string[];
}

export const MOVE_COPY = {
  notScheduled: 'This release is no longer scheduled. It went live, failed or was cancelled.',
  conflict: 'This release changed since you opened it. Look again, then try once more.',
  busy: 'The site is busy publishing. Try again in a moment.',
} as const;

/**
 * The live status of each row a held change edits without setting a status of its own, keyed
 * `<entity type>:<id>`: the only changes whose capabilities live decides (`keepsArchived`,
 * hotfix H12: one that leaves an archived row archived is an Admin's, as a publish judges it
 * from `readLive`). Read as a publish reads live, under the person's RLS and in their tenant,
 * every table in one request (public.release_read_rows), the key and the status only; nothing
 * is read when no change needs it.
 */
async function liveStatuses(
  sb: SupabaseClient,
  auth: AuthContext,
  held: readonly ClaimedDraft[],
): Promise<Map<string, string>> {
  const byTable = new Map<string, { entry: RegistryEntry; ids: Set<string> }>();
  for (const draft of held) {
    if (draft.op !== 'update' || typeof draft.status === 'string') continue;
    if (!RELEASE_ENTITY_META[draft.entity_type].hasStatus) continue;
    const entry = registryEntry(draft.entity_type);
    const group = byTable.get(entry.table) ?? { entry, ids: new Set<string>() };
    group.ids.add(draft.entity_id);
    byTable.set(entry.table, group);
  }
  const groups = [...byTable.values()];
  const out = new Map<string, string>();
  if (groups.length === 0) return out;
  const answers = await liveDb(sb, auth).listMany(
    groups.map(({ entry, ids }) => ({
      table: entry.table,
      query: { columns: `${entry.key},status`, in: { [entry.key]: [...ids] } },
    })),
  );
  groups.forEach(({ entry }, index) => {
    for (const row of answers[index] ?? []) {
      const status = row['status'];
      if (typeof status === 'string')
        out.set(`${entry.entityType}:${String(row[entry.key])}`, status);
    }
  });
  return out;
}

/** The scheduled release named by the path, read as the person, with what it holds. */
async function readScheduled(
  sb: SupabaseClient,
  auth: AuthContext,
  rawId: string | undefined,
): Promise<Scheduled> {
  const id = Uuid.safeParse(rawId);
  if (!id.success) {
    throw new ReleaseRefusal(404, { ok: false, error: 'not-found', entity: 'release' });
  }
  const [release, drafts] = await Promise.all([
    sb
      .from('content_releases')
      .select('id,status,version')
      .eq('tenant_id', auth.tenantId)
      .eq('id', id.data)
      .maybeSingle(),
    sb
      .from('content_drafts')
      .select('id,entity_type,entity_id,op,status:payload->>status')
      .eq('tenant_id', auth.tenantId)
      .eq('release_id', id.data)
      .limit(61),
  ]);
  if (release.error) throw new Error(`read release: ${release.error.message}`);
  if (drafts.error) throw new Error(`read its changes: ${drafts.error.message}`);
  const row = release.data as Row | null;
  if (!row) throw new ReleaseRefusal(404, { ok: false, error: 'not-found', entity: 'release' });
  if (row['status'] !== 'scheduled') {
    throw new ReleaseRefusal(409, {
      ok: false,
      error: 'not-scheduled',
      status: String(row['status']),
      detail: MOVE_COPY.notScheduled,
    });
  }
  const held = z.array(ClaimedDraftSchema).parse(drafts.data ?? []);
  const live = await liveStatuses(sb, auth, held);
  return {
    id: id.data,
    version: Number(row['version']),
    refs: held.map((d) => ({
      entityType: d.entity_type,
      op: d.op,
      patch: typeof d.status === 'string' ? { status: d.status } : null,
      liveStatus: live.get(`${d.entity_type}:${d.entity_id}`) ?? null,
    })),
    draftIds: held.map((d) => d.id),
  };
}

/**
 * Every change of the release is the person's to publish (the Worker's layer of the two); a 403
 * names the first capability missing and the roles that could publish all of it.
 */
function assertMayMove(auth: AuthContext, release: Scheduled): void {
  let missing: Capability | null = null;
  for (const ref of release.refs) {
    const caps = requiredCaps(ref);
    const lacking =
      caps === null
        ? 'content.archiveDelete'
        : caps.find((cap) => ROLE_CAPS[auth.role][cap] !== 'full');
    if (lacking) {
      missing ??= lacking;
    }
  }
  if (missing) {
    throw new ReleaseRefusal(403, {
      ok: false,
      error: 'forbidden',
      capability: missing,
      waitingFor: ROLES.filter((role) => release.refs.every((ref) => canPublish(role, ref))),
    });
  }
}

function assertVersion(release: Scheduled, version: number): void {
  if (release.version !== version) {
    throw new ReleaseRefusal(409, {
      ok: false,
      error: 'conflict',
      entity: 'release',
      version: release.version,
      detail: MOVE_COPY.conflict,
    });
  }
}

interface RpcError {
  code?: string;
  message?: string;
  details?: string | null;
}

function detailCode(error: RpcError): string | null {
  try {
    const parsed = JSON.parse(String(error.details ?? '')) as Row;
    return typeof parsed['code'] === 'string' ? parsed['code'] : null;
  } catch {
    return null;
  }
}

/** The database's refusals, in the same words as the Worker's own. */
function refusalOf(error: RpcError, release: Scheduled): ReleaseRefusal {
  const code = error.code ?? '';
  if (BUSY.has(code)) {
    return new ReleaseRefusal(503, { ok: false, error: 'busy', detail: MOVE_COPY.busy });
  }
  if (code === '55000') {
    return new ReleaseRefusal(409, {
      ok: false,
      error: 'releases-off',
      detail: RELEASES_OFF_DETAIL,
    });
  }
  if (code === 'P0002') {
    return new ReleaseRefusal(404, { ok: false, error: 'not-found', entity: 'release' });
  }
  if (code === 'BR403') {
    return new ReleaseRefusal(403, {
      ok: false,
      error: 'forbidden',
      capability: detailCode(error) === 'actor' ? 'live-recheck' : 'content.publish',
    });
  }
  if (code === 'BR409') {
    return detailCode(error) === 'not-scheduled'
      ? new ReleaseRefusal(409, {
          ok: false,
          error: 'not-scheduled',
          detail: MOVE_COPY.notScheduled,
        })
      : new ReleaseRefusal(409, {
          ok: false,
          error: 'conflict',
          entity: 'release',
          detail: MOVE_COPY.conflict,
        });
  }
  // 22023 (a time the Worker let through but the database refuses) and anything else: a bug.
  throw new Error(`release ${release.id}: ${code} ${error.message ?? ''}`.trim());
}

function answer(refusal: ReleaseRefusal): Response {
  const response = json(refusal.body, refusal.status);
  if (refusal.status === 503) response.headers.set('retry-after', '5');
  return response;
}

/** `PATCH /api/admin/releases/[id]`: `{version, scheduleAt}`. */
export async function rescheduleRelease(
  ctx: AdminRouteContext<RescheduleRequest>,
): Promise<unknown> {
  const { auth, sb, input } = ctx;
  try {
    if (!(await ctx.releasesEnabled())) {
      return json({ ok: false, error: 'releases-off', detail: RELEASES_OFF_DETAIL }, 409);
    }
    const release = await readScheduled(sb, auth, ctx.params['id']);
    assertVersion(release, input.version);
    assertMayMove(auth, release);
    const late = scheduleTimeRefusal(input.scheduleAt, Date.now());
    if (late) throw late;
    await liveRecheck(auth);
    const { data, error } = await serviceClient().rpc('reschedule_release', {
      p_actor: auth.userId,
      p_role: auth.role,
      p_release: release.id,
      p_version: input.version,
      p_scheduled_for: input.scheduleAt,
    });
    if (error) throw refusalOf(error as RpcError, release);
    const out = z
      .object({ release_id: Uuid, scheduled_for: z.string(), version: z.number().int() })
      .safeParse(data);
    if (!out.success) throw new Error('reschedule_release answered in the wrong shape');
    return {
      release: {
        id: out.data.release_id,
        scheduledFor: out.data.scheduled_for,
        version: out.data.version,
      },
    };
  } catch (err) {
    if (err instanceof ReleaseRefusal) return answer(err);
    throw err;
  }
}

/** `DELETE /api/admin/releases/[id]?version=n`. */
export async function unscheduleRelease(ctx: AdminRouteContext<undefined>): Promise<unknown> {
  const { auth, sb } = ctx;
  try {
    if (!(await ctx.releasesEnabled())) {
      return json({ ok: false, error: 'releases-off', detail: RELEASES_OFF_DETAIL }, 409);
    }
    const version = VersionQuery.safeParse(ctx.url.searchParams.get('version'));
    if (!version.success) {
      throw new ReleaseRefusal(422, {
        ok: false,
        error: 'validation',
        field: 'version',
        detail: 'Name the version of the release you saw.',
      });
    }
    const release = await readScheduled(sb, auth, ctx.params['id']);
    assertVersion(release, version.data);
    assertMayMove(auth, release);
    await liveRecheck(auth);
    const { data, error } = await serviceClient().rpc('unschedule_release', {
      p_actor: auth.userId,
      p_role: auth.role,
      p_release: release.id,
      p_version: version.data,
    });
    if (error) throw refusalOf(error as RpcError, release);
    const out = z
      .object({ release_id: Uuid, status: z.literal('cancelled'), released: z.number().int() })
      .safeParse(data);
    if (!out.success) throw new Error('unschedule_release answered in the wrong shape');
    return {
      release: { id: out.data.release_id, status: 'cancelled' },
      released: out.data.released,
      draftIds: release.draftIds,
    };
  } catch (err) {
    if (err instanceof ReleaseRefusal) return answer(err);
    throw err;
  }
}
