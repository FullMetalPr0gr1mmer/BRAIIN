import type { WidgetId } from '@schemas/dashboard';
import Drawer from '@/components/admin/kit/Drawer';
import EmptyState from '@/components/admin/kit/EmptyState';
import Icon from '@/components/admin/kit/Icon';
import type { WidgetEntry } from './types';

// "Add widget" (Admin v2 U1; the prototype's drawer): the widgets the role may have that are
// off the board, each with Left and Right. Adding saves the layout, then the page reloads to
// read the widget (the island never fetches widget data). Each button's name is an aria-label
// that starts with its visible word: a visually hidden span after the word is absolutely
// positioned, so it is block-level and the computed name gains a space ("Left : add").

export interface AddWidgetDrawerProps {
  open: boolean;
  onClose: () => void;
  widgets: readonly WidgetEntry[];
  onAdd: (id: WidgetId, column: 'left' | 'right') => void;
}

export default function AddWidgetDrawer({ open, onClose, widgets, onAdd }: AddWidgetDrawerProps) {
  return (
    <Drawer open={open} onClose={onClose} title="Add a widget">
      <p className="admin-sub">Pick a column. You can move it anywhere after.</p>
      {widgets.length === 0 ? (
        <EmptyState icon="grid" title="Every widget is already on your dashboard." />
      ) : (
        <ul className="list">
          {widgets.map((widget) => (
            <li key={widget.id} className="li">
              <span className="li__ico">
                <Icon name="grid" size={17} />
              </span>
              <div className="li__main">
                <span className="li__t">{widget.label}</span>
                <span className="li__s">{widget.description}</span>
              </div>
              <span className="dash__add">
                <button
                  type="button"
                  data-size="sm"
                  aria-label={`Left: add ${widget.label} to the left column`}
                  onClick={() => onAdd(widget.id, 'left')}
                >
                  Left
                </button>
                <button
                  type="button"
                  data-size="sm"
                  aria-label={`Right: add ${widget.label} to the right column`}
                  onClick={() => onAdd(widget.id, 'right')}
                >
                  Right
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
