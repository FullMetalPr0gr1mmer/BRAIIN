import { useCallback, useEffect, useId, useState } from 'react';
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
import { singletonFor } from '@/lib/admin/uiSchema';
import { useEntitySave } from '@/lib/admin/useEntitySave';
import { orderChanges } from '../collection/reorder';
import { keyChanges, menuRows, movedOrder, type MenuRow } from './menu';
import { afterLine, barSketch, type BarSketch } from './sketch';

// The Header screen (/admin/appearance/header, Admin v2 E5; ui.md "### Header", the
// prototype's `route('/appearance/header')`). Two parts, each for its own capability (P-9):
//   - the header's options (theme.edit: Admin, Developer): the Layout, Behaviour and Button
//     cards over `site_appearance`, saved through the singleton kernel
//     (`/api/admin/site-appearance`) with useEntitySave and EditorForm, so the explicit Save, the
//     409, release mode, the savebar and History work as in every staged editor; beside them two
//     small sketches of the bar (over the hero, after scrolling) drawn from the form as it is,
//     and what is always true;
//   - the Menu items card (nav.edit: Admin, Content Creator): the header menu's top-level links
//     in order, with Move up and Move down, the key star and the eye, each one write of the
//     navigation API (versioned; in release mode marked, R12b), and Edit and Add on the Menus
//     screen, which keeps the full form (labels, links, sub-links, removal for an Admin).

export interface HeaderScreenProps {
  /** theme.edit: the options. */
  theme: boolean;
  /** nav.edit: the menu card. */
  nav: boolean;
}

const UI = singletonFor('appearance');
const TARGET = { kind: 'singleton', endpoint: UI.endpoint } as const;
/** The header's history: the site's own (no id), as the identity's (R14-prep). */
const HEADER_HISTORY = singletonHistory('site_appearance');

/** One sketch of the bar: closed values on data-* attributes (CSP: no style). */
function Sketch({ sketch, title, line }: { sketch: BarSketch; title: string; line: string }) {
  return (
    <figure className="hdr-pv">
      <figcaption className="hdr-pv__cap">
        <span className="hdr-pv__t">{title}</span>
        <span className="hdr-pv__s">{line}</span>
      </figcaption>
      <div className="hdr-pv__stage" data-stage={sketch.ground}>
        {sketch.shown ? (
          <div
            className="hdr-pv__bar"
            aria-hidden="true"
            data-backdrop={sketch.backdrop}
            data-blur={sketch.blur}
            data-logo={sketch.logo}
            data-logo-pos={sketch.logoPosition}
            data-align={sketch.align}
          >
            <span className="hdr-pv__logo" />
            <span className="hdr-pv__links">
              <span />
              <span />
              <span />
              <span />
            </span>
            <span className="hdr-pv__end">
              {sketch.button && <span className="hdr-pv__cta">{sketch.button}</span>}
              <span className="hdr-pv__lang" />
            </span>
          </div>
        ) : null}
      </div>
    </figure>
  );
}

function Facts() {
  return (
    <ul className="hdr-facts">
      <li>
        <Icon name="globe" size={14} />
        <span>The English and Arabic switch always shows, so every page reaches its twin.</span>
      </li>
      <li>
        <Icon name="mobile" size={14} />
        <span>
          On phones the bar keeps the logo, the key link, the menu button and the language switch;
          the menu opens without any script.
        </span>
      </li>
      <li>
        <Icon name="eye" size={14} />
        <span>
          Visitors who ask for less motion get no sliding: the bar shows and hides at once.
        </span>
      </li>
    </ul>
  );
}

function HeaderOptions() {
  const save = useEntitySave(TARGET, null, { fields: UI.fields, mode: saveModeFor(TARGET) });
  const values = save.values;
  return (
    <EditorForm
      save={save}
      fields={UI.fields}
      groups={UI.groups}
      submitLabel="Save the header"
      noun="header"
      history={HEADER_HISTORY}
      historyOf={{ label: 'Header', path: '/' }}
      slots={{
        preview: (
          <div className="hdr-pvs">
            <Sketch
              sketch={barSketch(values, false)}
              title="Over the hero"
              line="As the page opens"
            />
            <Sketch
              sketch={barSketch(values, true)}
              title="After scrolling"
              line={afterLine(values)}
            />
            <p className="hdr-pv__note">A sketch of the bar. Open the site to see it for real.</p>
          </div>
        ),
        facts: <Facts />,
      }}
    />
  );
}

interface ListAnswer {
  rows?: Record<string, unknown>[];
}

function MenuItems() {
  const base = useId();
  const [rows, setRows] = useState<MenuRow[] | null>(null);
  const [staged, setStaged] = useState(false);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await adminFetch<ListAnswer>('/api/admin/navigation?location=header&limit=100');
      setRows(menuRows(data.rows ?? []));
      setStaged(readsThroughRelease(data));
      setError('');
    } catch (err) {
      setError(describeError(err));
      setRows((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one change, then reads the menu again; a refusal is said after the read. */
  async function run(change: () => Promise<boolean>, done: string) {
    setWorking(true);
    let failure = '';
    try {
      const pending = await change();
      if (pending) announcePending();
      toast(done, 'ok');
    } catch (err) {
      failure = `That was not saved. ${describeError(err)}`;
    }
    await load();
    if (failure) setError(failure);
    setWorking(false);
  }

  const move = (row: MenuRow, step: -1 | 1) =>
    run(async () => {
      const changes = orderChanges(
        (rows ?? []).map((r) => ({ id: r.id, sort_order: r.sortOrder })),
        movedOrder(rows ?? [], row.id, step),
      );
      if (changes.length === 0) return false;
      const moved = await adminFetch<Record<string, unknown>>(
        stagedUrl('/api/admin/navigation/reorder', staged),
        { method: 'POST', body: { items: changes } },
      );
      return 'staged' in moved;
    }, 'Menu order updated.');

  const star = (row: MenuRow) =>
    run(
      async () => {
        let pending = false;
        for (const change of keyChanges(rows ?? [], row.id)) {
          const answer = await adminFetch<Record<string, unknown>>(
            `/api/admin/navigation/${change.id}`,
            {
              method: 'PATCH',
              body: stagedBody({ isKey: change.isKey, version: change.version }, staged),
            },
          );
          pending ||= Boolean(answer['draft']);
        }
        return pending;
      },
      row.isKey ? `${row.label} is no longer the key link.` : `${row.label} is the key link.`,
    );

  const eye = (row: MenuRow) =>
    run(
      async () => {
        const answer = await adminFetch<Record<string, unknown>>(
          `/api/admin/navigation/${row.id}`,
          {
            method: 'PATCH',
            body: stagedBody({ visible: !row.visible, version: row.version }, staged),
          },
        );
        return Boolean(answer['draft']);
      },
      row.visible ? `${row.label} is hidden from the menu.` : `${row.label} shows in the menu.`,
    );

  return (
    <section className="card" aria-labelledby={`${base}-menu`}>
      <div className="card__h">
        <div>
          <h2 className="card-title" id={`${base}-menu`}>
            Menu items
          </h2>
          <p className="card__sub">
            {rows ? `${rows.length} ${rows.length === 1 ? 'link' : 'links'}` : 'Loading'}
          </p>
        </div>
        <a className="btn" data-size="sm" href="/admin/navigation/new">
          <Icon name="plus" size={14} />
          Add a link
        </a>
      </div>
      {error && (
        <Note tone="err" role="alert">
          {error}
        </Note>
      )}
      {rows && rows.length === 0 && !error && (
        <p className="hdr-menu__empty">
          No links of your own yet: the site shows its built-in menu until you add one.
        </p>
      )}
      {rows && rows.length > 0 && (
        <ol className="list hdr-menu__list">
          {rows.map((row, index) => (
            <li
              key={row.id}
              className="li hdr-menu__row"
              data-hidden={row.visible ? undefined : ''}
            >
              <span className="li__main">
                <span className="li__t">{row.label}</span>
                <span className="li__s">
                  {row.href}
                  {row.children > 0 &&
                    ` · ${row.children} ${row.children === 1 ? 'link' : 'links'} under it`}
                </span>
              </span>
              <span className="hdr-menu__badges">
                {row.isKey && <Badge tone="klein">Key link</Badge>}
                {!row.visible && <Badge tone="gray">Hidden</Badge>}
              </span>
              <span className="hdr-menu__acts">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Move ${row.label} up`}
                  disabled={working || index === 0}
                  onClick={() => void move(row, -1)}
                >
                  <Icon name="chevd" size={15} className="ic--flip" />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Move ${row.label} down`}
                  disabled={working || index === rows.length - 1}
                  onClick={() => void move(row, 1)}
                >
                  <Icon name="chevd" size={15} />
                </button>
                <button
                  type="button"
                  className="icon-btn hdr-menu__star"
                  aria-label={`Key link: ${row.label}`}
                  aria-pressed={row.isKey}
                  disabled={working}
                  onClick={() => void star(row)}
                >
                  <Icon name="star" size={15} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Show ${row.label} in the menu`}
                  aria-pressed={row.visible}
                  disabled={working}
                  onClick={() => void eye(row)}
                >
                  <Icon name={row.visible ? 'eye' : 'eyeoff'} size={15} />
                </button>
                <a
                  className="icon-btn hdr-menu__edit"
                  href={`/admin/navigation/${row.id}`}
                  aria-label={`Edit ${row.label}`}
                >
                  <Icon name="edit" size={15} />
                </a>
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="hdr-menu__hint">
        The star marks the key link: on phones it stays in the bar while the rest move into the
        menu. Labels, links, the links under one and removing a link are on the Menus screen.
      </p>
    </section>
  );
}

export default function HeaderScreen({ theme, nav }: HeaderScreenProps) {
  return (
    <div className="hdr">
      {nav && <MenuItems />}
      {theme && <HeaderOptions />}
    </div>
  );
}
