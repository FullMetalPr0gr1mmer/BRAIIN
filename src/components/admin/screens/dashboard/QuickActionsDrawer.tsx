import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  QUICK_CUSTOM_MAX,
  QUICK_ICONS,
  QUICK_MAX,
  QuickCustomItemSchema,
  isCustomItem,
  type QuickItem,
} from '@schemas/dashboard';
import Drawer from '@/components/admin/kit/Drawer';
import Icon from '@/components/admin/kit/Icon';
import ListRow from '@/components/admin/kit/ListRow';
import { MoveButtons, SortHandle, SortHint } from '@/components/admin/kit/Sortable';
import { useSortable } from '@/components/admin/kit/useSortable';
import type { LibraryEntry } from './types';

// The quick-actions editor (Admin v2 U1; the prototype's quickEditor): the person's list, in
// order (the kit's Sortable: drag, the keys, or Move up and down), each with Remove; the
// library their role may use, one chip each; and "Add your own": a label, an admin path or an
// https address (packages/schemas/dashboard.ts refuses anything else, here and on the
// server), and an icon from a closed list. At most 12 in all, 8 of them the person's own.
// Save (explicit, P-5) and Reset to default save, then the page reloads.

export interface QuickActionsDrawerProps {
  open: boolean;
  onClose: () => void;
  items: readonly QuickItem[];
  library: readonly LibraryEntry[];
  onSave: (items: QuickItem[]) => Promise<boolean>;
  onReset: () => Promise<boolean>;
}

const ICON_LABEL: Record<(typeof QUICK_ICONS)[number], string> = {
  link: 'Link',
  ext: 'Outside link',
  star: 'Star',
  zap: 'Lightning',
  cal: 'Calendar',
  mail: 'Mail',
  globe: 'Globe',
  note: 'Note',
  film: 'Film',
  chart: 'Chart',
  users: 'People',
  layers: 'Layers',
  image: 'Image',
};

/** A new id for a person's own link: `c-` and ten random lowercase letters and digits. */
function customId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `c-${[...bytes].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;
}

export default function QuickActionsDrawer(props: QuickActionsDrawerProps) {
  const { open, onClose, library } = props;
  const [items, setItems] = useState<QuickItem[]>(() => [...props.items]);
  const [label, setLabel] = useState('');
  const [href, setHref] = useState('');
  const [icon, setIcon] = useState<(typeof QUICK_ICONS)[number]>('link');
  const [errors, setErrors] = useState<{ label?: string; href?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const formId = useId();

  // A drawer opened again starts from what is saved.
  useEffect(() => {
    if (open) {
      setItems([...props.items]);
      setErrors({});
    }
  }, [open, props.items]);

  const byId = new Map(items.map((item) => [item.id, item]));
  const nameOf = (id: string): string => {
    const item = byId.get(id);
    if (item && isCustomItem(item)) return item.label;
    return library.find((a) => a.id === id)?.label ?? id;
  };
  const { ref, lists, hintId } = useSortable<HTMLUListElement>({
    lists: { list: items.map((item) => item.id) },
    onCommit: (next) =>
      setItems((next['list'] ?? []).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))),
  });

  const customCount = items.filter(isCustomItem).length;
  const full = items.length >= QUICK_MAX;
  const remaining = library.filter((a) => !byId.has(a.id));

  function addCustom(event: FormEvent) {
    event.preventDefault();
    if (full || customCount >= QUICK_CUSTOM_MAX) {
      setErrors({
        form: full
          ? `You have ${QUICK_MAX} quick actions, the most there can be. Remove one first.`
          : `You have ${QUICK_CUSTOM_MAX} links of your own, the most there can be.`,
      });
      return;
    }
    const parsed = QuickCustomItemSchema.safeParse({ id: customId(), label, href, icon });
    if (!parsed.success) {
      const next: { label?: string; href?: string } = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if ((key === 'label' || key === 'href') && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setItems((list) => [...list, parsed.data]);
    setLabel('');
    setHref('');
    setIcon('link');
    setErrors({});
  }

  async function run(work: () => Promise<boolean>) {
    setBusy(true);
    const ok = await work();
    if (!ok) setBusy(false);
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Customize quick actions"
      dismissible={false}
      footer={
        <>
          <button
            type="button"
            data-variant="ghost"
            aria-disabled={busy ? 'true' : undefined}
            onClick={() => {
              if (!busy) void run(props.onReset);
            }}
          >
            Reset to default
          </button>
          <button
            type="button"
            data-variant="primary"
            aria-disabled={busy ? 'true' : undefined}
            onClick={() => {
              if (!busy) void run(() => props.onSave(items));
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <p className="admin-sub">
        Tick the actions you want on your dashboard. Drag to reorder. Each person has their own set.
      </p>

      <h3 className="dash__h">On your dashboard</h3>
      {items.length === 0 && <p className="dash__empty-line">Nothing yet.</p>}
      {/* Always rendered, so the Sortable core is bound before the first item arrives. */}
      <ul className="list" ref={ref} aria-label="Your quick actions">
        {(lists['list'] ?? []).map((id) => {
          const item = byId.get(id);
          if (!item) return null;
          const custom = isCustomItem(item);
          const name = nameOf(id);
          return (
            <ListRow
              key={id}
              title={name}
              sub={custom ? `${item.href}, your own link` : 'From the library'}
              sortId={id}
              sortLabel={name}
              lead={<SortHandle label={name} describedBy={hintId} />}
              meta={<MoveButtons label={name} />}
              actions={
                <button
                  type="button"
                  className="icon-btn"
                  data-variant="danger"
                  aria-label={`Remove ${name}`}
                  onClick={() => setItems((list) => list.filter((x) => x.id !== id))}
                >
                  <Icon name="x" size={14} />
                </button>
              }
            />
          );
        })}
      </ul>
      <SortHint id={hintId} />

      <h3 className="dash__h">Add from the library</h3>
      {remaining.length === 0 ? (
        <p className="dash__empty-line">
          Everything from the library is already on your dashboard.
        </p>
      ) : (
        <div className="dash__chips">
          {remaining.map((action) => (
            <button
              key={action.id}
              type="button"
              className="chip"
              aria-disabled={full ? 'true' : undefined}
              onClick={() => {
                if (!full) setItems((list) => [...list, { id: action.id }]);
              }}
            >
              <Icon name={action.icon} size={14} />
              {action.label}
              <span className="visually-hidden">: add to your quick actions</span>
            </button>
          ))}
        </div>
      )}

      <form className="dash__own" id={formId} noValidate onSubmit={addCustom}>
        <h3 className="dash__h">Add your own</h3>
        <p className="admin-sub">A link to any admin screen or an outside tool.</p>
        <label className="field">
          <span>Label</span>
          <input
            type="text"
            value={label}
            maxLength={40}
            aria-invalid={errors.label ? 'true' : undefined}
            aria-describedby={errors.label ? `${formId}-label-error` : undefined}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        {errors.label && (
          <p className="field-error" id={`${formId}-label-error`}>
            {errors.label}
          </p>
        )}
        <label className="field">
          <span>Link</span>
          <input
            type="text"
            inputMode="url"
            value={href}
            placeholder="/admin/leads or https://"
            aria-invalid={errors.href ? 'true' : undefined}
            aria-describedby={`${formId}-href-hint${errors.href ? ` ${formId}-href-error` : ''}`}
            onChange={(event) => setHref(event.target.value)}
          />
        </label>
        <p className="admin-sub" id={`${formId}-href-hint`}>
          Admin paths start with /admin. Anything else must start with https:// and opens in a new
          tab.
        </p>
        {errors.href && (
          <p className="field-error" id={`${formId}-href-error`}>
            {errors.href}
          </p>
        )}
        {/* A label beside the select (for/id), not around it: a wrapping label's text takes in
            every option's ("Link", "Outside link"…), so the select would answer to them too. */}
        <div className="field dash__select">
          <label htmlFor={`${formId}-icon`}>Icon</label>
          <select
            id={`${formId}-icon`}
            value={icon}
            onChange={(event) => setIcon(event.target.value as (typeof QUICK_ICONS)[number])}
          >
            {QUICK_ICONS.map((name) => (
              <option key={name} value={name}>
                {ICON_LABEL[name]}
              </option>
            ))}
          </select>
        </div>
        {errors.form && (
          <p className="msg" data-kind="error" role="alert">
            {errors.form}
          </p>
        )}
        <button type="submit" data-variant="soft" data-size="sm">
          <Icon name="plus" size={14} />
          Add action
        </button>
      </form>
    </Drawer>
  );
}
