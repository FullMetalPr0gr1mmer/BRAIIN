import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import Avatar from '@/components/admin/kit/Avatar';
import { Badge } from '@/components/admin/kit/StatusBadge';
import type { DisciplineView, PersonView, StageView } from '@/lib/crm/leadPage';
import { FORMER_MEMBER, interestOf, sourceLabel, sourceTone } from '@/lib/crm/leadView';
import type { AddLeadDrawerProps } from './AddLeadDrawer';

// What the leads islands share (Admin v2 C4b): the permissions the page computed, the words
// for a lead's stage, source, interest and assignee, and the page head's "Add lead manually".
// Pure helpers and small components; no read of their own.

/**
 * What the page decided from ROLE_CAPS on the server. UX only: every route re-checks
 * (`leads.pii` for the contact details, the notes and the manual add; `export.csv`;
 * `crm.erase`; `services.write`), so a forged flag reaches a 403.
 */
export interface LeadsPermissions {
  canSeePii: boolean;
  canExport: boolean;
  canErase: boolean;
  canEditServices: boolean;
}

/** The fields of a lead the screens read (list rows, board cards and the detail share them). */
export interface LeadLike {
  id: string;
  name?: unknown;
  company?: unknown;
  service_of_interest?: unknown;
  discipline_of_interest?: unknown;
  service_label?: { en: string; ar: string } | undefined;
  discipline_label?: { en: string; ar: string } | undefined;
}

export const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A lead's name as the screens print it (a lead with none still needs a handle). */
export function leadName(lead: object): string {
  return text((lead as { name?: unknown }).name).trim() || 'A lead with no name';
}

/** What they asked about: the service or discipline label the server resolved. */
export function interestText(lead: LeadLike): string {
  return interestOf({
    service_of_interest: text(lead.service_of_interest) || null,
    discipline_of_interest: text(lead.discipline_of_interest) || null,
    service_label: lead.service_label ?? null,
    discipline_label: lead.discipline_label ?? null,
  });
}

/** The discipline a lead's service sits in (published ones, from the page's frame). */
export function disciplineOfService(
  slug: unknown,
  disciplines: readonly DisciplineView[],
): string | null {
  if (typeof slug !== 'string' || slug === '') return null;
  return disciplines.find((d) => d.services.some((s) => s.slug === slug))?.name ?? null;
}

export function stageById(stages: readonly StageView[], id: unknown): StageView | undefined {
  return typeof id === 'string' ? stages.find((stage) => stage.id === id) : undefined;
}

export function StageBadge({ stages, id }: { stages: readonly StageView[]; id: unknown }) {
  const stage = stageById(stages, id);
  return <Badge tone={stage?.tone ?? 'gray'}>{stage?.label ?? 'No stage'}</Badge>;
}

export function SourceBadge({ source, channel }: { source: unknown; channel: unknown }) {
  return <Badge tone={sourceTone(source)}>{sourceLabel(source, channel)}</Badge>;
}

/** A person's name, "Nobody yet" for no one, or a former member (decision D15). */
export function assigneeName(id: unknown, people: readonly PersonView[]): string | null {
  if (typeof id !== 'string' || id === '') return null;
  return people.find((person) => person.id === id)?.name ?? FORMER_MEMBER;
}

/** The assignee as an avatar and a name, or "Nobody". */
export function Assignee({ id, people }: { id: unknown; people: readonly PersonView[] }) {
  const name = assigneeName(id, people);
  if (name === null) return <span className="lead-sub">Nobody</span>;
  return (
    <span className="lead-who">
      <Avatar name={name} toneKey={String(id)} size="sm" />
      <span dir="auto">{name}</span>
    </span>
  );
}

/**
 * The page head's "Add lead manually" (a button the page renders hidden, decision D9: with
 * no JavaScript there is no drawer to open): shown once the island is up, and a press opens
 * the drawer, which is loaded on first use only (import(), so neither it nor anything it
 * needs rides on the list's or the board's first load).
 */
export function useAddLead(enabled: boolean, disciplines: readonly DisciplineView[]): ReactNode {
  const [open, setOpen] = useState(false);
  const [Drawer, setDrawer] = useState<ComponentType<AddLeadDrawerProps> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-lead-add]')];
    for (const button of buttons) button.hidden = false;
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('[data-lead-add]')) return;
      event.preventDefault();
      setFailed(false);
      import('./AddLeadDrawer')
        .then((module) => {
          setDrawer(() => module.default);
          setOpen(true);
        })
        .catch(() => setFailed(true));
    };
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('click', onClick);
      for (const button of buttons) button.hidden = true;
    };
  }, [enabled]);

  if (failed) {
    return (
      <p className="msg" data-kind="error" role="alert">
        The form to add a lead could not be loaded. Reload the page and try again.
      </p>
    );
  }
  return Drawer ? (
    <Drawer open={open} onClose={() => setOpen(false)} disciplines={disciplines} />
  ) : null;
}
