import Icon from '@/components/admin/kit/Icon';
import PendingBadge, { pendingKindOf } from '@/components/admin/kit/PendingBadge';
import { MoveButtons, SortHandle, SortHint } from '@/components/admin/kit/Sortable';
import { useSortable } from '@/components/admin/kit/useSortable';
import { kindOf, sectionName } from './library';
import type { SectionRow } from './model';

// The page editor's sections column (Admin v2 E1, ui.md "Sections column"; the prototype's
// .secs): "Page details" first, then a row per section in the site's order. Each row: the
// handle (drag it, or Space and the arrows: the kit's Sortable core), the section's name and
// its kind, the eye ("Show <name> on the site", a switch), and Move up / Move down (one click
// each: WCAG 2.5.7). The row the fields column shows is `aria-current`. Add section ends the
// column. Every control is the person's convenience: each route checks the capability again.

export interface SectionsColumnProps {
  rows: readonly SectionRow[];
  selected: string;
  /** A write of the column is on its way: its controls wait. */
  working: boolean;
  error: string;
  onSelect: (id: string) => void;
  onToggle: (row: SectionRow) => void;
  onCommit: (order: readonly string[]) => void;
  onAdd: () => void;
}

export const PAGE_DETAILS = 'page';

export default function SectionsColumn({
  rows,
  selected,
  working,
  error,
  onSelect,
  onToggle,
  onCommit,
  onAdd,
}: SectionsColumnProps) {
  const ids = rows.map((row) => row.id);
  const { ref, lists, hintId } = useSortable<HTMLUListElement>({
    lists: { list: ids },
    onCommit: (next) => onCommit(next['list'] ?? []),
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const shown = lists['list'] ?? ids;
  const sortable = rows.length > 1;

  return (
    <aside className="pe__secs" aria-labelledby="pe-secs-h">
      <div className="pe__secs-h">
        <h2 id="pe-secs-h" className="pe__h">
          Sections
        </h2>
        {sortable && <span className="pe__tiny">Drag to reorder</span>}
      </div>
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      <ul className="list pe__list">
        <li className="li pe__row" aria-current={selected === PAGE_DETAILS ? 'true' : undefined}>
          <span className="li__ico">
            <Icon name="settings" size={16} />
          </span>
          <button type="button" className="pe__pick" onClick={() => onSelect(PAGE_DETAILS)}>
            <span className="pe__name">Page details</span>
            <span className="pe__kind">Title and status</span>
          </button>
        </li>
      </ul>
      <ul
        className="list pe__list"
        ref={ref}
        aria-label="The page’s sections, in order"
        aria-busy={working || undefined}
      >
        {shown.map((id) => {
          const row = byId.get(id);
          if (!row) return null;
          const name = sectionName(row);
          const kind = kindOf(row.type)?.name ?? row.type;
          const pending = pendingKindOf(row as unknown as Record<string, unknown>);
          return (
            <li
              key={id}
              className="li pe__row"
              data-hidden={row.visible ? undefined : ''}
              aria-current={selected === id ? 'true' : undefined}
              data-sortable-id={sortable ? id : undefined}
              data-sortable-label={sortable ? name : undefined}
            >
              {sortable && <SortHandle label={name} describedBy={hintId} />}
              <button type="button" className="pe__pick" onClick={() => onSelect(id)}>
                <span className="pe__name" dir="auto">
                  {name}
                </span>
                <span className="pe__kind">
                  {kind}
                  {row.visible ? '' : ' · Hidden'}
                  {row.placeholder ? ' · Sample' : ''}
                </span>
              </button>
              {pending && <PendingBadge kind={pending} />}
              <span className="pe__ctl">
                <button
                  type="button"
                  className="icon-btn pe__eye"
                  role="switch"
                  aria-checked={row.visible}
                  aria-label={`Show ${name} on the site`}
                  disabled={working}
                  onClick={() => onToggle(row)}
                >
                  <Icon name={row.visible ? 'eye' : 'eyeoff'} size={15} />
                </button>
                {sortable && <MoveButtons label={name} />}
              </span>
            </li>
          );
        })}
      </ul>
      <SortHint id={hintId} />
      <button type="button" className="btn pe__add" onClick={onAdd} disabled={working}>
        <Icon name="plus" size={16} />
        Add section
      </button>
    </aside>
  );
}
