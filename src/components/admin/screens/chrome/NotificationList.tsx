import type { NotificationItem } from '@/lib/admin/notifications/types';
import { agoLabel } from '@/lib/admin/notifications/ago';
import Icon from '@/components/admin/kit/Icon';

// The bell's list (Admin v2 F8, the prototype's notifications drawer): one row per item,
// a link where the item leads somewhere, "New" on what arrived since the person last
// marked the bell read. Rendered by the drawer (in the browser) and by /admin/notifications
// (on the server, no JS), so both read the same.

export interface NotificationListProps {
  items: readonly NotificationItem[];
  /** "Now", for the relative times: the server's on the page, the browser's in the drawer. */
  now: number;
  /** Rows the person clicked in this drawer: marked read here, the others untouched. */
  readHere?: ReadonlySet<string>;
  onPick?: (id: string) => void;
}

export default function NotificationList({ items, now, readHere, onPick }: NotificationListProps) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <div className="empty__ico" aria-hidden="true">
          <Icon name="bell" />
        </div>
        <b>No notifications</b>
        <p>When something needs you, it shows up here.</p>
      </div>
    );
  }

  return (
    <ul className="list ntf">
      {items.map((item) => {
        const unread = item.unread && !readHere?.has(item.id);
        const when = agoLabel(item.at, now);
        const body = (
          <>
            <span className="li__ico" aria-hidden="true">
              <Icon name={item.icon} />
            </span>
            <span className="li__main">
              <span className="li__t">{item.text}</span>
              <span className="li__s">{[item.detail, when].filter(Boolean).join(' · ')}</span>
            </span>
            {unread && (
              <span className="badge" data-tone="klein" data-plain="">
                New
              </span>
            )}
          </>
        );
        return (
          <li key={item.id}>
            {item.href ? (
              <a
                className="li"
                href={item.href}
                data-unread={unread ? 'true' : undefined}
                onClick={() => onPick?.(item.id)}
              >
                {body}
              </a>
            ) : (
              <div className="li" data-unread={unread ? 'true' : undefined}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
