import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
} from 'react';
import { flushSync } from 'react-dom';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import { useClock } from '@/components/admin/kit/clock';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { showFlash } from '@/lib/admin/flash';
import { isoOf } from '@/lib/admin/relTime';
import { CONTACT_STAGES, type ContactPatch } from '@schemas/crm';
import { Latest, Serial, changeUnsure, withDeadline, writeInTurn } from '@/lib/crm/lateAnswers';
import { formatSar, scoreBand, scoreBucket } from '@/lib/crm/leadView';
import type {
  ChannelPresence,
  ContactDetailInitial,
  ContactDetailRow,
} from '@/lib/crm/contactPage';
import type { StageView } from '@/lib/crm/leadPage';
import {
  CONTACT_STAGE_LABELS,
  addMonths,
  contactName,
  leadTotals,
  roleLine,
  type ContactEvent,
  type ContactLead,
} from '@/lib/crm/contactView';
import ContactChannelsCard, { type RevealedValues } from './ContactChannelsCard';
import ContactCompanyCard, { type CompanyChange } from './ContactCompanyCard';
import ContactDetailsCard from './ContactDetailsCard';
import ContactLeadsCard from './ContactLeadsCard';
import ContactNotes from './ContactNotes';
import ContactTimeline, { type TimelineKind } from './ContactTimeline';
import type { EraseContactDialogProps } from './EraseContactDialog';
import type { NewLeadDrawerProps } from './NewLeadDrawer';
import type { TasksCardProps } from '../tasks/TasksCard';
import type { ContactFilesCardProps } from './ContactFilesCard';
import type { TaskPerson } from '../tasks/shared';
import { forgetOnLeave, useLazy, type ContactPerson, type ContactsPermissions } from './shared';

// One contact (Admin v2 C7, crm.md §11 screen 6). The page renders the head (the name as the
// h1, "title at Company") and this island's first view on the server; the island keeps the
// contact in state and writes it one control at a time (the star, the stage, the owner, the
// tags: one PATCH each) or a form at a time (Details, explicit Save), reveals the contact
// details on request, and reads the notes and the older timeline itself.
//
// Every read and write of the row runs one after another (src/lib/crm/lateAnswers.ts Serial),
// so a versioned change always leaves with the newest version the page holds; a 409 says
// "Someone else changed this. Refreshed." and reads the contact again. The server render holds
// the safe columns and the channels' presence only: e-mails and phones arrive through the
// audited reveal, on a person's request, and are kept in this island's state only.

export interface ContactDetailProps extends ContactDetailInitial {
  leadStages: StageView[];
  people: ContactPerson[];
  permissions: ContactsPermissions;
  me: { id: string; name: string };
  now: string;
  /**
   * (Admin v2 C8b) For a crm.tasks holder: who a task may be given to. The Tasks card is drawn
   * only then (a UX hint: the task routes refuse anyone else), loaded with import() once the
   * page is up, so the contact page's first load does not carry it.
   */
  tasks?: { owners: TaskPerson[] } | null | undefined;
  /**
   * (Admin v2 C16) For a crm.files holder: the Files card, drawn only then (a UX hint: the file
   * routes refuse anyone else), loaded with import() once the page is up.
   */
  files?: boolean | undefined;
}

interface ContactAnswer {
  contact: ContactDetailRow;
  /** (Admin v2 C11 review) The auto-company a company change removed, if any. */
  removedCompany?: string | null;
  channels?: ChannelPresence[];
  leads?: ContactLead[];
  moreLeads?: boolean;
}

interface TimelineAnswer {
  events: ContactEvent[];
  next: { before: string; beforeSrc: string; beforeId: number } | null;
}

const CONFLICT = 'Someone else changed this. Refreshed.';

export default function ContactDetail(props: ContactDetailProps) {
  const { formatDate, relTime } = useClock();
  const { people, permissions, me, leadStages } = props;
  const id = useId();
  const [contact, setContact] = useState<ContactDetailRow>(props.contact);
  const [channels, setChannels] = useState<ChannelPresence[]>(props.channels);
  const [leads, setLeads] = useState<ContactLead[]>(props.leads);
  const [moreLeads, setMoreLeads] = useState(props.moreLeads);
  const [events, setEvents] = useState<ContactEvent[]>(props.timeline.events as ContactEvent[]);
  const [next, setNext] = useState(props.timeline.next);
  const [kind, setKind] = useState<TimelineKind>('all');
  const [eventsBusy, setEventsBusy] = useState(false);
  const [eventsError, setEventsError] = useState('');
  const [revealed, setRevealed] = useState<RevealedValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(
    null,
  );
  const [tagDraft, setTagDraft] = useState('');
  const [now, setNow] = useState(() => Date.parse(props.now));
  const [TasksCard, setTasksCard] = useState<ComponentType<TasksCardProps> | null>(null);
  const [FilesCard, setFilesCard] = useState<ComponentType<ContactFilesCardProps> | null>(null);
  const [queue] = useState(() => new Serial(setBusy));
  const [timeline] = useState(() => new Latest());
  // The row as last drawn, for a queued write to read its version when it leaves.
  const row = useRef<ContactDetailRow>(props.contact);
  const base = `/api/admin/crm/contacts/${props.contact.id}`;

  const erase = useLazy<EraseContactDialogProps>(
    () => import('./EraseContactDialog'),
    (open, close) => ({ open, onClose: close, contactId: contact.id, name: contactName(contact) }),
  );
  const newLead = useLazy<NewLeadDrawerProps>(
    () => import('./NewLeadDrawer'),
    (open, close) => ({ open, onClose: close, contact }),
  );

  function show(next: ContactDetailRow) {
    row.current = next;
    setContact(next);
    // The page head's h1 and sub-line are the server's: kept in step after a rename (the
    // sub-line made when the contact had no title or company before). Text only.
    const head = document.querySelector('.admin-header h1');
    if (head) head.textContent = contactName(next);
    const line = roleLine(next['title'], next['company_name']);
    let sub = document.querySelector('.admin-header .admin-sub');
    if (!sub && line && head) {
      sub = document.createElement('p');
      sub.className = 'admin-sub';
      head.insertAdjacentElement('afterend', sub);
    }
    if (sub) {
      // A person's words, in their own direction (as the server draws it, C7 review).
      sub.setAttribute('dir', 'auto');
      sub.textContent = line;
    }
  }

  const peopleById = useMemo(
    () => new Map(people.map((person) => [person.id, person.name] as const)),
    [people],
  );
  const stagesByKey = useMemo(
    () => new Map(leadStages.map((stage) => [stage.key, { label: stage.label }])),
    [leadStages],
  );
  const won = useMemo(
    () => new Set(leadStages.filter((s) => s.kind === 'won').map((s) => s.id)),
    [leadStages],
  );

  /** Reads the contact, its channels and its leads (bounded); a failure is said unless quiet. */
  async function readContact(quiet = false): Promise<void> {
    try {
      const answer = await withDeadline((signal) => adminFetch<ContactAnswer>(base, { signal }));
      show(answer.contact);
      if (answer.channels) setChannels(answer.channels);
      if (answer.leads) setLeads(answer.leads);
      if (answer.moreLeads !== undefined) setMoreLeads(answer.moreLeads);
    } catch (err) {
      if (!quiet) setMessage({ tone: 'err', text: describeError(err) });
    }
  }

  async function reloadEvents(which: TimelineKind = kind) {
    const controller = timeline.next();
    try {
      const answer = await adminFetch<TimelineAnswer>(`${base}/timeline?kind=${which}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      timeline.drawn();
      setEvents(answer.events);
      setNext(answer.next);
      setEventsError('');
      setNow(Date.now());
    } catch (err) {
      if (controller.signal.aborted) return;
      setEventsError(describeError(err));
    }
  }

  async function olderEvents() {
    if (!next) return;
    setEventsBusy(true);
    const controller = timeline.more();
    try {
      const query = new URLSearchParams({
        kind,
        before: next.before,
        beforeSrc: next.beforeSrc,
        beforeId: String(next.beforeId),
      });
      const answer = await adminFetch<TimelineAnswer>(`${base}/timeline?${query.toString()}`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setEvents((list) => [...list, ...answer.events]);
      setNext(answer.next);
      setEventsError('');
    } catch (err) {
      if (controller.signal.aborted) return;
      setEventsError(describeError(err));
    } finally {
      setEventsBusy(false);
    }
  }

  /**
   * One PATCH in the page's queue, bounded (writeInTurn): the newest version the page holds with
   * a versioned change. Any failure reads the contact again in the same turn (the PATCH may have
   * committed before it failed); after a 409 the refresh is said, otherwise the write's error.
   */
  function write(
    body: Record<string, unknown>,
    versioned: boolean,
    after?: (answer: ContactAnswer) => void,
    // (Admin v2 C11) A write to another of the contact's routes (its company), same rules.
    send: (sent: Record<string, unknown>, signal: AbortSignal) => Promise<ContactAnswer> = (
      sent,
      signal,
    ) =>
      adminFetch<ContactAnswer>(`/api/admin/crm/contacts/${props.contact.id}`, {
        method: 'PATCH',
        body: sent,
        signal,
      }),
  ): Promise<boolean> {
    setMessage(null);
    return writeInTurn(queue, {
      send: (signal) => send(versioned ? { ...body, version: row.current.version } : body, signal),
      saved: (answer) => {
        show(answer.contact);
        if (answer.channels) setChannels(answer.channels);
        after?.(answer);
        void reloadEvents();
      },
      refused: (err) => {
        const conflict = err instanceof AdminApiError && err.info.status === 409;
        setMessage(
          conflict
            ? { tone: 'warn', text: CONFLICT }
            : {
                tone: 'err',
                text:
                  err instanceof AdminApiError && err.info.status === 422
                    ? describeError(err)
                    : changeUnsure(describeError(err)),
              },
        );
        return !conflict;
      },
      reread: async (quiet) => {
        await readContact(quiet);
        void reloadEvents();
      },
    });
  }

  /** A channel change: the revealed values follow (a removed one goes, an added one joins). */
  function editChannels(change: {
    add?: { kind: 'email' | 'phone'; value: string }[];
    remove?: string[];
    primary?: string[];
  }): Promise<boolean> {
    const before = new Set(channels.map((c) => c.id));
    return write({ channels: change }, true, (answer) => {
      setRevealed((values) => {
        if (!values || !answer.channels) return values;
        const kept = new Map(
          [...values].filter(([channel]) => answer.channels!.some((c) => c.id === channel)),
        );
        const added = answer.channels.filter((c) => !before.has(c.id));
        const typed = change.add?.[0];
        if (typed && added.length === 1 && added[0]) kept.set(added[0].id, typed.value);
        return kept;
      });
    });
  }

  useEffect(() => showFlash(), []);

  // (Admin v2 C8b) The Tasks card, for crm.tasks holders, loaded once the page is up.
  useEffect(() => {
    if (!props.tasks) return;
    import('../tasks/TasksCard')
      .then((module) => setTasksCard(() => module.default))
      .catch(() => undefined);
  }, []);

  // (Admin v2 C16) The Files card, for crm.files holders, loaded once the page is up.
  useEffect(() => {
    if (!props.files) return;
    import('./ContactFilesCard')
      .then((module) => setFilesCard(() => module.default))
      .catch(() => undefined);
  }, []);

  // Revealed details go when the page is left, and stay gone if the browser brings the page
  // back from its back/forward cache: drawn away before the page is frozen (flushSync), so the
  // kept copy holds none (C7 review, C7-PRIV-2).
  useEffect(() => forgetOnLeave(window, () => flushSync(() => setRevealed(null))), []);

  const tags = Array.isArray(contact['tags'])
    ? (contact['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];

  function addTag(event: FormEvent) {
    event.preventDefault();
    const tag = tagDraft.trim();
    if (!tag) return;
    if (tags.includes(tag)) {
      setTagDraft('');
      return;
    }
    if (tags.length >= 10) {
      setMessage({ tone: 'warn', text: 'A contact has up to 10 tags. Remove one first.' });
      return;
    }
    void write({ tags: [...tags, tag] }, true).then((ok) => ok && setTagDraft(''));
  }

  const { score, value } = leadTotals(leads, won);
  const last = typeof contact['last_activity_at'] === 'string' ? contact['last_activity_at'] : '';
  const created = typeof contact['created_at'] === 'string' ? contact['created_at'] : '';
  const keptUntil =
    last && props.retentionMonths !== null ? addMonths(last, props.retentionMonths) : null;
  const owners = people.filter((p) => p.canOwn);
  const ownerId = typeof contact['owner_id'] === 'string' ? contact['owner_id'] : '';
  const name = contactName(contact);

  return (
    <>
      <div className="ct-head">
        <button
          type="button"
          className="lead-star ct-head__star btn--icon"
          data-variant="ghost"
          aria-pressed={contact['is_starred'] === true}
          aria-label={`Star ${name}`}
          disabled={busy}
          onClick={() => void write({ isStarred: contact['is_starred'] !== true }, false)}
        >
          <Icon name="star" size={16} />
        </button>
        <div className="f">
          <label className="f__l" htmlFor={`${id}-stage`}>
            Stage
          </label>
          <select
            id={`${id}-stage`}
            value={String(contact['stage'] ?? 'lead')}
            disabled={busy}
            onChange={(event) => void write({ stage: event.target.value }, true)}
          >
            {CONTACT_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {CONTACT_STAGE_LABELS[stage]}
              </option>
            ))}
          </select>
        </div>
        <div className="f">
          <label className="f__l" htmlFor={`${id}-owner`}>
            Owner
          </label>
          <select
            id={`${id}-owner`}
            value={ownerId}
            disabled={busy}
            onChange={(event) => void write({ ownerId: event.target.value || null }, true)}
          >
            <option value="">No owner</option>
            {owners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {ownerId && !owners.some((p) => p.id === ownerId) && (
              <option value={ownerId}>
                {peopleById.get(ownerId) ?? 'Someone no longer on the team'}
              </option>
            )}
          </select>
        </div>
        <div className="ct-head__tags">
          <ul className="lead-tags" aria-label="Tags">
            {tags.map((tag) => (
              <li key={tag} className="lead-tag">
                <span dir="auto">{tag}</span>
                <button
                  type="button"
                  className="btn--icon"
                  data-variant="ghost"
                  aria-label={`Remove the tag ${tag}`}
                  disabled={busy}
                  onClick={() => void write({ tags: tags.filter((t) => t !== tag) }, true)}
                >
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
          <form className="lead-tag-add" onSubmit={addTag}>
            <label className="visually-hidden" htmlFor={`${id}-tag`}>
              New tag
            </label>
            <input
              id={`${id}-tag`}
              maxLength={32}
              dir="auto"
              autoComplete="off"
              placeholder="New tag"
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
            />
            <button type="submit" data-size="sm" disabled={busy}>
              Add tag
            </button>
          </form>
        </div>
      </div>
      {message && (
        <Note
          tone={message.tone}
          role={message.tone === 'err' ? 'alert' : 'status'}
          className="lead-note"
        >
          <p>{message.text}</p>
        </Note>
      )}
      <div className="grid--2-1 lead-cols">
        <div className="lead-stack">
          <ContactNotes
            contactId={contact.id}
            me={me}
            canDelete={permissions.canErase}
            onChanged={() => {
              // A note is activity (C5): "last activity" and "kept until" follow it.
              void queue.run(() => readContact(true));
              void reloadEvents();
            }}
          />
          <ContactTimeline
            events={events}
            kind={kind}
            onKind={(which) => {
              setKind(which);
              void reloadEvents(which);
            }}
            leadStages={stagesByKey}
            people={peopleById}
            now={now}
            more={next !== null}
            busy={eventsBusy}
            error={eventsError}
            onMore={() => void olderEvents()}
          />
        </div>
        <div className="lead-stack">
          <ContactChannelsCard
            contactId={contact.id}
            channels={channels}
            revealed={revealed}
            onRevealed={setRevealed}
            busy={busy}
            managesChannels={permissions.canErase}
            edit={editChannels}
          />
          <ContactDetailsCard
            contact={contact}
            customFields={props.customFields}
            busy={busy}
            save={(patch: ContactPatch) => write(patch as Record<string, unknown>, true)}
          />
          <ContactCompanyCard
            contact={contact}
            busy={busy}
            change={async (change: CompanyChange) => {
              let removed = false;
              const saved = await write(
                change as Record<string, unknown>,
                true,
                (answer) => {
                  removed = typeof answer.removedCompany === 'string';
                },
                (sent, signal) =>
                  adminFetch<ContactAnswer>(`/api/admin/crm/contacts/${props.contact.id}/company`, {
                    method: 'POST',
                    body: sent,
                    signal,
                  }),
              );
              return saved && removed ? 'removed' : saved;
            }}
          />
          <ContactLeadsCard
            leads={leads}
            more={moreLeads}
            stages={leadStages}
            contactId={contact.id}
            canAddLead={permissions.canAddLead}
            confirmIsReveal={permissions.confirmIsReveal}
            hasChannel={channels.length > 0}
            onNewLead={newLead.open}
            onChecked={(said) => {
              setMessage({ tone: 'ok', text: said });
              void queue.run(() => readContact());
              void reloadEvents();
            }}
          />
          {props.tasks && TasksCard && (
            <TasksCard
              contact={{
                id: contact.id,
                name,
                company:
                  typeof contact['company_name'] === 'string' ? contact['company_name'] : null,
              }}
              owners={props.tasks.owners}
              me={me}
              onChanged={() => {
                // A task ticked off is the contact's activity (C8): "last activity" and "kept
                // until" follow it; a task added or ticked is a line on the timeline.
                void queue.run(() => readContact(true));
                void reloadEvents();
              }}
            />
          )}
          {props.files && FilesCard ? (
            <FilesCard
              contactId={contact.id}
              people={peopleById}
              onChanged={() => {
                // A file added is the contact's activity (C16): "last activity" and "kept until"
                // follow it.
                void queue.run(() => readContact(true));
              }}
            />
          ) : null}
          <section className="card" aria-labelledby={`${id}-score`}>
            <h2 id={`${id}-score`} className="card-title">
              Score
            </h2>
            {score === null ? (
              <p className="f__hint">No score yet: it comes from their leads.</p>
            ) : (
              <>
                <p className="ct-score">
                  <strong>{score}</strong> / 100
                </p>
                <span className="bar lead-score" aria-hidden="true">
                  <span
                    className="bar-fill"
                    data-width={scoreBucket(score)}
                    data-band={scoreBand(score)}
                  />
                </span>
              </>
            )}
            {value > 0 && <p>Won so far: {formatSar(value)}</p>}
            <p className="f__hint">
              The highest score of their leads. Rules live in{' '}
              <a href="/admin/crm/settings">CRM settings</a>.
            </p>
          </section>
          <section className="card" aria-labelledby={`${id}-data`}>
            <h2 id={`${id}-data`} className="card-title">
              Data
            </h2>
            <p className="ct-data">
              {created && (
                <>
                  Added <time dateTime={isoOf(created)}>{formatDate(created)}</time>
                </>
              )}
              {last && (
                <>
                  {' · '}last activity <time dateTime={isoOf(last)}>{relTime(last, now)}</time>
                </>
              )}
              {keptUntil && (
                <>
                  {' · '}kept until <time dateTime={isoOf(keptUntil)}>{formatDate(keptUntil)}</time>{' '}
                  unless there is new activity
                </>
              )}
            </p>
          </section>
          {permissions.canErase && (
            <details className="lead-more">
              <summary>More actions</summary>
              <button type="button" data-variant="danger" onClick={erase.open}>
                Erase everything about them…
              </button>
            </details>
          )}
        </div>
      </div>
      {erase.element}
      {newLead.element}
    </>
  );
}
