import Icon from '@/components/admin/kit/Icon';
import type { TemplatePart } from '@/lib/templates/parts';
import type { TemplatePanel } from './model';

// The template editor's parts column (Admin v2 E3, ui.md "The sections list holds the fixed
// template parts in read-only order"): first the two things this screen edits ("This service"
// or "This project", and "Shared text"), then the template's parts in the page's order. A part
// cannot be moved, hidden or removed (every page of the template has them all); picking one
// moves the preview to it, when the part is one block of the page. The row the preview shows is
// `aria-current`.

export interface PartsColumnProps {
  noun: string;
  parts: readonly TemplatePart[];
  panel: TemplatePanel;
  /** The part the preview shows, by its marker id, or ''. */
  part: string;
  /** What the role may edit: the panels it is offered. */
  panels: readonly TemplatePanel[];
  onPanel: (panel: TemplatePanel) => void;
  onPart: (id: string) => void;
}

export default function PartsColumn({
  noun,
  parts,
  panel,
  part,
  panels,
  onPanel,
  onPart,
}: PartsColumnProps) {
  return (
    <aside className="pe__secs" aria-labelledby="tpl-parts-h">
      <div className="pe__secs-h">
        <h2 id="tpl-parts-h" className="pe__h">
          Edit
        </h2>
      </div>
      <ul className="list pe__list">
        {panels.includes('item') && (
          <li className="li pe__row" aria-current={panel === 'item' ? 'true' : undefined}>
            <span className="li__ico">
              <Icon name="edit" size={16} />
            </span>
            <button type="button" className="pe__pick" onClick={() => onPanel('item')}>
              <span className="pe__name">This {noun}</span>
              <span className="visually-hidden">, </span>
              <span className="pe__kind">Its own words</span>
            </button>
          </li>
        )}
        {panels.includes('shared') && (
          <li className="li pe__row" aria-current={panel === 'shared' ? 'true' : undefined}>
            <span className="li__ico">
              <Icon name="type" size={16} />
            </span>
            <button type="button" className="pe__pick" onClick={() => onPanel('shared')}>
              <span className="pe__name">Shared text</span>
              <span className="visually-hidden">, </span>
              <span className="pe__kind">Every {noun} page</span>
            </button>
          </li>
        )}
      </ul>
      <div className="pe__secs-h">
        <h2 id="tpl-fixed-h" className="pe__h">
          Template parts
        </h2>
        <span className="pe__tiny">Fixed</span>
      </div>
      <ul className="list pe__list" aria-labelledby="tpl-fixed-h">
        {parts.map((p) => (
          <li
            key={p.key}
            className="li pe__row"
            aria-current={p.id !== null && p.id === part ? 'true' : undefined}
          >
            {p.id !== null ? (
              <button type="button" className="pe__pick" onClick={() => onPart(p.id ?? '')}>
                <span className="pe__name">{p.name}</span>
                <span className="visually-hidden">, </span>
                <span className="tpl__own">{p.own}</span>
              </button>
            ) : (
              <span className="pe__pick tpl__fixed">
                <span className="pe__name">{p.name}</span>
                <span className="visually-hidden">, </span>
                <span className="tpl__own">{p.own}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
