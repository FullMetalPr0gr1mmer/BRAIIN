import type { MouseEvent, RefObject } from 'react';
import Icon from '@/components/admin/kit/Icon';
import ListRow from '@/components/admin/kit/ListRow';
import PendingBadge, { pendingKindOf } from '@/components/admin/kit/PendingBadge';
import { MoveButtons, SortHandle, SortHint } from '@/components/admin/kit/Sortable';
import { Badge } from '@/components/admin/kit/StatusBadge';
import { useSortable } from '@/components/admin/kit/useSortable';
import type { CollectionDef } from './collections';
import type { CollectionPermissions } from './fields';

// A collection's rows (Admin v2 U7): the kit's ListRow in a sortable list. Mounted once the
// first read has rows, so the Sortable core binds to a list that exists (it binds when this
// mounts). Each row: a handle, the icon, the item's words, its badges, Move up / Move down,
// and Duplicate and Edit (shown on hover and whenever focus is in the row). The title is a
// real link to the item; the screen opens it in the drawer. Admin v2 R12: a row with a pending
// change (releases on: the list read adds `draft`) wears its badge after the item's own.

type Row = Record<string, unknown> & { id: string };

export interface CollectionListProps {
  def: CollectionDef;
  rows: readonly Row[];
  permissions: CollectionPermissions;
  /** The rows can be moved (a writer, a resource with an order, two rows or more). */
  sortable: boolean;
  /** The item the drawer is open on. */
  current: string | null;
  working: boolean;
  listRef: RefObject<HTMLUListElement | null>;
  onCommit: (order: readonly string[]) => void;
  onOpen: (id: string) => void;
  onDuplicate: (row: Row) => void;
  onLinkClick: (event: MouseEvent<HTMLUListElement>) => void;
}

export default function CollectionList({
  def,
  rows,
  permissions,
  sortable: canSort,
  current,
  working,
  listRef,
  onCommit,
  onOpen,
  onDuplicate,
  onLinkClick,
}: CollectionListProps) {
  const ids = rows.map((row) => row.id);
  const { ref, lists, hintId } = useSortable<HTMLUListElement>({
    lists: { list: ids },
    onCommit: (next) => onCommit(next['list'] ?? []),
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const shown = lists['list'] ?? ids;
  const setRef = (element: HTMLUListElement | null) => {
    ref.current = element;
    listRef.current = element;
  };

  return (
    <>
      <ul
        className="list coll__list"
        ref={setRef}
        aria-label={def.title}
        aria-busy={working || undefined}
        onClick={onLinkClick}
      >
        {shown.map((id) => {
          const row = byId.get(id);
          if (!row) return null;
          const title = def.rowTitle(row);
          const copyable = permissions.write && def.copy !== undefined && def.copy(row) !== null;
          const pending = pendingKindOf(row);
          return (
            <ListRow
              key={id}
              title={title}
              sub={def.rowSub(row) ?? undefined}
              href={`/admin/${def.slug}/${id}`}
              icon={def.icon}
              current={current === id}
              sortId={canSort ? id : undefined}
              sortLabel={title}
              lead={canSort ? <SortHandle label={title} describedBy={hintId} /> : undefined}
              meta={
                <>
                  {def.badges(row).map((badge, index) => (
                    <Badge key={index} tone={badge.tone} status={badge.status}>
                      {badge.label || undefined}
                    </Badge>
                  ))}
                  {pending && <PendingBadge kind={pending} />}
                  {canSort && <MoveButtons label={title} />}
                </>
              }
              actions={
                <>
                  {copyable && (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Duplicate ${title}`}
                      disabled={working}
                      onClick={() => onDuplicate(row)}
                    >
                      <Icon name="copy" size={15} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`${permissions.write ? 'Edit' : 'Open'} ${title}`}
                    onClick={() => onOpen(id)}
                  >
                    <Icon name="edit" size={15} />
                  </button>
                </>
              }
            />
          );
        })}
      </ul>
      <SortHint id={hintId} />
    </>
  );
}
