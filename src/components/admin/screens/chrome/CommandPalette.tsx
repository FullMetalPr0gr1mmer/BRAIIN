import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { adminFetch } from '@/lib/admin/client';
import {
  MIN_REMOTE_QUERY,
  filterGroups,
  flatten,
  move,
  remoteGroups,
  seeAll,
  type PaletteGroup,
  type RemoteGroup,
} from '@/lib/admin/palette';
import Icon from '@/components/admin/kit/Icon';

// The command palette (Admin v2 F3, docs/admin-v2/ui.md §2.7): ⌘/Ctrl+K anywhere, or the
// topbar's search trigger. The prototype's bare "/" is not ported: a one-character
// shortcut fires on a stray keypress or a dictated "slash", and WCAG 2.1.4 (Level A)
// requires one to be switchable off or remappable, so it is left out instead
// (docs/admin-v2/deviations.md).
//
// A native modal <dialog> brings the focus trap, Escape, the top layer and focus return
// to whatever had focus before. Inside, the ARIA combobox pattern: the input owns the
// keyboard (arrows, Enter) and points at the active option with aria-activedescendant,
// so focus never leaves the field while the list changes under it.
//
// Results come from two places. The role's own screens and quick actions arrive as props
// and match instantly. Records come from GET /api/admin/search (the server decides what
// the role may find; leads, contacts and applications are never in it), asked 200 ms after
// typing stops, with the stale request aborted. An option navigates; nothing executes.

const DEBOUNCE_MS = 200;
const LIST_ID = 'cmd-list';

export interface CommandPaletteProps {
  /** The role's screens and quick actions, built on the server from ROLE_CAPS. */
  groups: PaletteGroup[];
}

export default function CommandPalette({ groups }: CommandPaletteProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<PaletteGroup[]>([]);
  const [busy, setBusy] = useState(false);
  /** What the last server search could not do, said in the status line. */
  const [note, setNote] = useState('');
  const [active, setActive] = useState(0);

  const shown = useMemo(() => {
    const list = [...filterGroups(groups, query), ...remote];
    if (query.trim().length >= MIN_REMOTE_QUERY)
      list.push({ title: 'More', items: [seeAll(query)] });
    return list;
  }, [groups, query, remote]);
  const items = useMemo(() => flatten(shown), [shown]);
  const status = busy
    ? 'Searching…'
    : note || (query.trim() && items.length === 0 ? 'No matches.' : '');

  const open = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    setQuery('');
    setRemote([]);
    setNote('');
    setActive(0);
    dialog.showModal();
    inputRef.current?.focus();
  }, []);

  // ⌘/Ctrl+K anywhere. Always with a modifier: never a single character (see above).
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        open();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // The topbar trigger is a real link to /admin/search (the no-JS path); with JS it opens
  // the palette instead.
  useEffect(() => {
    const onClick = (event: globalThis.MouseEvent) => {
      const trigger = (event.target as Element | null)?.closest('[data-open="palette"]');
      if (!trigger || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
        return;
      event.preventDefault();
      open();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);

  // Records from the server, debounced, the stale request aborted.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_REMOTE_QUERY) {
      setRemote([]);
      setNote('');
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setBusy(true);
      try {
        const data = await adminFetch<{ groups?: RemoteGroup[]; failed?: string[] }>(
          `/api/admin/search?q=${encodeURIComponent(q)}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setRemote(remoteGroups(data.groups ?? []));
          // An area the server could not search (it logs why) is missing from the list,
          // which must not read as "nothing there".
          setNote((data.failed ?? []).length > 0 ? 'Some areas could not be searched.' : '');
        }
      } catch {
        // Aborted by the next keystroke: nothing to say. A failed search: the local
        // results stand and "See all results" still reaches the full page, but no record
        // was searched, so the status line says so.
        if (!controller.signal.aborted) setNote('Records could not be searched just now.');
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // A new list starts at its first option, so Enter takes the best match.
  useEffect(() => {
    setActive(items.length > 0 ? 0 : -1);
  }, [items.length, query]);

  // The active option stays in view as the arrows walk a list longer than the box.
  useEffect(() => {
    if (active >= 0)
      document.getElementById(`cmd-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function go(index: number) {
    const item = items[index];
    if (item) window.location.href = item.href;
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => move(current, items.length, event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(active);
    }
  }

  // A click on the dialog itself (the scrim around the box) closes it.
  function onDialogClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) dialogRef.current?.close();
  }

  let index = -1;
  return (
    <dialog ref={dialogRef} className="cmd" aria-label="Search the admin" onClick={onDialogClick}>
      <div className="cmd__box">
        <div className="cmd__in">
          <Icon name="search" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search the admin"
            aria-expanded={items.length > 0}
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 && items[active] ? `cmd-opt-${active}` : undefined}
            placeholder="Search pages, services, projects…"
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd>Esc</kbd>
        </div>
        {/* tabIndex -1: reachable by script and pointer, never in the Tab order (the
            input owns the keyboard), so the scrollable list is not a dead region. */}
        <div id={LIST_ID} role="listbox" aria-label="Results" className="cmd__list" tabIndex={-1}>
          {shown.map((group, groupIndex) => (
            <div
              role="group"
              aria-labelledby={`cmd-g-${groupIndex}`}
              key={`${group.title}-${groupIndex}`}
            >
              <p className="cmd__g" id={`cmd-g-${groupIndex}`}>
                {group.title}
              </p>
              {group.items.map((item) => {
                index += 1;
                const own = index;
                return (
                  <div
                    key={item.key}
                    id={`cmd-opt-${own}`}
                    role="option"
                    aria-selected={own === active}
                    className="cmd__i"
                    // Keep focus in the input while the pointer picks.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => setActive(own)}
                    onClick={() => go(own)}
                  >
                    <Icon name={item.icon} size={16} />
                    <span>{item.label}</span>
                    {item.detail && <i>{item.detail}</i>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {/* Outside the listbox, which may own only options and groups, and mounted with
            the dialog, so a screen reader announces each change of its text. */}
        <p className="cmd__status" role="status">
          {status}
        </p>
      </div>
    </dialog>
  );
}
