import { ROLE_CAPS, type Capability } from '@/lib/authz/matrix';
import { ROLES, type Role } from '@/lib/auth/types';
import {
  RELEASE_AREAS,
  RELEASE_ENTITY_TYPES,
  type DraftOp,
  type ReleaseArea,
  type ReleaseEntityType,
} from '@schemas/release';
import { RELEASE_ENTITY_META } from './areas';

// Who may publish a pending change, derived from ROLE_CAPS (Admin v2 R2; releases.md
// §4.1, program decision P-2). No capability is added: an item is publishable by whoever
// can already make the same change live by saving it today. The derived table is
// architecture.md §3.4 "Release publish matrix", proven by tests/authz/releaseMatrix.spec.ts.
// Pure (client-safe): R12's publish dialog imports it to say who an item is waiting for.

/** One pending change, as far as authorization is concerned. */
export interface ReleaseItemRef {
  entityType: ReleaseEntityType;
  op: DraftOp;
  /** The column patch (snake_case); `status: 'archived'` makes an update an archive. */
  patch?: Readonly<Record<string, unknown>> | null;
}

/** The capability the publish routes are declared with (the kernel's label, R6). */
export const PUBLISH_CAP_LABEL: Capability = 'content.publish';

/**
 * The publish routes admit a caller holding any one of these (the kernel's `anyCap`);
 * each item is then checked on its own with `canPublish`.
 */
export const RELEASE_ANY_CAP: readonly Capability[] = [
  'content.publish',
  'theme.edit',
  'settings.general',
  'seo.entityMeta',
  'seo.globalDefaults',
  'redirects.manage',
  'maintenance.manage',
];

/** Whether this change removes the row from the site: a delete, or an archive. */
export function isRemoval(item: ReleaseItemRef): boolean {
  if (item.op === 'delete') return true;
  const meta = RELEASE_ENTITY_META[item.entityType];
  return meta.hasStatus && item.patch?.['status'] === 'archived';
}

/**
 * Every capability needed to publish this change: the area's (a content type's write
 * capability plus `content.publish`), plus the remove capability for a delete or an
 * archive. A `visible` flip needs nothing more: `content.publish` is already there.
 * `null` when no role may publish it at all: a removal of a type a release never removes
 * (the singletons, entity SEO), which the drafts policies refuse to stage anyway.
 */
export function requiredCaps(item: ReleaseItemRef): readonly Capability[] | null {
  const meta = RELEASE_ENTITY_META[item.entityType];
  if (!isRemoval(item)) return meta.authorCaps;
  if (meta.removeCap === null) return null;
  return [...new Set([...meta.authorCaps, meta.removeCap])];
}

/** Whether a role holds every capability the change needs, in full. */
export function canPublish(role: Role, item: ReleaseItemRef): boolean {
  const caps = requiredCaps(item);
  return caps !== null && caps.every((cap) => ROLE_CAPS[role][cap] === 'full');
}

/** The roles that could publish this change ("waiting for an Admin"). */
export function waitingFor(item: ReleaseItemRef): Role[] {
  return ROLES.filter((role) => canPublish(role, item));
}

/**
 * Per area: whether the role may publish a create or an edit of at least one of its
 * types (removals aside), so a savebar can say which areas it will publish.
 */
export function publishableByArea(role: Role): Record<ReleaseArea, boolean> {
  const out = Object.fromEntries(RELEASE_AREAS.map((area) => [area, false])) as Record<
    ReleaseArea,
    boolean
  >;
  for (const entityType of RELEASE_ENTITY_TYPES) {
    if (canPublish(role, { entityType, op: 'update' })) {
      out[RELEASE_ENTITY_META[entityType].area] = true;
    }
  }
  return out;
}

/** The areas `publishableByArea` marks, in RELEASE_AREAS order. */
export function publishableAreas(role: Role): ReleaseArea[] {
  const by = publishableByArea(role);
  return RELEASE_AREAS.filter((area) => by[area]);
}
