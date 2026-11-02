import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import EditorForm from '@/components/admin/fields/EditorForm';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import { Badge } from '@/components/admin/kit/StatusBadge';
import { adminFetch, describeError } from '@/lib/admin/client';
import { singletonHistory } from '@/lib/admin/historyTarget';
import {
  announcePending,
  readsThroughRelease,
  stagedBody,
  stagedUrl,
} from '@/lib/admin/releaseEvents';
import { saveModeFor } from '@/lib/admin/saveMode';
import { toast } from '@/lib/admin/toast';
import { footerUi } from '@/lib/admin/ui/footer';
import { useEntitySave } from '@/lib/admin/useEntitySave';
import { orderChanges } from '../collection/reorder';
import { afterChange, MENU_PAGE, readMenu, rowWrite, type Wrote } from '../header/menu';
import {
  canAddColumn,
  columnMove,
  FOOTER_COLUMNS_MAX,
  footerModel,
  movedIds,
  newColumnBody,
  titleProblem,
  type FooterItem,
  type FooterModel,
} from './columns';
import { footerSketch, sketchFacts, type SketchFacts } from './sketch';

// The Footer screen (/admin/appearance/footer, Admin v2 E6; ui.md "### Footer", the
// prototype's `route('/appearance/footer')`). Three parts, each for its own capability (P-9):
//   - Basics (settings.general: Admin, Developer): the copyright template, the style, the
//     mailbox and the social icons, four columns of the identity row (`site_profile`, U9's
//     0102), saved through its own endpoint (`/api/admin/site-profile`) with useEntitySave and
//     EditorForm, so the explicit Save, the 409, release mode and History work as on General;
//     beside them a sketch of the footer drawn from the form as it is;
//   - Columns (nav.edit: Admin, Content Creator): the footer's columns (navigation heading
//     rows, 0122) with their links, Add a column (four at most), Move up and Move down, the eye
//     and every link's column, each one write of the navigation API (versioned; in release mode
//     it names the row's pending change or carries the marker, R12b); hiding a column hides
//     its links on the site (src/lib/nav/tree.ts footerTree); a link's words and address, a
//     column's title and adding a link are on the Menus screen, where only an Admin removes
//     a row (0009's navigation_delete_admin);
//   - Legal links: shown locked, always (PDPL).

export interface FooterScreenProps {
  /** settings.general: the basics. */
  settings: boolean;
  /** nav.edit: the columns. */
  nav: boolean;
}

const TARGET = { kind: 'singleton', endpoint: footerUi.endpoint } as const;
/** The footer's basics are the identity's columns: its history is the site's own (R14-prep). */
const FOOTER_HISTORY = singletonHistory('site_profile');
const FOOTER_HISTORY_OF = { label: 'Site identity', path: '/' } as const;

const LEGAL = ['Privacy', 'Terms', 'Cookies'] as const;

function Sketch({
  values,
  facts,
  columns,
}: {
  values: Readonly<Record<string, unknown>>;
  facts: SketchFacts;
  columns: readonly string[];
}) {
  const sketch = footerSketch(values, facts, columns);
  return (
    <figure className="ftr-pv">
      <div className="ftr-pv__stage" data-style={sketch.style} aria-hidden="true">
        <p className="ftr-pv__copy">{sketch.copyright}</p>
        {sketch.email ? <p className="ftr-pv__mail">{sketch.email}</p> : null}
        {sketch.columns.length > 0 ? (
          <div className="ftr-pv__cols">
            {sketch.columns.map((title, i) => (
              <span key={`${i}-${title}`} className="ftr-pv__col">
                <b>{title}</b>
                <span />
                <span />
              </span>
            ))}
          </div>
        ) : null}
        <div className="ftr-pv__foot">
          <span>{LEGAL.join(' · ')}</span>
          {sketch.socials > 0 ? (
            <span className="ftr-pv__icons">
              {Array.from({ length: sketch.socials }, (_, i) => (
                <i key={i} />
              ))}
            </span>
          ) : null}
        </div>
      </div>
      <figcaption className="ftr-pv__note">
        A sketch of the footer in English. Open the site to see it for real.
      </figcaption>
    </figure>
  );
}

function Basics({ columns }: { columns: readonly string[] }) {
  const [facts, setFacts] = useState<SketchFacts>(() => sketchFacts(null));
  const save = useEntitySave(TARGET, null, {
    fields: footerUi.fields,
    mode: saveModeFor(TARGET),
    onRow: (row) => setFacts(sketchFacts(row)),
  });
  return (
    <EditorForm
      save={save}
      fields={footerUi.fields}
      groups={footerUi.groups}
      submitLabel="Save the footer"
      noun="footer"
      history={FOOTER_HISTORY}
      historyOf={FOOTER_HISTORY_OF}
      slots={{ preview: <Sketch values={save.values} facts={facts} columns={columns} /> }}
    />
  );
}

/** One page of the navigation's rows (the list, MENU_PAGE at a time; footer only). */
const footerPage = (offset: number) =>
  adminFetch<Record<string, unknown>>(
    `/api/admin/navigation?location=footer&limit=${MENU_PAGE}&offset=${offset}`,
  );

function AddColumn({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (title: { en: string; ar: string }) => Promise<boolean>;
}) {
  const base = useId();
  const [en, setEn] = useState('');
  const [ar, setAr] = useState('');
  const [problem, setProblem] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    const said = titleProblem({ en, ar });
    setProblem(said ?? '');
    if (said) return;
    if (await onAdd({ en, ar })) {
      setEn('');
      setAr('');
    }
  }
  return (
    <form className="ftr-add" onSubmit={(e) => void submit(e)} aria-labelledby={`${base}-t`}>
      <p className="ftr-add__t" id={`${base}-t`}>
        Add a column
      </p>
      <div className="ftr-add__row">
        <label className="field ftr-add__f" htmlFor={`${base}-en`}>
          <span>Title (English)</span>
          <input
            id={`${base}-en`}
            type="text"
            value={en}
            maxLength={200}
            disabled={disabled}
            onChange={(e) => setEn(e.target.value)}
          />
        </label>
        <label className="field ftr-add__f" htmlFor={`${base}-ar`}>
          <span>Title (Arabic)</span>
          <input
            id={`${base}-ar`}
            type="text"
            dir="rtl"
            lang="ar"
            value={ar}
            maxLength={200}
            disabled={disabled}
            onChange={(e) => setAr(e.target.value)}
          />
        </label>
        <button type="submit" className="btn" data-size="sm" disabled={disabled}>
          <Icon name="plus" size={14} />
          Add a column
        </button>
      </div>
      {problem ? (
        <p className="ftr-add__err" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

interface RowActions {
  working: boolean;
  complete: boolean;
  move: (item: FooterItem, group: readonly FooterItem[], step: -1 | 1) => void;
  eye: (item: FooterItem) => void;
}

function RowButtons({
  item,
  group,
  index,
  actions,
  noun,
}: {
  item: FooterItem;
  group: readonly FooterItem[];
  index: number;
  actions: RowActions;
  noun: 'column' | 'link';
}) {
  return (
    <span className="ftr-cols__acts">
      <button
        type="button"
        className="icon-btn"
        aria-label={`Move ${item.label} up`}
        disabled={actions.working || !actions.complete || index === 0}
        onClick={() => actions.move(item, group, -1)}
      >
        <Icon name="chevd" size={15} className="ic--flip" />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Move ${item.label} down`}
        disabled={actions.working || !actions.complete || index === group.length - 1}
        onClick={() => actions.move(item, group, 1)}
      >
        <Icon name="chevd" size={15} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Show the ${noun} ${item.label} in the footer`}
        aria-pressed={item.visible}
        disabled={actions.working}
        onClick={() => actions.eye(item)}
      >
        <Icon name={item.visible ? 'eye' : 'eyeoff'} size={15} />
      </button>
      <a
        className="icon-btn ftr-cols__edit"
        href={`/admin/navigation/${item.id}`}
        aria-label={`Edit ${item.label} on the Menus screen`}
      >
        <Icon name="edit" size={15} />
      </a>
    </span>
  );
}

function LinkRow({
  link,
  group,
  index,
  model,
  actions,
  onColumn,
}: {
  link: FooterItem;
  group: readonly FooterItem[];
  index: number;
  model: FooterModel;
  actions: RowActions;
  onColumn: (link: FooterItem, column: string | null) => void;
}) {
  const id = useId();
  return (
    <li className="li ftr-cols__link" data-hidden={link.visible ? undefined : ''}>
      <span className="li__main">
        <span className="li__t">{link.label}</span>
        <span className="li__s">
          {link.href}
          {link.children > 0
            ? ` · ${link.children} ${link.children === 1 ? 'link' : 'links'} under it`
            : ''}
        </span>
      </span>
      {link.visible ? null : <Badge tone="gray">Hidden</Badge>}
      <label className="ftr-cols__pick" htmlFor={id}>
        <span>Column</span>
        <select
          id={id}
          aria-label={`Column for ${link.label}`}
          value={link.column ?? ''}
          disabled={actions.working}
          onChange={(e) => onColumn(link, e.target.value || null)}
        >
          <option value="">No column</option>
          {model.columns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <RowButtons item={link} group={group} index={index} actions={actions} noun="link" />
    </li>
  );
}

function Columns({ onTitles }: { onTitles: (titles: string[]) => void }) {
  const base = useId();
  const [model, setModel] = useState<FooterModel | null>(null);
  const [staged, setStaged] = useState(false);
  const [complete, setComplete] = useState(true);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    try {
      const menu = await readMenu(footerPage, readsThroughRelease);
      const next = footerModel(menu.rows);
      setModel(next);
      setStaged(menu.staged);
      setComplete(menu.complete);
      setError('');
      onTitles(next.columns.filter((c) => c.visible).map((c) => c.label));
    } catch (err) {
      setError(describeError(err));
      setModel((current) => current ?? { columns: [], loose: [] });
    }
  }, [onTitles]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one change, then reads the footer again; a refusal is said after the read. */
  async function run(change: () => Promise<Wrote>, done: string): Promise<boolean> {
    setWorking(true);
    let failure = '';
    try {
      const said = afterChange(await change(), done);
      if (said.announce) announcePending();
      if (said.toast) toast(said.toast, 'ok');
    } catch (err) {
      failure = `That was not saved. ${describeError(err)}`;
    }
    await load();
    if (failure) setError(failure);
    setWorking(false);
    return !failure;
  }

  const patch = (item: FooterItem, values: Record<string, unknown>) => {
    const write = rowWrite(values, item, staged);
    return adminFetch<Record<string, unknown>>(`/api/admin/navigation/${item.id}`, {
      method: 'PATCH',
      body: stagedBody(write.body, write.mark),
    });
  };

  const actions: RowActions = {
    working,
    complete,
    move: (item, group, step) =>
      void run(async () => {
        // A move renumbers the whole group: never from part of the footer.
        if (!complete) return 'none';
        const changes = orderChanges(
          group.map((r) => ({ id: r.id, sort_order: r.sortOrder })),
          movedIds(
            group.map((r) => r.id),
            item.id,
            step,
          ),
        );
        if (changes.length === 0) return 'none';
        const moved = await adminFetch<Record<string, unknown>>(
          stagedUrl('/api/admin/navigation/reorder', staged),
          { method: 'POST', body: { items: changes } },
        );
        return 'staged' in moved ? 'pending' : 'live';
      }, 'Footer order updated.'),
    eye: (item) =>
      void run(
        async () => ((await patch(item, { visible: !item.visible }))['draft'] ? 'pending' : 'live'),
        item.visible
          ? 'links' in item
            ? `${item.label} is hidden from the footer, with its links.`
            : `${item.label} is hidden from the footer.`
          : `${item.label} shows in the footer.`,
      ),
  };

  const onColumn = (link: FooterItem, column: string | null) => {
    if (!model) return;
    const values = columnMove(model, link, column);
    if (!values) return;
    const name = column ? model.columns.find((c) => c.id === column)?.label : null;
    void run(
      async () => ((await patch(link, values))['draft'] ? 'pending' : 'live'),
      name ? `${link.label} is in the column ${name}.` : `${link.label} is in no column.`,
    );
  };

  const add = (title: { en: string; ar: string }) =>
    run(async () => {
      if (!model) return 'none';
      const made = await adminFetch<Record<string, unknown>>(
        stagedUrl('/api/admin/navigation', staged),
        { method: 'POST', body: newColumnBody(title, model) },
      );
      return 'draft' in made || 'staged' in made ? 'pending' : 'live';
    }, `The column ${title.en.trim()} is added. Choose its links below.`);

  const full = model ? !canAddColumn(model) : true;
  const count = model?.columns.length ?? 0;

  return (
    <section className="card" aria-labelledby={`${base}-cols`}>
      <div className="card__h">
        <div>
          <h2 className="card-title" id={`${base}-cols`}>
            Columns
          </h2>
          <p className="card__sub">
            {model ? `${count} of ${FOOTER_COLUMNS_MAX} columns` : 'Loading'}
          </p>
        </div>
        <a className="btn" data-size="sm" href="/admin/navigation/new">
          <Icon name="plus" size={14} />
          Add a link
        </a>
      </div>
      {error ? (
        <Note tone="err" role="alert">
          {error}
        </Note>
      ) : null}
      {complete ? null : (
        <Note tone="warn">
          The footer has more links than this card reads at once, so moving them is off here. The
          Menus screen orders them all.
        </Note>
      )}
      {model && model.columns.length === 0 && !error ? (
        <p className="ftr-cols__hint">
          No columns yet: the footer shows its links in one row. Add a column to group them under a
          title.
        </p>
      ) : null}
      {model && model.columns.length > 0 ? (
        <ol className="ftr-cols__list">
          {model.columns.map((column, index) => (
            <li
              key={column.id}
              className="ftr-cols__col"
              data-hidden={column.visible ? undefined : ''}
            >
              <div className="li ftr-cols__head">
                <span className="li__main">
                  <span className="li__t">{column.label}</span>
                  <span className="li__s" lang="ar" dir="rtl">
                    {column.title.ar}
                  </span>
                </span>
                {column.visible ? null : <Badge tone="gray">Hidden</Badge>}
                <RowButtons
                  item={column}
                  group={model.columns}
                  index={index}
                  actions={actions}
                  noun="column"
                />
              </div>
              {column.links.length === 0 ? (
                <p className="ftr-cols__hint">
                  No links in this column yet, so the site does not show it. Choose a column for a
                  link below.
                </p>
              ) : (
                <ul className="list ftr-cols__links">
                  {column.links.map((link, i) => (
                    <LinkRow
                      key={link.id}
                      link={link}
                      group={column.links}
                      index={i}
                      model={model}
                      actions={actions}
                      onColumn={onColumn}
                    />
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      {model && model.loose.length > 0 ? (
        <div className="ftr-cols__loose">
          <h3 className="ftr-cols__sub">
            {model.columns.length > 0 ? 'Links in no column' : 'Footer links'}
          </h3>
          <ul className="list ftr-cols__links">
            {model.loose.map((link, i) => (
              <LinkRow
                key={link.id}
                link={link}
                group={model.loose}
                index={i}
                model={model}
                actions={actions}
                onColumn={onColumn}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {model && model.columns.length + model.loose.length === 0 && !error ? (
        <p className="ftr-cols__hint">
          No footer links of your own yet: the site shows its built-in links until you add one.
        </p>
      ) : null}
      <AddColumn disabled={working || full} onAdd={add} />
      {full && model ? (
        <p className="ftr-cols__hint">
          The footer holds {FOOTER_COLUMNS_MAX} columns at most. To add another, an Admin removes
          one on the Menus screen, after you choose No column for its links.
        </p>
      ) : null}
      <p className="ftr-cols__hint">
        A column shows on the site once it has a link. Hiding a column hides its links on the site
        too. A column&apos;s title, a link&apos;s words and address and adding a link are on the
        Menus screen. Only an Admin can remove a link or a column there.
      </p>
      <p className="ftr-cols__hint">
        Removing a column also removes the links in it, so choose No column for them first.
      </p>
    </section>
  );
}

function Legal() {
  const base = useId();
  return (
    <section className="card" aria-labelledby={`${base}-legal`}>
      <div className="card__h">
        <div>
          <h2 className="card-title" id={`${base}-legal`}>
            Legal links
          </h2>
          <p className="card__sub">Always shown: required by the Saudi data law (PDPL)</p>
        </div>
      </div>
      <ul className="list ftr-legal">
        {LEGAL.map((name) => (
          <li key={name} className="li">
            <span className="li__main">
              <span className="li__t">{name}</span>
            </span>
            <Badge tone="gray">
              <Icon name="lock" size={12} />
              Always shown
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

const NO_TITLES: readonly string[] = [];

export default function FooterScreen({ settings, nav }: FooterScreenProps) {
  const [titles, setTitles] = useState<readonly string[]>(NO_TITLES);
  const onTitles = useCallback((next: string[]) => {
    setTitles((current) =>
      current.length === next.length && current.every((t, i) => t === next[i]) ? current : next,
    );
  }, []);
  return (
    <div className="ftr">
      {settings ? <Basics columns={titles} /> : null}
      {nav ? <Columns onTitles={onTitles} /> : null}
      <Legal />
    </div>
  );
}
