import { useEffect, useState } from 'react';
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
// says only that something worked.

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

  // Each opening starts clean; each opening (and each re-read after a merge or a conflict)
  // reads the list afresh, keeping a conflict's words until the next press.
  useEffect(() => {
    if (!open) return;
    setConfirming(null);
    setPairError(null);
  }, [open]);
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

  async function dismiss(pair: DuplicatePair) {
    const key = pairKey(pair);
    setBusy(key);
    setPairError(null);
    try {
      await adminFetch('/api/admin/crm/duplicates/dismiss', {
        method: 'POST',
        body: { a: pair.a.id, b: pair.b.id },
      });
      setPairs((list) => (list ?? []).filter((p) => pairKey(p) !== key));
      toast('Noted. They will not be suggested again.', 'ok');
    } catch (err) {
      setPairError({ key, text: describeError(err) });
    } finally {
      setBusy(null);
    }
  }

  async function merge(pair: DuplicatePair, keep: DuplicateSide, drop: DuplicateSide) {
    const key = pairKey(pair);
    setBusy(key);
    setPairError(null);
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
      toast(`Merged into ${keep.display_name}.`, 'ok');
      onMerged();
      setReads((r) => r + 1);
    } catch (err) {
      if (err instanceof AdminApiError && err.info.status === 409) {
        setConfirming(null);
        setError('');
        setPairError({ key, text: 'Someone else changed one of them. Refreshed.' });
        setReads((r) => r + 1);
      } else if (err instanceof AdminApiError && err.info.status === 429) {
        setPairError({
          key,
          text: 'You have merged a lot in the last hour. Try again later.',
        });
      } else {
        setPairError({ key, text: describeError(err) });
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
        <button type="button" data-autofocus="" onClick={onClose}>
          Done
        </button>
      }
    >
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {pairs === null ? (
        !error && <p className="f__hint">Looking for likely duplicates…</p>
      ) : pairs.length === 0 ? (
        <div className="ct-merge__empty">
          <p className="ct-merge__name">No likely duplicates</p>
          <p className="lead-sub">
            When two records share a phone number, or a name and a company, they show up here.
          </p>
        </div>
      ) : (
        <ul className="ct-merge" aria-label="Likely duplicates">
          {pairs.map((pair) => {
            const key = pairKey(pair);
            const older = olderFirst(pair);
            const asked = confirming?.key === key ? confirming : null;
            const keep = asked && asked.keepId === older.drop.id ? older.drop : older.keep;
            const drop = keep.id === older.keep.id ? older.drop : older.keep;
            const working = busy === key;
            return (
              <li key={key} className="ct-merge__pair">
                <p className="ct-merge__why">{reasonLine(pair.reasons)}</p>
                <div className="ct-merge__people">
                  <Person person={keep} role={asked ? 'Kept' : null} />
                  <Person person={drop} role={asked ? 'Merged into it' : null} />
                </div>
                {asked ? (
                  <div className="ct-merge__confirm" role="group" aria-label="Confirm the merge">
                    <p>
                      <span dir="auto">{drop.display_name}</span> is merged into{' '}
                      <span dir="auto">{keep.display_name}</span>. {movesLine(drop)} Blanks are
                      filled from the other record and the tags are combined. This cannot be undone.
                    </p>
                    <div className="ct-merge__actions">
                      <button
                        type="button"
                        data-variant="danger"
                        disabled={working}
                        onClick={() => void merge(pair, keep, drop)}
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
                      <button type="button" disabled={working} onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="ct-merge__actions">
                    <button
                      type="button"
                      data-variant="primary"
                      disabled={working}
                      onClick={() => {
                        setPairError(null);
                        setConfirming({ key, keepId: older.keep.id });
                      }}
                    >
                      Merge into older
                    </button>
                    <button type="button" disabled={working} onClick={() => void dismiss(pair)}>
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
