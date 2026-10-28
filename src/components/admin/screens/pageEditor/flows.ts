import type { EntitySave } from '@/lib/admin/useEntitySave';

// The page editor's action steps (Admin v2 E1), with what they talk to passed in, so the order
// of each step is unit-tested without a browser (tests/lib/pageEditorModel.spec.ts):
//   mayLeave      whether the open form may be left (a switch, a new section opening);
//   columnWrite   a write from the sections column, its refusal said after the list is read
//                 again, so the reread cannot clear the reason;
//   openAdded     after Add section, the new section opens only once the open form may be
//                 left.

type Row = Record<string, unknown>;

/** The open form, as much as leaving it needs. */
export type OpenForm = Pick<EntitySave, 'mode' | 'dirty' | 'flush'>;

/** The question a live form with unsaved changes asks before it is left. */
export const LEAVE_UNSAVED = {
  message: 'Leave without saving? Your changes here will be lost.',
  confirmLabel: 'Leave without saving',
  cancelLabel: 'Stay',
} as const;

/**
 * Whether the open form may be left. Releases on (draft mode): its change is saved on the way
 * out (`flush`), so yes. Releases off with unsaved changes: the person is asked (each save is
 * explicit, P-5). Otherwise yes. Unsaved words are never dropped without a word.
 */
export async function mayLeave(
  open: OpenForm | null,
  ask: (question: typeof LEAVE_UNSAVED) => Promise<boolean>,
): Promise<boolean> {
  if (!open) return true;
  if (open.mode === 'draft') {
    open.flush?.();
    return true;
  }
  if (!open.dirty) return true;
  return ask(LEAVE_UNSAVED);
}

export interface ColumnIo {
  /** Read the sections again. It clears the column's error when the read succeeds. */
  load: () => Promise<unknown>;
  setError: (words: string) => void;
  describe: (err: unknown) => string;
}

/**
 * A write from the sections column (the eye, a move). `write` is the whole step, the request
 * and what follows its answer. On a refusal: `undo` puts the column back, the list is read
 * again (the server's truth), and only THEN is the refusal said ("<refusal> <why>"), since the
 * reread clears the column's error when it succeeds. `reload: 'always'` reads again after a
 * success too (a move: the numbers the server holds). Resolves whether the write went through.
 */
export async function columnWrite(
  write: () => Promise<void>,
  io: ColumnIo,
  opts: { refusal: string; reload: 'always' | 'on-refusal'; undo?: () => void },
): Promise<boolean> {
  let failure: string | null = null;
  try {
    await write();
  } catch (err) {
    opts.undo?.();
    failure = `${opts.refusal} ${io.describe(err)}`;
  }
  if (failure !== null || opts.reload === 'always') await io.load();
  if (failure !== null) io.setError(failure);
  return failure === null;
}

/**
 * After Add section: open the new section, but only once the open form may be left (`leave`,
 * mayLeave). "Stay" keeps the open section and its unsaved words; the new one stays listed,
 * hidden, at the end. Resolves whether it opened.
 */
export async function openAdded(
  created: Row,
  leave: () => Promise<boolean>,
  open: (id: string) => void,
): Promise<boolean> {
  const id = created['id'];
  if (typeof id !== 'string') return false;
  if (!(await leave())) return false;
  open(id);
  return true;
}
