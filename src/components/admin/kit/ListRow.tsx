import type { ReactNode } from 'react';
import Icon from './Icon';
import type { IconName } from '@/lib/admin/icons';

// A list row inside islands (Admin v2 F4b): the markup of ui/ListRow.astro, one <li> for a
// `<ul className="list">`. The title is a real link stretched over the row when the row
// goes somewhere; a hidden item is dimmed AND labelled "Hidden". In a sortable list
// (useSortable) pass `sortId` and `sortLabel`, a SortHandle as `lead` and MoveButtons in
// `meta`, so the row can be moved by pointer, keyboard or button (WCAG 2.5.7).

export interface ListRowProps {
  title: string;
  sub?: string | undefined;
  href?: string | undefined;
  icon?: IconName | undefined;
  hidden?: boolean;
  current?: boolean;
  lead?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  sortId?: string | undefined;
  /** The name the reorder announcements use; the title by default. */
  sortLabel?: string | undefined;
}

export default function ListRow({
  title,
  sub,
  href,
  icon,
  hidden = false,
  current = false,
  lead,
  meta,
  actions,
  sortId,
  sortLabel,
}: ListRowProps) {
  return (
    <li
      className="li"
      data-hidden={hidden ? '' : undefined}
      aria-current={current ? 'true' : undefined}
      data-sortable-id={sortId}
      data-sortable-label={sortId === undefined ? undefined : (sortLabel ?? title)}
    >
      {lead}
      {icon && (
        <span className="li__ico">
          <Icon name={icon} size={17} />
        </span>
      )}
      <div className="li__main">
        {href ? (
          <a className="li__t" href={href} dir="auto">
            {title}
          </a>
        ) : (
          <p className="li__t" dir="auto">
            {title}
          </p>
        )}
        {sub && (
          <p className="li__s" dir="auto">
            {sub}
          </p>
        )}
      </div>
      {hidden && (
        <span className="badge" data-tone="gray">
          Hidden
        </span>
      )}
      {meta}
      {actions && <div className="li__acts">{actions}</div>}
    </li>
  );
}
