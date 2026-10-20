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
//
// Admin v2 U8b: the tab list alone is `TabStrip`, a controlled component, for a screen that
// draws its own panels (EditorForm's tabbed editors keep their field tabs inside one form and
// a panel tab after it). `Tabs` is TabStrip plus its panels, its markup and behaviour as
// before. A tab may carry a `cue` ("has errors"): a dot it shows, and words its accessible
// name ends with ("Content, has errors"), so the visible label starts the name (WCAG 2.5.3).
// The name is the tab's `aria-label`, not a visually hidden span: Chromium puts a space before
// the text of an absolutely positioned element when it builds a name from content, so a span
// gave "Content , has errors" (and an e2e looking for the name found nothing).

export interface TabStripTab {
  id: string;
  label: string;
  icon?: IconName | undefined;
  /** Words the tab's name ends with, and a dot it shows ("has errors"). */
  cue?: string | undefined;
}

export interface TabStripProps {
  tabs: readonly TabStripTab[];
  /** The tab list's name ("Post editor"). */
  label: string;
  /** The current tab's id. */
  value: string;
  onChange: (id: string) => void;
  /** The ids' base: tab `<idBase>-tab-<id>` controls panel `<idBase>-panel-<id>`. */
  idBase: string;
  /** The query parameter kept in step with the tab; null leaves the URL alone. */
  param?: string | null;
}

/** A tab's element id, and the id of the panel it controls. */
export const tabIds = (idBase: string, id: string) => ({
  tab: `${idBase}-tab-${id}`,
  panel: `${idBase}-panel-${id}`,
});

/** Writes `?<param>=<id>` without a history entry. */
export function writeTabParam(param: string | null | undefined, id: string): void {
  if (!param || typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set(param, id);
  window.history.replaceState(window.history.state, '', url);
}

export function TabStrip({ tabs, label, value, onChange, idBase, param = 'tab' }: TabStripProps) {
  const ids = tabs.map((tab) => tab.id);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function select(index: number, focus: boolean) {
    const tab = tabs[index];
    if (!tab) return;
    if (focus) buttons.current[index]?.focus();
    writeTabParam(param, tab.id);
    onChange(tab.id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const rtl = window.getComputedStyle(event.currentTarget).direction === 'rtl';
    const next = rovingIndex(event.key, ids.indexOf(value), tabs.length, { rtl });
    if (next === null) return;
    event.preventDefault();
    select(next, true);
  }

  return (
    <div className="seg" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab, index) => {
        const selected = tab.id === value;
        const { tab: tabId, panel } = tabIds(idBase, tab.id);
        return (
          <button
            key={tab.id}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            role="tab"
            id={tabId}
            aria-selected={selected}
            aria-controls={panel}
            tabIndex={selected ? 0 : -1}
            aria-label={tab.cue ? `${tab.label}, ${tab.cue}` : undefined}
            data-cue={tab.cue ? '' : undefined}
            onClick={() => select(index, false)}
          >
            {tab.icon && <Icon name={tab.icon} size={14} />}
            {tab.label}
            {tab.cue && <span className="tab-cue" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

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

  return (
    <>
      <TabStrip
        tabs={tabs}
        label={label}
        value={current}
        idBase={base}
        param={param}
        onChange={(id) => {
          setCurrent(id);
          onChange?.(id);
        }}
      />
      {tabs.map((tab) => {
        const { tab: tabId, panel } = tabIds(base, tab.id);
        return (
          <div
            key={tab.id}
            role="tabpanel"
            id={panel}
            aria-labelledby={tabId}
            tabIndex={0}
            hidden={tab.id !== current}
          >
            {tab.panel}
          </div>
        );
      })}
    </>
  );
}
