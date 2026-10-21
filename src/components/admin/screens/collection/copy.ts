import { formToPayload, rowToForm } from '@/lib/admin/formPayload';
import type { ResourceUi } from '@/lib/admin/uiSchema';
import { copySlug, type CollectionDef } from './collections';

// Duplicate (Admin v2 U7, D9), pure so it is unit-tested (tests/lib/collectionScreen.spec.ts):
// the create payload a copy is POSTed with, built from the original as the item API reads it.
//
//   - every field the form edits, as the form would send it, then the collection's own
//     changes (a quote's consent cleared, a client hidden until someone clears it);
//   - a draft, never scheduled, where the collection has a status at all;
//   - never a design sample (the 0028 sample lock refuses creating one, and the flag would
//     keep the copy off the live site anyway);
//   - a slug of its own, `<slug>-copy`, then `-copy-2`… (the slug columns are unique per
//     tenant), when the collection has one;
//   - in the original's place: the screen then moves it right after it (reorder.ts).
//
// Null when the collection, or this row, may not be copied (a team member, a design sample).

type Row = Record<string, unknown>;

export function copyPayload(
  def: CollectionDef,
  ui: Pick<ResourceUi, 'fields' | 'hasStatus'>,
  original: Row,
  takenSlugs: ReadonlySet<string>,
): Row | null {
  const overrides = def.copy?.(original);
  if (!overrides) return null;
  const payload: Row = {
    ...formToPayload(rowToForm(original, ui.fields), ui.fields),
    ...overrides,
  };
  delete payload['scheduledFor'];
  if (ui.hasStatus === true) payload['status'] = 'draft';
  else delete payload['status'];
  if ('isPlaceholder' in payload) payload['isPlaceholder'] = false;
  if (typeof payload['slug'] === 'string' && payload['slug'] !== '') {
    payload['slug'] = copySlug(payload['slug'], takenSlugs);
  }
  payload['sortOrder'] = Number(original['sort_order'] ?? 0);
  return payload;
}
