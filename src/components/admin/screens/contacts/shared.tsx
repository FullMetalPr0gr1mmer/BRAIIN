import {
  useEffect,
  useId,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from 'react';
import Avatar from '@/components/admin/kit/Avatar';
import { Badge } from '@/components/admin/kit/StatusBadge';
import { FORMER_MEMBER } from '@/lib/crm/leadView';
import { stageLabel, stageToneOf, type ContactPerson } from '@/lib/crm/contactView';

// What the contacts islands share (Admin v2 C7): the permissions the page computed, the people
// the screens name, the stage badge, the owner, the search box and the page head's "Add
// contact". Small components and helpers; no read of their own.

/**
 * What the page decided from ROLE_CAPS on the server. UX only: every route re-checks
 * (`crm.erase` for the erasure and a note's deletion; `leads.manage` + `leads.pii` for a new
 * lead), so a forged flag reaches a 403.
 */
export interface ContactsPermissions {
  canErase: boolean;
  canAddLead: boolean;
}

export type { ContactPerson };

/** The owner's name, a former member's words, or null for no owner. */
export function ownerName(id: unknown, people: readonly ContactPerson[]): string | null {
  if (typeof id !== 'string' || id === '') return null;
  return people.find((person) => person.id === id)?.name ?? FORMER_MEMBER;
}

export function Owner({ id, people }: { id: unknown; people: readonly ContactPerson[] }) {
  const name = ownerName(id, people);
  if (name === null) return <span className="lead-sub">No owner</span>;
  return (
    <span className="lead-who">
      <Avatar name={name} toneKey={String(id)} size="sm" />
      <span dir="auto">{name}</span>
    </span>
  );
}

export function ContactStageBadge({ stage }: { stage: unknown }) {
  return <Badge tone={stageToneOf(stage)}>{stageLabel(stage)}</Badge>;
}

export const SEARCH_PLACEHOLDER = 'Search name or company. Full e-mail or phone also works.';

/**
 * The search box: a form, so Enter searches and a half-typed address is never sent (it would be
 * refused on every key: a whole e-mail or phone is found through its blind index). Posted in a
 * body; never put in the address. Clearing it searches for everyone.
 */
export function ContactSearch({
  value,
  onSearch,
  error,
}: {
  value: string;
  onSearch: (term: string) => void;
  error: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(draft.trim());
  };
  return (
    <form role="search" className="lead-search" onSubmit={submit}>
      <div className="lead-search__box">
        <label className="visually-hidden" htmlFor={id}>
          Search contacts
        </label>
        <input
          id={id}
          type="search"
          maxLength={64}
          autoComplete="off"
          placeholder={SEARCH_PLACEHOLDER}
          value={draft}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            if (event.target.value === '' && value !== '') onSearch('');
          }}
        />
        {error && (
          <p id={`${id}-error`} className="msg" data-kind="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <button type="submit">Search</button>
    </form>
  );
}

/**
 * A dialog loaded on first use (import(), so neither it nor the kit pieces it draws ride on
 * the page's first load): `open()` loads it and shows it, `element` is what to render. Once
 * loaded it stays mounted and is told `open`, so closing it gives focus back to what opened
 * it (the native <dialog> does that).
 */
export function useLazy<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  props: (open: boolean, close: () => void) => P,
): { open: () => void; element: ReactNode } {
  const [Loaded, setLoaded] = useState<ComponentType<P> | null>(null);
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);
  const open = () => {
    setFailed(false);
    load()
      .then((module) => {
        setLoaded(() => module.default);
        setShown(true);
      })
      .catch(() => setFailed(true));
  };
  const close = () => setShown(false);
  const element = failed ? (
    <p className="msg" data-kind="error" role="alert">
      This could not be loaded. Reload the page and try again.
    </p>
  ) : Loaded ? (
    <Loaded {...props(shown, close)} />
  ) : null;
  return { open, element };
}

/**
 * Wires a button the page renders hidden (no JavaScript, no dialog to open) to `open`: shown
 * once the island is up, and a press calls `open`.
 */
export function usePageButton(selector: string, enabled: boolean, open: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(selector)];
    for (const button of buttons) button.hidden = false;
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(selector)) return;
      event.preventDefault();
      open();
    };
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('click', onClick);
      for (const button of buttons) button.hidden = true;
    };
  }, [enabled]);
}
