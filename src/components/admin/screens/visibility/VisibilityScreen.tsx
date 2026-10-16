import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '@/components/admin/kit/Modal';
import Note from '@/components/admin/kit/Note';
import Icon from '@/components/admin/kit/Icon';
import { adminFetch, describeError } from '@/lib/admin/client';
import { toast } from '@/lib/admin/toast';
import { relTime } from '@/lib/admin/relTime';
import { EDGE_MISSED, MODE_COPY } from '@/lib/admin/visibilityCopy';
import VisibilityList, { itemTitle } from './VisibilityList';
import VisibilityDrawer, { type RedirectChoice, type VisibilityDraft } from './VisibilityDrawer';
import type { VisibilityItem, VisibilityList as ListAnswer, VisibilitySaveAnswer } from './types';

// /admin/visibility (Admin v2 U14a): who can see each page of the public site. `maintenance.
// manage` (Admin + Developer); the server refuses everyone else (the island shows the API's
// 403). The list, "Who can see <page>?" in a drawer, a confirm before the live site changes,
// and the edge's own status with "Sync to edge" for when a save did not reach it.

const API = '/api/admin/page-visibility';

/** What the line above the list says about the live site's copy. */
function edgeLine(list: ListAnswer): { tone: 'info' | 'warn'; text: string } {
  const edge = list.edge;
  if (edge === null) return { tone: 'warn', text: 'The live site’s copy could not be read.' };
  const restricted = [...list.pages, ...list.templates].filter(
    (item) =>
      (item.setting?.mode ?? 'public') !== 'public' &&
      !(item.kind === 'page' && item.slug === 'home'),
  ).length;
  if (!edge.present) {
    return restricted === 0
      ? { tone: 'info', text: 'Every page is visible, and the live site agrees.' }
      : {
          tone: 'warn',
          text: 'The live site has no copy of these settings yet. Use Sync to edge.',
        };
  }
  if (edge.count !== restricted) {
    return { tone: 'warn', text: 'The live site is behind these settings. Use Sync to edge.' };
  }
  const when = edge.builtAt ? `, as of ${relTime(edge.builtAt)}` : '';
  return { tone: 'info', text: `The live site has these settings${when}.` };
}

function saved(item: VisibilityItem, mode: VisibilityDraft['mode']): string {
  const title = itemTitle(item);
  if (mode === 'public') return `${title} is visible to everyone.`;
  if (mode === 'link') return `${title} is open only to people with the link.`;
  return `${title} is hidden from the site.`;
}

export default function VisibilityScreen() {
  const [list, setList] = useState<ListAnswer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<VisibilityItem | null>(null);
  const [pending, setPending] = useState<VisibilityDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'err' | 'ok'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await adminFetch<ListAnswer>(API));
      setLoadError(null);
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items: VisibilityItem[] = useMemo(
    () => (list ? [...list.pages, ...list.templates] : []),
    [list],
  );
  const choices: RedirectChoice[] = useMemo(
    () => (list?.pages ?? []).map((page) => ({ id: page.id, label: page.title.en })),
    [list],
  );

  async function apply(item: VisibilityItem, draft: VisibilityDraft) {
    setBusy(true);
    setSaveError(null);
    try {
      const hidden = draft.mode === 'hidden';
      const answer = await adminFetch<VisibilitySaveAnswer>(API, {
        method: 'PUT',
        body: {
          target: item.kind === 'page' ? { pageId: item.id } : { template: item.template },
          mode: draft.mode,
          redirectPageId: hidden && draft.redirect ? draft.redirect : null,
          hideFrom: hidden && draft.hideFrom ? draft.hideFrom : null,
          showOn: hidden && draft.showOn ? draft.showOn : null,
          version: item.setting?.version ?? 0,
        },
      });
      setOpen(null);
      setNotice(answer.kvSynced ? null : { tone: 'err', text: EDGE_MISSED });
      toast(saved(item, draft.mode), 'ok');
      await load();
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setPending(null);
      setBusy(false);
    }
  }

  async function sync() {
    setBusy(true);
    try {
      const answer = await adminFetch<{ kvSynced: boolean }>(`${API}/sync`, { method: 'POST' });
      if (answer.kvSynced) {
        setNotice(null);
        toast('The live site has the latest settings.', 'ok');
      } else {
        setNotice({ tone: 'err', text: 'The live site did not take the settings. Try again.' });
      }
      await load();
    } catch (err) {
      setNotice({ tone: 'err', text: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <p className="msg" data-kind="error" role="alert">
        {loadError}
      </p>
    );
  }
  if (!list) return <p className="admin-sub">Loading…</p>;

  const line = edgeLine(list);
  return (
    <div className="vis">
      <div className="vis-bar">
        <Note tone={line.tone} role="status" className="vis-bar__line">
          {line.text}
        </Note>
        <button
          type="button"
          className="btn"
          data-variant="ghost"
          disabled={busy}
          onClick={() => void sync()}
        >
          <Icon name="refresh" size={16} />
          Sync to edge
        </button>
      </div>
      {notice && (
        <Note tone={notice.tone} role="alert">
          {notice.text}
        </Note>
      )}

      <VisibilityList
        items={items}
        onOpen={(item) => {
          setSaveError(null);
          setOpen(item);
        }}
      />

      <VisibilityDrawer
        item={open}
        choices={choices}
        busy={busy}
        error={saveError}
        onClose={() => setOpen(null)}
        onApply={(draft) => setPending(draft)}
      />

      <Modal
        open={pending !== null && open !== null}
        onClose={() => setPending(null)}
        title={pending ? `${MODE_COPY[pending.mode].title}?` : ''}
        sub="This changes the live site within a minute."
        footer={
          <>
            <button
              type="button"
              className="btn"
              data-variant="ghost"
              data-autofocus=""
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              data-variant="primary"
              disabled={busy}
              onClick={() => open && pending && void apply(open, pending)}
            >
              Apply change
            </button>
          </>
        }
      >
        <p>{open ? `${itemTitle(open)}: ${pending ? MODE_COPY[pending.mode].text : ''}` : ''}</p>
      </Modal>
    </div>
  );
}
