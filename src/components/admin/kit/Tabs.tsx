import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import Icon from './Icon';
import type { IconName } from '@/lib/admin/icons';
import { rovingIndex, tabFromParam } from '@/lib/admin/roving';

// Tabs that switch panels in place (Admin v2 F4b, docs/admin-v2/ui.md §2.5): the ARIA tabs
// pattern on the prototype's segmented look.
//   - Keyboard: one tab stop (roving tabindex); the arrows move and select (mirrored in a
//     right-to-left block), Home and End go to the ends.
//   - URL: the chosen tab is written to `?tab=` with history.replaceState (no new history
//     entry), and the server renders the tab the URL names (pass it as `active`, read with
//     tabFromParam), so a reload or a shared link opens the same tab without a flash.
//   - Panels stay mounted, hidden: a form split across tabs keeps what was typed.
// Tabs that change the URL path are links instead (ui/LinkTabs.astro).

export interface TabDef {
  id: string;
  label: string;
  icon?: IconName | undefined;
  panel: ReactNode;
}

export interface TabsProps {
  tabs: readonly TabDef[];
  /** The tab list's name ("Service sections"). */
  label: string;
  /** The tab to open first: the server's reading of `?tab=`. */
  active?: string | null | undefined;
  /** The query parameter kept in step with the tab; null leaves the URL alone. */
  param?: string | null;
  onChange?: ((id: string) => void) | undefined;
}

export default function Tabs({ tabs, label, active, param = 'tab', onChange }: TabsProps) {
  const base = useId();
  const ids = tabs.map((tab) => tab.id);
  const [current, setCurrent] = useState(() => tabFromParam(active, ids, ids[0] ?? ''));
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function select(index: number, focus: boolean) {
    const tab = tabs[index];
    if (!tab) return;
    setCurrent(tab.id);
    if (focus) buttons.current[index]?.focus();
    if (param) {
      const url = new URL(window.location.href);
      url.searchParams.set(param, tab.id);
      window.history.replaceState(window.history.state, '', url);
    }
    onChange?.(tab.id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const rtl = window.getComputedStyle(event.currentTarget).direction === 'rtl';
    const next = rovingIndex(event.key, ids.indexOf(current), tabs.length, { rtl });
    if (next === null) return;
    event.preventDefault();
    select(next, true);
  }

  return (
    <>
      <div className="seg" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((tab, index) => {
          const selected = tab.id === current;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                buttons.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(index, false)}
            >
              {tab.icon && <Icon name={tab.icon} size={14} />}
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${base}-panel-${tab.id}`}
          aria-labelledby={`${base}-tab-${tab.id}`}
          tabIndex={0}
          hidden={tab.id !== current}
        >
          {tab.panel}
        </div>
      ))}
    </>
  );
}
