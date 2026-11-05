import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from '@/components/admin/kit/Modal';
import Note from '@/components/admin/kit/Note';
import Icon from '@/components/admin/kit/Icon';
import { adminFetch, describeError } from '@/lib/admin/client';
import {
  announcePending,
  readsThroughRelease,
  stagedBody,
  stagedUrl,
} from '@/lib/admin/releaseEvents';
import { toast } from '@/lib/admin/toast';
import { pageTimeZone } from '@/components/admin/kit/clock';
import { clockFor, type Clock } from '@/lib/admin/relTime';
import {
  CONFIRM_SUB,
  EDGE_MISSED,
  MODE_COPY,
  NOTHING_TO_PUBLISH,
  STAGED_CONFIRM_SUB,
  stagedSaved,
} from '@/lib/admin/visibilityCopy';
import { visibilityRevision } from '@/lib/http/visibility';
import VisibilityList, { itemTitle } from './VisibilityList';
import VisibilityDrawer, { type RedirectChoice, type VisibilityDraft } from './VisibilityDrawer';
import type { VisibilityItem, VisibilityList as ListAnswer, VisibilitySaveAnswer } from './types';

// /admin/visibility (Admin v2 U14a): who can see each page of the public site. `maintenance.
// manage` (Admin + Developer); the server refuses everyone else (the island shows the API's
// 403). The list, "Who can see <page>?" in a drawer, a confirm before the live site changes,
// and the edge's own status with "Sync to edge" for when a save did not reach it.
//
// Release mode (Admin v2 R14b): the screen's mode is its own list answer's (`draftsInvalid`,
// readsThroughRelease), never a row's. Each row then shows its setting as publishing would leave
// it, with a pending badge; a save is a pending change, marked as made in release mode
// (`staged`, and the change it names), so once releases are switched off under the screen the
// live route refuses it (409 `releases-off`). The line about the live site still compares the
// LIVE settings with the edge. The password stays immediate: offered only on a page that asks
// for one live with nothing pending (the server checks the same, stagedPageVisibility.ts).

const API = '/api/admin/page-visibility';

/**
 * What the line above the list says about the live site's copy. It compares the rows the
 * snapshot was built from (their ids and versions) with the rows listed here, not only how
 * many are restricted: hidden to link only, a new redirect or new days keep the count and
 * still leave the live site behind.
 */
export function edgeLine(
  list: ListAnswer,
  clock: Clock = clockFor(pageTimeZone()),
): { tone: 'info' | 'warn'; text: string } {
  const { relTime } = clock;
  const edge = list.edge;
  if (edge === null) return { tone: 'warn', text: 'The live site’s copy could not be read.' };
  const restricted = [...list.pages, ...list.templates].filter(
    (item) =>
      (item.setting?.mode ?? 'public') !== 'public' &&
      !(item.kind === 'page' && item.slug === 'home'),
  );
  if (!edge.present) {
    return restricted.length === 0
      ? { tone: 'info', text: 'Every page is visible, and the live site agrees.' }
      : {
          tone: 'warn',
          text: 'The live site has no copy of these settings yet. Use Sync to edge.',
        };
  }
  const rev = visibilityRevision(
    restricted.flatMap((item) =>
      item.setting ? [{ id: item.setting.id, version: item.setting.version }] : [],
    ),
  );
  if (edge.count !== restricted.length || edge.rev !== rev) {
    return { tone: 'warn', text: 'The live site is behind these settings. Use Sync to edge.' };
  }
  const when = edge.builtAt ? `, as of ${relTime(edge.builtAt)}` : '';
  return { tone: 'info', text: `The live site has these settings${when}.` };
}

/**
 * Where a hidden page may send its visitors: the pages that render, in the list's order (the
 * homepage first). A custom page that is not published is left out: its address answers 404
 * (E11 code review, CR1), and the save refuses it too.
 */
export function redirectChoices(pages: ListAnswer['pages']): RedirectChoice[] {
  return pages
    .filter((page) => page.redirectable)
    .map((page) => ({ id: page.id, label: page.title.en }));
}

/** A row's key: its page's id, or its template. */
export function itemKey(item: VisibilityItem): string {
  return item.kind === 'page' ? `page:${item.id}` : `template:${item.template}`;
}

/**
 * The row as the screen shows it: in release mode, the setting its pending change leaves (a
 * change that could not be read shows the live setting). Releases off, the row as answered.
 */
export function shownItem(item: VisibilityItem): VisibilityItem {
  return item.pending?.setting ? { ...item, setting: item.pending.setting } : item;
}

/** Release mode: the password is immediate, so only a page that asks for one live, unpending. */
export function passwordOffered(live: VisibilityItem | null, release: boolean): boolean {
  if (!release) return true;
  return live?.kind === 'page' && live.setting?.mode === 'password' && !live.pending;
}

/**
 * The PUT's body, from the LIVE row: the version the live setting has (0 with none) and, in
 * release mode, the pending change it names. Releases off it is exactly main's body.
 */
export function visibilityPut(live: VisibilityItem, draft: VisibilityDraft, release: boolean) {
  const hidden = draft.mode === 'hidden';
  const pending = release ? (live.pending ?? null) : null;
  return {
    target: live.kind === 'page' ? { pageId: live.id } : { template: live.template },
    mode: draft.mode,
    redirectPageId: hidden && draft.redirect ? draft.redirect : null,
    hideFrom: hidden && draft.hideFrom ? draft.hideFrom : null,
    showOn: hidden && draft.showOn ? draft.showOn : null,
    version: live.setting?.version ?? 0,
    ...(pending ? { draftId: pending.draftId, draftVersion: pending.draftVersion } : {}),
  };
}

export function saved(item: VisibilityItem, mode: VisibilityDraft['mode']): string {
  const title = itemTitle(item);
  if (mode === 'public') return `${title} is visible to everyone.`;
  if (mode === 'link') return `${title} is open only to people with the link.`;
  if (mode === 'password') return `${title} now asks for a password.`;
  return `${title} is hidden from the site.`;
}

/**
 * What the screen says after a save, and whether the savebar should count again. A staged save
 * with a pending change says it waits for publishing; a staged save that left nothing pending
 * (the setting equals live, or "visible to everyone" on a page with no setting) says the live
 * words and that there is nothing to publish (R14b review), and still asks the savebar to count
 * again, because it may have discarded the page's earlier pending change. A live save says the
 * live words.
 */
export function afterSave(
  item: VisibilityItem,
  mode: VisibilityDraft['mode'],
  answer: Pick<VisibilitySaveAnswer, 'staged' | 'pending'>,
): { text: string; recount: boolean } {
  if (!answer.staged) return { text: saved(item, mode), recount: false };
  if (answer.pending) return { text: stagedSaved(itemTitle(item)), recount: true };
  return { text: `${saved(item, mode)} ${NOTHING_TO_PUBLISH}`, recount: true };
}

/** The message above the password box, as the save sends it: absent lines are left out. */
function noteOf(draft: VisibilityDraft): { en?: string; ar?: string } | null {
  const en = draft.noteEn.trim();
  const ar = draft.noteAr.trim();
  if (en.length === 0 && ar.length === 0) return null;
  return { ...(en.length > 0 ? { en } : {}), ...(ar.length > 0 ? { ar } : {}) };
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

  // R14b: the screen's mode is its own list answer's.
  const release = list !== null && readsThroughRelease(list);
  const items: VisibilityItem[] = useMemo(
    () => (list ? [...list.pages, ...list.templates] : []),
    [list],
  );
  const shown: VisibilityItem[] = useMemo(() => items.map(shownItem), [items]);
  const liveOf = (item: VisibilityItem | null) =>
    item ? (items.find((i) => itemKey(i) === itemKey(item)) ?? item) : null;
  const choices: RedirectChoice[] = useMemo(() => redirectChoices(list?.pages ?? []), [list]);

  async function apply(item: VisibilityItem, draft: VisibilityDraft) {
    setBusy(true);
    setSaveError(null);
    try {
      const live = liveOf(item) ?? item;
      const version = live.setting?.version ?? 0;
      // The password has its own door: the list's PUT takes the three modes that need no
      // secret, and this one hands the password straight to the database, which hashes it.
      // Nothing of it is kept here, and the drawer closes with the field empty.
      const answer =
        draft.mode === 'password' && item.kind === 'page'
          ? await adminFetch<VisibilitySaveAnswer>(stagedUrl(`${API}/password`, release), {
              method: 'POST',
              body: {
                pageId: item.id,
                password: draft.password,
                note: noteOf(draft),
                version,
              },
            })
          : await adminFetch<VisibilitySaveAnswer>(API, {
              method: 'PUT',
              body: stagedBody(visibilityPut(live, draft, release), release),
            });
      setOpen(null);
      setNotice(answer.kvSynced ? null : { tone: 'err', text: EDGE_MISSED });
      const said = afterSave(item, draft.mode, answer);
      // R14b: the savebar counts the pending changes again after a staged save.
      if (said.recount) announcePending();
      toast(said.text, 'ok');
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
        items={shown}
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
        release={release}
        passwordOffered={passwordOffered(liveOf(open), release)}
        onClose={() => setOpen(null)}
        onApply={(draft) => setPending(draft)}
      />

      <Modal
        open={pending !== null && open !== null}
        onClose={() => setPending(null)}
        title={pending ? `${MODE_COPY[pending.mode].title}?` : ''}
        sub={release && pending?.mode !== 'password' ? STAGED_CONFIRM_SUB : CONFIRM_SUB}
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
