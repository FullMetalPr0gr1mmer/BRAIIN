import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Role } from '@/lib/auth/types';
import { confirmDialog } from '@/lib/admin/confirm';
import { PENDING_EVENT, PUBLISH_EVENT, type PublishEventDetail } from '@/lib/admin/releaseEvents';
import { toast } from '@/lib/admin/toast';
import { discardChanges, refusalOf, type ReleaseApi } from './api';
import { buildRows, discardMineWords, savebarCounts, type PendingSummary } from './model';
import PublishDialog, { type DialogMode } from './PublishDialog';
import Savebar from './Savebar';

// The release UI's state (Admin v2 R12): the pending summary (GET /api/admin/releases/pending,
// R3b), the savebar over it, and the publish dialog. The summary is read when the island loads
// and again after `admin:pending` (an editor saved, a list staged), when the window gets focus
// and when the tab is shown again, debounced: a person who edits in another tab comes back to
// true counts. `admin:publish` opens the dialog (E1, R13). The kit gallery draws the same
// component over a made-up seam (`api`) and listens to nothing.

export interface ReleaseUiProps {
  api: ReleaseApi;
  role: Role;
  /** The kit's gallery: the bar sits in the page, and no window event is listened to. */
  inline?: boolean | undefined;
}

/** "Discard my changes" throws away at most 200 a request (R3b): a few rounds at most. */
const DISCARD_ROUNDS = 5;

export default function ReleaseUi({ api, role, inline = false }: ReleaseUiProps) {
  const [summary, setSummary] = useState<PendingSummary | null>(null);
  const [dialog, setDialog] = useState<{ mode: DialogMode; focus: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setSummary(await api.pending());
    } catch {
      // The bar keeps what it last knew: it is decoration around the page, never an error
      // screen; the next focus or save reads it again.
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => buildRows(summary?.items ?? []), [summary]);
  const counts = useMemo(() => savebarCounts(rows), [rows]);

  useEffect(() => {
    if (inline) return;
    let timer = 0;
    const soon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 300);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') soon();
    };
    const onPublish = (event: Event) => {
      const detail = (event as CustomEvent<PublishEventDetail | undefined>).detail;
      setDialog({ mode: 'publish', focus: detail?.entityId ?? null });
    };
    window.addEventListener(PENDING_EVENT, soon);
    window.addEventListener('focus', soon);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(PUBLISH_EVENT, onPublish);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(PENDING_EVENT, soon);
      window.removeEventListener('focus', soon);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(PUBLISH_EVENT, onPublish);
    };
  }, [inline, refresh]);

  async function discardMine() {
    const ok = await confirmDialog({
      message: discardMineWords(counts.mine),
      confirmLabel: 'Discard',
    });
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      let total = 0;
      for (let round = 0; round < DISCARD_ROUNDS; round += 1) {
        const result = await discardChanges(api, { scope: 'mine' });
        total += result.discarded;
        if (!result.more) break;
      }
      toast(`${total} unpublished ${total === 1 ? 'change' : 'changes'} thrown away.`, 'ok');
    } catch (err) {
      const refusal = refusalOf(err);
      setError(refusal.detail ?? 'Your changes could not be thrown away. Try again.');
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  // A role with nothing of its own to publish reviews instead (E1's Publish included).
  const mode: DialogMode | null = dialog
    ? dialog.mode === 'publish' && counts.publishable === 0
      ? 'review'
      : dialog.mode
    : null;

  return (
    <>
      <Savebar
        counts={counts}
        busy={busy}
        inline={inline}
        error={error}
        onOpen={(next) => setDialog({ mode: next, focus: null })}
        onDiscardMine={() => void discardMine()}
      />
      <PublishDialog
        open={mode !== null}
        mode={mode ?? 'publish'}
        role={role}
        api={api}
        summary={summary}
        focusEntityId={dialog?.focus ?? null}
        onClose={() => setDialog(null)}
        onChanged={() => void refresh()}
      />
    </>
  );
}
