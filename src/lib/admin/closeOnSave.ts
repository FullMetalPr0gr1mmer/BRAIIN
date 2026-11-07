// When a drawer that closes once an edit lands should close (Admin v2 R14d). The collection,
// discipline, sector and redirect drawers close on a landed save (the prototype's "Saved", back
// to the list). In release mode an editor also saves by itself when focus leaves a field it
// changed (P-5), and those drawers closed on that first automatic save, mid-edit: the person
// typed a question, moved to its answer, and the drawer was gone. They close now only on a save
// the person asked for (Save, Add, ⌘S; useEntitySave's `savedByPerson`). Releases off nothing
// saves by itself, so every landed save is the person's and nothing changes there.

/** True when a save landed since `first` (the drawer's opening value) and it was the person's. */
export function editLanded(
  savedAt: string | null,
  first: string | null,
  savedByPerson: boolean | undefined,
): boolean {
  return savedAt !== null && savedAt !== first && savedByPerson !== false;
}
