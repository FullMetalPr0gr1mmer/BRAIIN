// Delete from an editor (Admin v2 U5/U6 review): the service and project editors replaced
// main's ResourceTable lists, whose rows carried "Delete <name>"; the editors carry it now,
// for Admins only (content.archiveDelete decides the button; the DELETE route checks again,
// and the resource's own RLS gate after it). The same confirm as the list's (deleteMessage),
// then back to the list with a confirmation that outlives the navigation (flash.ts). With
// releases on, the kernel stages the removal instead (`pendingRemoval`), so the
// confirmation says "Will be removed" rather than "deleted".

import { adminFetch } from './client';
import { confirmDialog } from './confirm';
import { withFlash, type FlashKey } from './flash';

// First strong isolate and pop directional isolate (U+2068, U+2069).
const FSI = String.fromCodePoint(0x2068);
const PDI = String.fromCodePoint(0x2069);

/**
 * The delete confirmation names the row: in a list its trigger is an icon tied to the row only
 * by hover and its accessible name, so the dialog is where a press on the wrong row is caught.
 * The name is a bidi isolate (FSI…PDI), so an Arabic name cannot reorder the English sentence
 * around it. ResourceTable re-exports it.
 */
export function deleteMessage(singular: string, name: string): string {
  return `Delete the ${singular.toLowerCase()} “${FSI}${name}${PDI}”? This cannot be undone.`;
}

export interface EditorDelete {
  /** The resource's API segment: `/api/admin/<slug>/<id>`. */
  slug: string;
  id: string;
  /** "Service", "Project": the confirm's noun. */
  singular: string;
  /** The row's name as saved, in the confirm. */
  name: string;
  /** The list the editor's Back link leads to. */
  back: string;
  /** The confirmation shown there once it is gone. */
  done: FlashKey;
  /**
   * How to get there: the editor's save.leave, so unsaved edits of a record that no longer
   * exists do not ask "Leave site?". Defaults to a plain navigation.
   */
  go?: ((href: string) => void) | undefined;
}

/** Where to go after the DELETE answered: the list, with what happened. */
export function afterDelete(
  req: Pick<EditorDelete, 'back' | 'done'>,
  result: { pendingRemoval?: unknown },
): string {
  return withFlash(req.back, result.pendingRemoval === true ? 'removal-pending' : req.done);
}

/**
 * Asks, deletes, and leaves for the list. Resolves false when the person cancelled; throws the
 * route's error (the caller shows it inline, never in a toast that fades).
 */
export async function deleteFromEditor(req: EditorDelete): Promise<boolean> {
  const confirmed = await confirmDialog({
    message: deleteMessage(req.singular, req.name),
    confirmLabel: 'Delete',
  });
  if (!confirmed) return false;
  const result = await adminFetch<{ pendingRemoval?: unknown }>(
    `/api/admin/${req.slug}/${encodeURIComponent(req.id)}`,
    { method: 'DELETE' },
  );
  const href = afterDelete(req, result);
  if (req.go) req.go(href);
  else location.assign(href);
  return true;
}
