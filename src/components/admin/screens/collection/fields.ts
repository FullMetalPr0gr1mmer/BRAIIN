import type { FieldDef } from '@/lib/admin/uiSchema';

// Which of a collection's form fields the drawer draws (Admin v2 U7), pure so it is
// unit-tested (tests/lib/collectionScreen.spec.ts). The save always loads and sends every
// field (CollectionDrawer); this decides only what the form shows:
//   - no "Sort order": the list's order is the drag's and Move up / Move down's;
//   - "Archived" in the status menu only for the roles that may archive (Admin:
//     content.archiveDelete, RESTRICTIVE in RLS), unless the item already is archived, so a
//     menu never shows a status the item does not have;
//   - testimonials: the placeholder box is replaced by the sample flow, and a sample's
//     words and attribution are not drawn while it stays a sample (the 0028 sample lock).

/** What the role may do on the screen, decided on the server (the buttons only). */
export interface CollectionPermissions {
  /** The resource's write capability in full: add, edit, reorder, duplicate. */
  write: boolean;
  /** Its delete capability in full (content.archiveDelete): delete and archive. */
  remove: boolean;
}

/** A design sample quote's words and attribution: what the 0028 sample lock holds. */
export const SAMPLE_LOCKED = [
  'quote',
  'authorName',
  'authorRole',
  'avatarMediaId',
  'clientId',
  'portfolioId',
] as const;

/**
 * Where the item stands with the sample flow: `none` (a collection without one), `real` (a
 * testimonial that is no sample), `locked` (a sample, words read-only) or `unlocking` (a
 * sample being made real in this save).
 */
export type SampleState = 'none' | 'real' | 'locked' | 'unlocking';

export interface DrawerFieldsOptions {
  isNew: boolean;
  permissions: CollectionPermissions;
  /** The item's stored status, when it has one. */
  status: string | null;
  sample: SampleState;
}

export function drawerFields(
  fields: readonly FieldDef[],
  { permissions, status, sample }: DrawerFieldsOptions,
): FieldDef[] {
  const locked: readonly string[] = sample === 'locked' ? SAMPLE_LOCKED : [];
  return fields
    .filter((field) => field.name !== 'sortOrder')
    .filter((field) => !(sample !== 'none' && field.name === 'isPlaceholder'))
    .filter((field) => !locked.includes(field.name))
    .map((field) =>
      field.name === 'status' && !permissions.remove && status !== 'archived' && field.options
        ? { ...field, options: field.options.filter((o) => o.value !== 'archived') }
        : field,
    );
}
