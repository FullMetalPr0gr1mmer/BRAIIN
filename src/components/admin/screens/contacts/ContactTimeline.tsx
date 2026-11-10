import { useId } from 'react';
import Chips from '@/components/admin/kit/Chips';
import { useClock } from '@/components/admin/kit/clock';
import { isoOf } from '@/lib/admin/relTime';
import { actorName, type PeopleById, type StagesByKey } from '@/lib/crm/leadView';
import { contactEventSentence, type ContactEvent } from '@/lib/crm/contactView';
import type { ContactTimelineQuery } from '@schemas/crm';

// A contact's timeline (Admin v2 C7, crm.md §11 screen 6): the contact's own events and those of
// its leads (linked other than by phone alone), newest first, one sentence each, who did it and
// when, in the kit's timeline markup (ui/Timeline.astro's .tl). Metadata only: a note shows as
// "Note added", never its words (those are the notes card's, behind the audited door).
// The chips narrow it (All, Leads, Notes, Changes; Messages and Campaigns are LATER, and Tasks
// arrive with C8); "Load older" reads the page before the last one.

export type TimelineKind = NonNullable<ContactTimelineQuery['kind']>;

const KINDS: readonly { value: TimelineKind; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'leads', label: 'Leads' },
  { value: 'notes', label: 'Notes' },
  { value: 'changes', label: 'Changes' },
];

interface Props {
  events: readonly ContactEvent[];
  kind: TimelineKind;
  onKind: (kind: TimelineKind) => void;
  leadStages: StagesByKey;
  people: PeopleById;
  now: number;
  more: boolean;
  busy: boolean;
  error: string;
  onMore: () => void;
}

export default function ContactTimeline(props: Props) {
  const { formatDateTime, relTime } = useClock();
  const id = useId();
  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="card-title">
        Timeline
      </h2>
      <Chips
        label="Show"
        chips={KINDS}
        selected={[props.kind]}
        onChange={([value]) => props.onKind(value ?? 'all')}
      />
      {props.events.length === 0 ? (
        <p className="f__hint">Nothing here yet.</p>
      ) : (
        <ol className="tl" aria-label="What happened, newest first">
          {props.events.map((event) => (
            <li key={`${event.src}-${event.id}`} className="tl__i" data-kind={event.kind}>
              <p className="tl__t">
                {event.src === 'lead' && event.lead_id ? (
                  <a href={`/admin/leads/${event.lead_id}`}>
                    {contactEventSentence(event, props.leadStages, props.people)}
                  </a>
                ) : (
                  contactEventSentence(event, props.leadStages, props.people)
                )}
              </p>
              <p className="tl__s" dir="auto">
                {actorName(event.actor_id, props.people)}
              </p>
              <time className="tl__m" dateTime={isoOf(event.at)} title={formatDateTime(event.at)}>
                {relTime(event.at, props.now)}
              </time>
            </li>
          ))}
        </ol>
      )}
      {props.error && (
        <p className="msg" data-kind="error" role="alert">
          {props.error}
        </p>
      )}
      {props.more && (
        <button type="button" data-size="sm" disabled={props.busy} onClick={props.onMore}>
          Load older
        </button>
      )}
    </section>
  );
}
