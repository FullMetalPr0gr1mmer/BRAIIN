import Icon from '@/components/admin/kit/Icon';
import { Badge } from '@/components/admin/kit/StatusBadge';
import { formatDate } from '@/lib/admin/relTime';
import { MODE_COPY } from '@/lib/admin/visibilityCopy';
import type { IconName } from '@/lib/admin/icons';
import type { BadgeTone } from '@/lib/admin/tones';
import type { VisibilityItem, VisibilityMode } from './types';

// The list of /admin/visibility (Admin v2 U14a): every CMS page, then the two templates, each
// a row with its state in words (Visible, Hidden, Link only, and the window's day), and one
// button that opens "Who can see <page>?". The row is a list item, not a link: the button is
// the one thing to press, named for its page.

const TONE: Record<VisibilityMode, BadgeTone> = {
  public: 'ok',
  hidden: 'gray',
  link: 'sky',
  password: 'klein',
};

const ICON: Record<VisibilityMode, IconName> = {
  public: 'globe',
  hidden: 'eyeoff',
  link: 'link',
  password: 'lock',
};

/** "until 8 Nov", "from 1 Nov", "1 Nov to 8 Nov": the window as the admin reads it. */
export function windowText(hideFrom: string | null, showOn: string | null): string | null {
  // A Riyadh day at noon in Riyadh, so every reader's clock prints the same day.
  const day = (d: string) => formatDate(`${d}T12:00:00+03:00`);
  if (hideFrom && showOn) return `${day(hideFrom)} to ${day(showOn)}`;
  if (showOn) return `until ${day(showOn)}`;
  if (hideFrom) return `from ${day(hideFrom)}`;
  return null;
}

export function itemTitle(item: VisibilityItem): string {
  return item.kind === 'page' ? item.title.en : item.title;
}

function subline(item: VisibilityItem): string {
  if (item.kind === 'page') return item.path;
  if (item.count === null) return `${item.path} · Template`;
  const noun = item.template === 'service' ? 'service' : 'project';
  return `${item.path} · Template for ${item.count} ${noun}${item.count === 1 ? '' : 's'}`;
}

export default function VisibilityList({
  items,
  onOpen,
}: {
  items: readonly VisibilityItem[];
  onOpen: (item: VisibilityItem) => void;
}) {
  return (
    <ul className="list vis-list">
      {items.map((item) => {
        const mode = item.setting?.mode ?? 'public';
        const range =
          mode === 'hidden'
            ? windowText(item.setting?.hideFrom ?? null, item.setting?.showOn ?? null)
            : null;
        const title = itemTitle(item);
        const key = item.kind === 'page' ? item.id : item.template;
        const isHome = item.kind === 'page' && item.slug === 'home';
        return (
          <li key={key} className="li vis-row" data-mode={mode}>
            <div className="li__ico">
              <Icon name={item.kind === 'template' ? 'copy' : ICON[mode]} />
            </div>
            <div className="li__main">
              <div className="li__t">{title}</div>
              <div className="li__s" dir="ltr">
                {subline(item)}
              </div>
            </div>
            <div className="vis-row__state">
              <Badge tone={TONE[mode]}>{MODE_COPY[mode].badge}</Badge>
              {range && <span className="vis-row__window">{range}</span>}
              {isHome && <span className="vis-row__window">Always visible</span>}
            </div>
            <button
              type="button"
              className="btn"
              data-variant="ghost"
              onClick={() => onOpen(item)}
              aria-label={`Change who can see ${title}`}
            >
              <Icon name="edit" size={16} />
              Change
            </button>
          </li>
        );
      })}
    </ul>
  );
}
