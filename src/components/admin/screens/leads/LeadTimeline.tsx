import { useId } from 'react';
import { isoOf } from '@/lib/admin/relTime';
import { useClock } from '@/components/admin/kit/clock';
import type { LeadEventRow } from '@/lib/crm/leadPage';
import { actorName, eventSentence, type PeopleById, type StagesByKey } from '@/lib/crm/leadView';

// A lead's timeline (Admin v2 C4b): the kit's timeline markup (ui/Timeline.astro's .tl), one
// sentence per event (src/lib/crm/leadView.ts eventSentence: "Moved from New to Contacted",
// "Call logged"), who did it, and when. Metadata only: lead_events never holds a note's
// words or a contact detail. Newest first; "Load older" reads the page before the last one.

interface Props {
  events: readonly LeadEventRow[];
  stages: StagesByKey;
  people: PeopleById;
  now: number;
  more: boolean;
  busy: boolean;
  error: string;
  onMore: () => void;
}

export default function LeadTimeline({
  events,
  stages,
  people,
  now,
  more,
  busy,
  error,
  onMore,
}: Props) {
  const { formatDateTime, relTime } = useClock();
  const id = useId();
  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="card-title">
        Timeline
      </h2>
      {events.length === 0 ? (
        <p className="f__hint">Nothing has happened to this lead yet.</p>
      ) : (
        <ol className="tl" aria-label="What happened, newest first">
          {events.map((event) => (
            <li key={event.id} className="tl__i" data-kind={event.kind}>
              <p className="tl__t">{eventSentence(event, stages, people)}</p>
              <p className="tl__s" dir="auto">
                {actorName(event.actor_id, people)}
              </p>
              <time className="tl__m" dateTime={isoOf(event.at)} title={formatDateTime(event.at)}>
                {relTime(event.at, now)}
              </time>
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {more && (
        <button type="button" data-size="sm" disabled={busy} onClick={onMore}>
          Load older
        </button>
      )}
    </section>
  );
}
