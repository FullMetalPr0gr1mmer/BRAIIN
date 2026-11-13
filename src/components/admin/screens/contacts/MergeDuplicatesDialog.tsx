import { useEffect, useId, useRef, useState } from 'react';
import Modal from '@/components/admin/kit/Modal';
import { useClock } from '@/components/admin/kit/clock';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { toast } from '@/lib/admin/toast';
import type { DuplicatePair, DuplicateSide, MergeOutcome } from '@schemas/crmMerge';
import { movesLine, olderFirst, reasonLine } from '@/lib/crm/mergeView';
import { ContactStageBadge } from './shared';

// Merge duplicates (Admin v2 C12, crm.md §11 screen 9): a large modal from the People list,
// loaded with import() on first use. On opening it asks GET /api/admin/crm/duplicates for the
// likely duplicates (the same phone number, or the same name at the same company; at most 50).
// Each pair says why in words and shows both people (name, title, company, stage, when added,
// how many leads, e-mails and phones), never an e-mail, a phone or a note (crm.md §11 PII rules).
//
//   Not a duplicate  POST …/duplicates/dismiss: the pair is not offered again.
//   Merge into older a preview of what moves (the older record kept; Swap keeps the other),
//                    then "Merge now", POST /api/admin/crm/contacts/merge with both versions.
//                    A 409 (someone changed one of them) reads the list again and says so.
//
// A merge cannot be undone, so it always takes the second press. Errors stay inline; a toast
// says only that something worked. A 404 (one of the two was merged or erased elsewhere) takes
// the pair away at once and reads the list again.
//
// Focus (C12 review, C12-COR-2; WCAG 2.4.3): every press here removes or disables the button
// pressed, so focus is placed after each one (mergeFocusTarget): into the confirm group (its
// Cancel, the safe choice, with the group described by its preview) when it opens; back to the
// pair's "Merge into older" on Cancel or a refusal; to the next pair's first action (else the
// one before it, else the empty state) when a pair leaves. Never the page's body.

export interface MergeDuplicatesDialogProps {
  open: boolean;
  onClose: () => void;
  /** After a merge: the People list and its counts read again. */
  onMerged: () => void;
}

/** A pair's key: its two ids. */
export const pairKey = (pair: DuplicatePair): string => `${pair.a.id}:${pair.b.id}`;

/**
 * The pairs left after a merge: none naming the record that went (it is a tombstone now), and
 * none naming the kept one either (its version moved: the next read brings them back current).
 */
export function afterMerge(
  pairs: readonly DuplicatePair[],
  ids: readonly string[],
): DuplicatePair[] {
  return pairs.filter((pair) => !ids.includes(pair.a.id) && !ids.includes(pair.b.id));
}

/** Where focus goes once the dialog is drawn again after a press (C12-COR-2). */
export type MergeFocus =
  | { to: 'confirm'; key: string }
  | { to: 'pair'; key: string; index: number }
  | { to: 'next'; index: number };

/**
 * The element that takes focus for `focus`, as the dialog is now drawn: the confirm group's
 * Cancel; a pair's "Merge into older" (when that pair has gone, as for `next`); for `next`,
 * the first action of the pair now at that place, else of the one before it, else of the
 * first pair, else the empty state, else Done. Never nothing while the dialog is open.
 */
export function mergeFocusTarget(
  root: Pick<ParentNode, 'querySelector'>,
  focus: MergeFocus,
): HTMLElement | null {
  const start = (index: number) =>
    root.querySelector<HTMLElement>(`[data-merge-index="${index}"] [data-merge-start]`);
  if (focus.to === 'confirm') {
    const cancel = root.querySelector<HTMLElement>(
      `[data-merge-pair="${focus.key}"] [data-merge-cancel]`,
    );
    if (cancel) return cancel;
  } else if (focus.to === 'pair') {
    const own = root.querySelector<HTMLElement>(
      `[data-merge-pair="${focus.key}"] [data-merge-start]`,
    );
    if (own) return own;
  }
  const index = focus.to === 'confirm' ? 0 : focus.index;
  return (
    start(index) ??
    (index > 0 ? start(index - 1) : null) ??
    root.querySelector<HTMLElement>('[data-merge-start]') ??
    root.querySelector<HTMLElement>('[data-merge-empty]') ??
    root.querySelector<HTMLElement>('[data-merge-done]')
  );
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function Person({ person, role }: { person: DuplicateSide; role: string | null }) {
  const { formatDate } = useClock();
  return (
    <div className="ct-merge__p">
      {role && <p className="ct-merge__role">{role}</p>}
      <p className="ct-merge__name">
        <a href={`/admin/contacts/${person.id}`} dir="auto">
          {person.display_name}
        </a>
      </p>
      {(person.title || person.company_name) && (
        <p className="lead-sub">
          {person.title && <span dir="auto">{person.title}</span>}
          {person.title && person.company_name && ' at '}
          {person.company_name && <span dir="auto">{person.company_name}</span>}
        </p>
      )}
      <p className="lead-sub">
        <ContactStageBadge stage={person.stage} />{' '}
        {person.created_at && `Added ${formatDate(person.created_at)}. `}
        {n(person.leads, 'lead', 'leads')}, {n(person.emails, 'e-mail', 'e-mails')},{' '}
        {n(person.phones, 'phone', 'phones')}.
      </p>
    </div>
  );
}

export default function MergeDuplicatesDialog({
  open,
  onClose,
  onMerged,
}: MergeDuplicatesDialogProps) {
  const [pairs, setPairs] = useState<DuplicatePair[] | null>(null);
  const [error, setError] = useState('');
  const [reads, setReads] = useState(0);
  // The pair being merged, and which of its two is kept.
  const [confirming, setConfirming] = useState<{ key: string; keepId: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pairError, setPairError] = useState<{ key: string; text: string } | null>(null);
  // Said above the list when a pair left because one of them was gone (a 404).
  const [notice, setNotice] = useState('');
  // Where focus goes once the press's answer is drawn (C12-COR-2): a ref, not state, so
  // setting it draws nothing.
  const focusNext = useRef<MergeFocus | null>(null);
  const previewId = useId();

  // Each opening starts clean: no pairs from the last opening (with their old versions and
  // live buttons) while this one reads (C12-COR-6); each opening (and each re-read after a
  // merge or a conflict) reads the list afresh, keeping a conflict's words until the next
  // press.
  useEffect(() => {
    if (!open) return;
    setPairs(null);
    setError('');
    setNotice('');
    setConfirming(null);
    setPairError(null);
    focusNext.current = null;
  }, [open]);
  // After every draw: a press waiting for its focus gets it once nothing is busy (a busy
  // pair's buttons are disabled).
  useEffect(() => {
    const next = focusNext.current;
    if (!open || !next || busy !== null) return;
    focusNext.current = null;
    mergeFocusTarget(document, next)?.focus();
  });
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    adminFetch<{ pairs: DuplicatePair[] }>('/api/admin/crm/duplicates', {
      signal: controller.signal,
    })
      .then((answer) => {
        setPairs(answer.pairs);
        setError('');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(describeError(err));
      });
    return () => controller.abort();
  }, [open, reads]);

  /** A pair one of whose people is gone (merged or erased elsewhere): it leaves now. */
  function gone(key: string, index: number) {
    setConfirming(null);
    setPairs((list) => (list ?? []).filter((p) => pairKey(p) !== key));
    setNotice('One of them is no longer on file, so that pair is gone. The list is refreshed.');
    focusNext.current = { to: 'next', index };
    setReads((r) => r + 1);
  }

  async function dismiss(pair: DuplicatePair, index: number) {
    const key = pairKey(pair);
    setBusy(key);
    setPairError(null);
    setNotice('');
    try {
      await adminFetch('/api/admin/crm/duplicates/dismiss', {
        method: 'POST',
        body: { a: pair.a.id, b: pair.b.id },
      });
      setPairs((list) => (list ?? []).filter((p) => pairKey(p) !== key));
      focusNext.current = { to: 'next', index };
      toast('Noted. They will not be suggested again.', 'ok');
    } catch (err) {
      if (err instanceof AdminApiError && err.info.status === 404) {
        gone(key, index);
      } else {
        setPairError({ key, text: describeError(err) });
        focusNext.current = { to: 'pair', key, index };
      }
    } finally {
      setBusy(null);
    }
  }

  async function merge(
    pair: DuplicatePair,
    index: number,
    keep: DuplicateSide,
    drop: DuplicateSide,
  ) {
    const key = pairKey(pair);
    setBusy(key);
    setPairError(null);
    setNotice('');
    try {
      await adminFetch<MergeOutcome>('/api/admin/crm/contacts/merge', {
        method: 'POST',
        body: {
          keepId: keep.id,
          keepVersion: keep.version,
          dropId: drop.id,
          dropVersion: drop.version,
        },
      });
      setConfirming(null);
      setPairs((list) => afterMerge(list ?? [], [keep.id, drop.id]));
      focusNext.current = { to: 'next', index };
      toast(`Merged into ${keep.display_name}.`, 'ok');
      onMerged();
      setReads((r) => r + 1);
    } catch (err) {
      if (err instanceof AdminApiError && err.info.status === 409) {
        setConfirming(null);
        setError('');
        setPairError({ key, text: 'Someone else changed one of them. Refreshed.' });
        focusNext.current = { to: 'pair', key, index };
        setReads((r) => r + 1);
      } else if (err instanceof AdminApiError && err.info.status === 404) {
        gone(key, index);
      } else if (err instanceof AdminApiError && err.info.status === 429) {
        setPairError({
          key,
          text: 'You have merged a lot in the last hour. Try again later.',
        });
        focusNext.current = { to: 'confirm', key };
      } else {
        setPairError({ key, text: describeError(err) });
        focusNext.current = { to: 'confirm', key };
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Merge duplicates"
      sub="People who may be on file twice: the same phone number, or the same name at the same company. Check before you merge. A merge cannot be undone."
      footer={
        <button type="button" data-autofocus="" data-merge-done="" onClick={onClose}>
          Done
        </button>
      }
    >
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="msg" role="status">
          {notice}
        </p>
      )}
      {pairs === null ? (
        !error && <p className="f__hint">Looking for likely duplicates…</p>
      ) : pairs.length === 0 ? (
        <div className="ct-merge__empty">
          <p className="ct-merge__name" tabIndex={-1} data-merge-empty="">
            No likely duplicates
          </p>
          <p className="lead-sub">
            When two records share a phone number, or a name and a company, they show up here.
          </p>
        </div>
      ) : (
        <ul className="ct-merge" aria-label="Likely duplicates">
          {pairs.map((pair, index) => {
            const key = pairKey(pair);
            const older = olderFirst(pair);
            const asked = confirming?.key === key ? confirming : null;
            const keep = asked && asked.keepId === older.drop.id ? older.drop : older.keep;
            const drop = keep.id === older.keep.id ? older.drop : older.keep;
            const working = busy === key;
            return (
              <li
                key={key}
                className="ct-merge__pair"
                data-merge-pair={key}
                data-merge-index={index}
              >
                <p className="ct-merge__why">{reasonLine(pair.reasons)}</p>
                <div className="ct-merge__people">
                  <Person person={keep} role={asked ? 'Kept' : null} />
                  <Person person={drop} role={asked ? 'Merged into it' : null} />
                </div>
                {asked ? (
                  <div
                    className="ct-merge__confirm"
                    role="group"
                    aria-label="Confirm the merge"
                    aria-describedby={`${previewId}-${index}`}
                  >
                    <p id={`${previewId}-${index}`} aria-live="polite">
                      <span dir="auto">{drop.display_name}</span> is merged into{' '}
                      <span dir="auto">{keep.display_name}</span>. {movesLine(drop)} Blanks are
                      filled from the other record and the tags are combined. This cannot be undone.
                    </p>
                    <div className="ct-merge__actions">
                      <button
                        type="button"
                        data-variant="danger"
                        disabled={working}
                        onClick={() => void merge(pair, index, keep, drop)}
                      >
                        Merge now
                      </button>
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => setConfirming({ key, keepId: drop.id })}
                      >
                        Swap, keep the other
                      </button>
                      <button
                        type="button"
                        data-merge-cancel=""
                        disabled={working}
                        onClick={() => {
                          focusNext.current = { to: 'pair', key, index };
                          setConfirming(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="ct-merge__actions">
                    <button
                      type="button"
                      data-variant="primary"
                      data-merge-start=""
                      disabled={working}
                      onClick={() => {
                        setPairError(null);
                        focusNext.current = { to: 'confirm', key };
                        setConfirming({ key, keepId: older.keep.id });
                      }}
                    >
                      Merge into older
                    </button>
                    <button
                      type="button"
                      disabled={working}
                      onClick={() => void dismiss(pair, index)}
                    >
                      Not a duplicate
                    </button>
                  </div>
                )}
                {pairError?.key === key && (
                  <p className="msg" data-kind="error" role="alert">
                    {pairError.text}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
