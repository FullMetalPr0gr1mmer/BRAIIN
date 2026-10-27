import { useEffect, useMemo, type MutableRefObject } from 'react';
import EditorForm from '@/components/admin/fields/EditorForm';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import { sectionFields } from '@/lib/admin/sectionUi';
import { useEntitySave, type EntitySave } from '@/lib/admin/useEntitySave';
import { alwaysShown, anchorOf, kindOf, linkRows, routeNote, sectionName } from './library';
import { builtInFor, sectionFormFields, variantOf, type SectionRow } from './model';
import type { BuiltInLooks } from './types';

// The fields column for one section (Admin v2 E1, ui.md "Fields column"): its name, kind and
// anchor; Rename, and Delete for an Admin or "hide it instead" for anyone else; what the route
// decides around it (honest notes), the screens that hold what it shows, then its words: the
// typed fields of its kind (SECTION_UI) in EditorForm, each prefilled with the words the page
// shows now (the built-in copy for its look, F6, through F5b's `builtIn`), storing only what
// differs. Saved through the resource kernel (PATCH /api/admin/sections/<id>): live with
// version and 409 while releases are off, a pending change with an 800 ms idle autosave once
// they are on (P-5, R12).

const SECTION_TARGET = { kind: 'resource', slug: 'sections' } as const;

export interface SectionPanelProps {
  section: SectionRow;
  /** The page's slug (its built-in looks, its route's rules). */
  page: string;
  firstOfType: boolean;
  builtIns: BuiltInLooks;
  /** `content.archiveDelete`: Delete, and "Advanced (JSON)" (F5b D5). */
  remove: boolean;
  /** The link rows' screens this role opens (PageEditorAccess.opens). */
  opens: readonly string[];
  working: boolean;
  /** The open form, for the editor (a switch asks first; the column's writes follow it). */
  formRef: MutableRefObject<EntitySave | null>;
  onRow: (row: Record<string, unknown>) => void;
  onRename: () => void;
  onDelete: () => void;
}

export default function SectionPanel({
  section,
  page,
  firstOfType,
  builtIns,
  remove,
  opens,
  working,
  formRef,
  onRow,
  onRename,
  onDelete,
}: SectionPanelProps) {
  const fields = useMemo(() => sectionFormFields(section.placeholder), [section.placeholder]);
  const typed = sectionFields(section.type) !== null;
  const save = useEntitySave(SECTION_TARGET, section.id, {
    fields,
    autosave: { idleMs: 800 },
    onRow,
  });
  useEffect(() => {
    formRef.current = save;
  });
  useEffect(
    () => () => {
      formRef.current = null;
    },
    [formRef],
  );

  const name = sectionName(section);
  const kind = kindOf(section.type);
  const content = save.values['content'];
  const anchor = anchorOf(section.type, page, variantOf(content));
  const note = routeNote(section.type, page, firstOfType);
  const links = linkRows(section.type, opens);
  const builtIn = builtInFor(builtIns, { type: section.type, page, firstOfType, content });

  return (
    <section className="pe__panel" aria-labelledby="pe-panel-h">
      <div className="pe__panel-h">
        <div className="pe__panel-t">
          <h2 id="pe-panel-h" className="pe__h" dir="auto">
            {name}
          </h2>
          <p className="pe__tiny">
            {kind ? `Section type: ${kind.name}` : `Section type: ${section.type}`}
            {anchor ? ` · anchor #${anchor}` : ''}
          </p>
        </div>
        <div className="pe__panel-acts">
          <button
            type="button"
            className="btn"
            data-size="sm"
            onClick={onRename}
            disabled={working}
          >
            <Icon name="edit" size={15} />
            Rename
          </button>
          {remove && (
            <button
              type="button"
              className="btn"
              data-size="sm"
              data-variant="danger"
              onClick={onDelete}
              disabled={working}
            >
              <Icon name="trash" size={15} />
              Delete
            </button>
          )}
        </div>
      </div>
      {!remove && (
        <p className="pe__tiny">
          Only an Admin can delete a section. Hide it instead: its eye in the sections column.
        </p>
      )}
      {section.placeholder && (
        <Note tone="warn">
          This section holds design sample words, which cannot go live on the real site. Replace
          them with real ones, then untick Placeholder (design sample) below.
        </Note>
      )}
      {note && <Note tone="info">{note}</Note>}
      {alwaysShown(section.type, page) === null && !section.visible && (
        <Note tone="info">Hidden on the site. Its words stay saved for when you show it.</Note>
      )}
      {links.length > 0 && (
        <ul className="list pe__links" aria-label="Where its content is managed">
          {links.map((link) => (
            <li key={link.href} className="li">
              <span className="li__ico">
                <Icon name="layers" size={16} />
              </span>
              <span className="li__main">
                {link.open ? (
                  <a className="li__t" href={link.href}>
                    Managed in {link.title}
                  </a>
                ) : (
                  <span className="li__t">Managed in {link.title}</span>
                )}
                <span className="li__s">
                  {link.open ? link.sub : `${link.sub} Your role does not open this screen.`}
                </span>
              </span>
              {link.open && <Icon name="chevron" size={16} />}
            </li>
          ))}
        </ul>
      )}
      {typed ? (
        <EditorForm
          save={save}
          fields={fields}
          hidden={['type']}
          builtIn={builtIn ? { content: builtIn } : undefined}
          languageBar="page"
          submitLabel="Save changes"
          canAdvanced={remove}
          noun="section"
        />
      ) : (
        <Note tone="info">
          {`This section has no words of its own to write here${
            links.length > 0 ? ': everything it shows comes from the screen above.' : '.'
          }`}
        </Note>
      )}
    </section>
  );
}
