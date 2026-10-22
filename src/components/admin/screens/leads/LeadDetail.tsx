import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Badge } from '@/components/admin/kit/StatusBadge';
import Note from '@/components/admin/kit/Note';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { showFlash } from '@/lib/admin/flash';
import { useClock } from '@/components/admin/kit/clock';
import type {
  LeadDetailInitial,
  LeadDetailRow,
  LeadEventRow,
  PersonView,
  StageView,
} from '@/lib/crm/leadPage';
import LeadContactCard, { type Revealed } from './LeadContactCard';
import LeadNotes from './LeadNotes';
import LeadStatusCard from './LeadStatusCard';
import LeadTimeline from './LeadTimeline';
import type { EraseLeadDialogProps } from './EraseLeadDialog';
import { SourceBadge, StageBadge, interestText, text, type LeadsPermissions } from './shared';

// One lead (Admin v2 C4b, crm.md §11 screen 3). The page renders the head (the name as the h1,
// Back, Previous and Next) and this island's first view on the server; the island keeps the
// lead in state and writes it one control at a time (LeadStatusCard), marks it read once
// (decision D4: a PATCH after the page is up, CSRF-checked and stamped by the server, never a
// side effect of reading), reveals the contact details on request (LeadContactCard), and
// reads the notes (LeadNotes) and the older timeline itself.
//
// The server render holds the safe and pipeline columns only: never a contact detail, a
// budget, a note or a score reason. Those arrive in this island, through audited routes, on a
// person's request, and are kept in its state only.

export interface LeadDetailProps extends LeadDetailInitial {
  stages: StageView[];
  people: PersonView[];
  permissions: LeadsPermissions;
  me: { id: string; name: string };
  /** Earlier leads with the same e-mail (the manual add's answer, passed as ids). */
  sameEmail: { id: string; number: number | null }[];
  now: string;
}

const CONFLICT = 'Someone else changed this. Refreshed.';

export default function LeadDetail(props: LeadDetailProps) {
  const { formatDateTime, relTime } = useClock();
  const { stages, people, permissions, me } = props;
  const [lead, setLead] = useState<LeadDetailRow>(props.lead);
  const [events, setEvents] = useState<LeadEventRow[]>(props.events);
  const [before, setBefore] = useState(props.before);
  const [eventsBusy, setEventsBusy] = useState(false);
  const [eventsError, setEventsError] = useState('');
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(
    null,
  );
  const [Erase, setErase] = useState<ComponentType<EraseLeadDialogProps> | null>(null);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [eraseError, setEraseError] = useState('');
  const [now, setNow] = useState(() => Date.parse(props.now));
  const marked = useRef(false);

  const stagesByKey = useMemo(
    () => new Map(stages.map((stage) => [stage.key, { label: stage.label }])),
    [stages],
  );
  const peopleById = useMemo(
    () => new Map(people.map((person) => [person.id, person.name] as const)),
    [people],
  );

  async function refetch() {
    try {
      setLead(await adminFetch<LeadDetailRow>(`/api/admin/leads/${lead.id}`));
    } catch (err) {
      setMessage({ tone: 'err', text: describeError(err) });
    }
  }

  async function reloadEvents() {
    try {
      const answer = await adminFetch<{
        events: LeadEventRow[];
        before: string | null;
        beforeId: number | null;
      }>(`/api/admin/leads/${lead.id}/events`);
      setEvents(answer.events);
      setBefore(
        answer.before && answer.beforeId ? { at: answer.before, id: answer.beforeId } : null,
      );
      setEventsError('');
      setNow(Date.now());
    } catch (err) {
      setEventsError(describeError(err));
    }
  }

  async function olderEvents() {
    if (!before) return;
    setEventsBusy(true);
    try {
      const query = new URLSearchParams({ before: before.at, beforeId: String(before.id) });
      const answer = await adminFetch<{
        events: LeadEventRow[];
        before: string | null;
        beforeId: number | null;
      }>(`/api/admin/leads/${lead.id}/events?${query.toString()}`);
      setEvents((list) => [...list, ...answer.events]);
      setBefore(
        answer.before && answer.beforeId ? { at: answer.before, id: answer.beforeId } : null,
      );
      setEventsError('');
    } catch (err) {
      setEventsError(describeError(err));
    } finally {
      setEventsBusy(false);
    }
  }

  /** One PATCH: the version read with a versioned change; a 409 reads the lead again. */
  async function write(body: Record<string, unknown>, versioned: boolean): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    try {
      const answer = await adminFetch<LeadDetailRow>(`/api/admin/leads/${lead.id}`, {
        method: 'PATCH',
        body: versioned ? { ...body, version: lead.version } : body,
      });
      setLead(answer);
      void reloadEvents();
      return true;
    } catch (err) {
      if (err instanceof AdminApiError && err.info.status === 409) {
        setMessage({ tone: 'warn', text: CONFLICT });
        await refetch();
        void reloadEvents();
      } else {
        setMessage({ tone: 'err', text: describeError(err) });
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  // A confirmation the last page sent here (a lead added by hand): shown once, then taken
  // out of the address.
  useEffect(() => showFlash(), []);

  // Opening an unread lead marks it read, once (decision D4).
  useEffect(() => {
    if (marked.current || lead.read_at !== null) return;
    marked.current = true;
    adminFetch<LeadDetailRow>(`/api/admin/leads/${lead.id}`, {
      method: 'PATCH',
      body: { read: true },
    })
      .then(setLead)
      .catch(() => undefined);
  }, []);

  function openErase() {
    setEraseError('');
    import('./EraseLeadDialog')
      .then((module) => {
        setErase(() => module.default);
        setEraseOpen(true);
      })
      .catch(() => setEraseError('The erase dialog could not be loaded. Reload and try again.'));
  }

  const locale = lead.locale === 'ar' ? 'ar' : 'en';
  const at = text(lead.created_at);
  const consent =
    lead.source === 'web_form' ? (lead.consent_marketing === true ? 'Yes' : 'No') : 'Added by hand';
  const details: [string, ReactNode][] = [
    ['Company', text(lead.company) ? <span dir="auto">{text(lead.company)}</span> : 'Not given'],
    [
      'Interest',
      props.serviceHref ? <a href={props.serviceHref}>{interestText(lead)}</a> : interestText(lead),
    ],
    ['Language', locale === 'ar' ? 'Arabic' : 'English'],
    ['Received', formatDateTime(at)],
    ['Agreed to be contacted about this inquiry', consent],
    ['Lead number', typeof lead.lead_number === 'number' ? `#${lead.lead_number}` : 'Not given'],
  ];

  return (
    <>
      <div className="lead-badges">
        <StageBadge stages={stages} id={lead.stage_id} />
        <SourceBadge source={lead.source} channel={lead.channel} />
        {lead.is_starred === true && <Badge tone="warn">Starred</Badge>}
        {lead.is_spam === true && <Badge tone="err">Spam</Badge>}
      </div>
      {props.sameEmail.length > 0 && (
        <Note tone="info" className="lead-note">
          <p>
            This e-mail wrote before:{' '}
            {props.sameEmail.map((earlier, i) => (
              <span key={earlier.id}>
                {i > 0 && ', '}
                <a href={`/admin/leads/${earlier.id}`}>
                  {earlier.number === null ? 'an earlier lead' : `#${earlier.number}`}
                </a>
              </span>
            ))}
          </p>
        </Note>
      )}
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
          <section className="card" aria-labelledby="lead-message-h">
            <div className="card__h">
              <div>
                <h2 id="lead-message-h" className="card__t">
                  Message
                </h2>
                <p className="card__sub">
                  Sent {relTime(at, now)} in {locale === 'ar' ? 'Arabic' : 'English'}
                </p>
              </div>
            </div>
            <blockquote className="lead-quote" dir="auto" lang={locale}>
              {text(lead.message) || 'No message.'}
            </blockquote>
          </section>
          <section className="card" aria-labelledby="lead-details-h">
            <h2 id="lead-details-h" className="card-title">
              Details
            </h2>
            <dl className="stat-rows">
              {details.map(([label, value]) => (
                <div className="stat-row" key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          {permissions.canSeePii && (
            <LeadContactCard
              leadId={lead.id}
              revealed={revealed}
              onRevealed={setRevealed}
              onLogged={() => {
                void refetch();
                void reloadEvents();
              }}
            />
          )}
        </div>
        <div className="lead-stack">
          <LeadStatusCard
            lead={lead}
            stages={stages}
            people={people}
            reasons={revealed?.score_reasons ?? null}
            canSeePii={permissions.canSeePii}
            busy={busy}
            write={write}
            onMoved={(stage) =>
              void write({ stageId: stage.id }, true).then((ok) => {
                if (ok) setMessage({ tone: 'ok', text: `Moved to ${stage.label}.` });
              })
            }
          />
          {permissions.canSeePii && (
            <LeadNotes
              leadId={lead.id}
              me={me}
              canDelete={permissions.canErase}
              onChanged={() => void reloadEvents()}
            />
          )}
          <LeadTimeline
            events={events}
            stages={stagesByKey}
            people={peopleById}
            now={now}
            more={before !== null}
            busy={eventsBusy}
            error={eventsError}
            onMore={() => void olderEvents()}
          />
          {permissions.canErase && (
            <details className="lead-more">
              <summary>More actions</summary>
              <button type="button" data-variant="danger" onClick={openErase}>
                Erase this lead…
              </button>
              {eraseError && (
                <p className="msg" data-kind="error" role="alert">
                  {eraseError}
                </p>
              )}
            </details>
          )}
        </div>
      </div>
      {Erase && <Erase leadId={lead.id} open={eraseOpen} onClose={() => setEraseOpen(false)} />}
    </>
  );
}
