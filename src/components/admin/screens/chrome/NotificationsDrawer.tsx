import { useCallback, useRef, useState } from 'react';
import { adminFetch } from '@/lib/admin/client';
import type { NotificationItem } from '@/lib/admin/notifications/types';
import ChromeDrawer, { useOpenOn } from './ChromeDrawer';
import NotificationList from './NotificationList';

// The bell's drawer (Admin v2 F8, docs/admin-v2/ui.md §2.8). Opened from the topbar's bell,
// which is a link to /admin/notifications without JS. The list is asked for when the
// drawer opens, never on a timer: the unread count arrives with every page the server
// renders, which is fresh enough for a bell, and the Workers Free plan counts requests.
//
// Clicking a row marks only that row read here (a mockup bug made it clear the dot for
// every row); "Mark all as read" moves the person's watermark on the server to the moment
// this list was read (`asOf`), so whatever arrived while the drawer was open stays new, and
// clears the dot. The bell in the topbar is updated through its attributes: text and
// `hidden`, never a style.

interface Feed {
  items: NotificationItem[];
  unread: number;
  failed: string[];
  /** When the server read this list: what "Mark all as read" marks up to. */
  asOf: string;
}

/** Brings the topbar bell's label and dot in line with an unread count. */
function syncBell(unread: number): void {
  for (const bell of document.querySelectorAll<HTMLElement>('[data-open="notifications"]')) {
    bell.setAttribute(
      'aria-label',
      unread > 0 ? `Notifications, ${unread} unread` : 'Notifications',
    );
    bell.querySelector<HTMLElement>('.dot')?.toggleAttribute('hidden', unread === 0);
  }
}

export default function NotificationsDrawer() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [readHere, setReadHere] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setStatus('Loading…');
    try {
      const data = await adminFetch<Feed>('/api/admin/notifications');
      setFeed(data);
      setNow(Date.now());
      setReadHere(new Set());
      syncBell(data.unread);
      setStatus(data.failed.length > 0 ? 'Some notifications could not be loaded just now.' : '');
    } catch {
      setStatus('Your notifications could not be loaded just now.');
    }
  }, []);

  const open = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    void load();
  }, [load]);
  const openerRef = useOpenOn('notifications', open);

  async function markAllRead() {
    if (!feed) return;
    setBusy(true);
    try {
      await adminFetch('/api/admin/notifications/seen', {
        method: 'POST',
        body: { asOf: feed.asOf },
      });
      setFeed((current) =>
        current
          ? {
              ...current,
              unread: 0,
              items: current.items.map((item) => ({ ...item, unread: false })),
            }
          : current,
      );
      syncBell(0);
      setStatus('All caught up.');
    } catch {
      setStatus('That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const unread = feed
    ? feed.items.filter((item) => item.unread && !readHere.has(item.id)).length
    : 0;

  return (
    <ChromeDrawer
      dialogRef={dialogRef}
      openerRef={openerRef}
      titleId="ntf-title"
      title="Notifications"
      footer={
        <button
          type="button"
          data-variant="ghost"
          onClick={() => void markAllRead()}
          disabled={busy || unread === 0}
        >
          Mark all as read
        </button>
      }
    >
      <p className="drw__status" role="status">
        {status}
      </p>
      {feed && (
        <NotificationList
          items={feed.items}
          now={now}
          readHere={readHere}
          onPick={(id) => setReadHere((current) => new Set(current).add(id))}
        />
      )}
    </ChromeDrawer>
  );
}
