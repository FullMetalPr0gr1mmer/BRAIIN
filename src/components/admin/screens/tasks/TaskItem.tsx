import { useId } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { Badge } from '@/components/admin/kit/StatusBadge';
import { useClock } from '@/components/admin/kit/clock';
import { isoOf } from '@/lib/admin/relTime';
import {
  FORMER_MEMBER,
  TYPE_ICONS,
  TYPE_LABELS,
  contactHref,
  icsHref,
  leadHref,
  leadLabel,
  type TaskPerson,
  type TaskRow,
} from './shared';

// One task (Admin v2 C8, crm.md §11 screen 10): a done box, the type (an icon and its word),
// the title in its own direction, whom it is about (the contact and the lead, as links), when
// it is due (the date and time in the studio's zone and how far off; an overdue task says
// "Overdue" in words, never by colour alone), the note, and its actions. The row's id is the
// anchor a calendar file links back to (`#task-<id>`).

export interface TaskItemProps {
  task: TaskRow;
  now: number;
  owners: ReadonlyMap<string, string>;
  busy: boolean;
  /** Shown on the Tasks screen; a lead's card leaves out whom it is about (it is that lead). */
  showLinks?: boolean;
  onDone: (task: TaskRow, done: boolean) => void;
  onEdit: (task: TaskRow) => void;
  onSnooze?: ((task: TaskRow) => void) | undefined;
  onDelete?: ((task: TaskRow) => void) | undefined;
  /** Who owns it, when the list shows everyone's. */
  showOwner?: boolean;
}

export default function TaskItem({
  task,
  now,
  owners,
  busy,
  showLinks = true,
  onDone,
  onEdit,
  onSnooze,
  onDelete,
  showOwner = false,
}: TaskItemProps) {
  const { formatDate, formatTime, relTime } = useClock();
  const titleId = useId();
  const done = task.done_at !== null;
  const overdue = !done && Date.parse(task.due_at) < now;
  const owner = task.owner_id ? (owners.get(task.owner_id) ?? FORMER_MEMBER) : 'Nobody';
  return (
    <li id={`task-${task.id}`} className="task" data-done={done ? '' : undefined}>
      <input
        type="checkbox"
        className="task__check"
        checked={done}
        disabled={busy}
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-state`}
        onChange={(event) => onDone(task, event.target.checked)}
      />
      <span className="visually-hidden" id={`${titleId}-state`}>
        {done ? 'Done. Untick to open it again.' : 'Tick when done.'}
      </span>
      <span className="task__type">
        <Icon name={TYPE_ICONS[task.type]} size={16} />
        <span className="visually-hidden">{TYPE_LABELS[task.type]}:</span>
      </span>
      <div className="task__main">
        <p className="task__t" id={titleId} dir="auto">
          {task.title}
        </p>
        <p className="task__m">
          {showLinks && task.contact_id && (
            <a href={contactHref(task.contact_id)}>
              <span dir="auto">{task.contact_name ?? 'A contact'}</span>
              {task.contact_company && (
                <>
                  , <span dir="auto">{task.contact_company}</span>
                </>
              )}
            </a>
          )}
          {showLinks && task.lead_id && (
            <a href={leadHref(task.lead_id)}>
              {leadLabel(task)}
              {task.lead_name && (
                <>
                  , <span dir="auto">{task.lead_name}</span>
                </>
              )}
            </a>
          )}
          <time dateTime={isoOf(task.due_at)}>
            {formatDate(task.due_at)}, {formatTime(task.due_at)}
          </time>
          {done ? (
            <span>Done {relTime(task.done_at ?? task.due_at, now)}</span>
          ) : overdue ? (
            <Badge tone="err">Overdue</Badge>
          ) : (
            <span>{relTime(task.due_at, now)}</span>
          )}
          {showOwner && <span dir="auto">{owner}</span>}
        </p>
        {task.note && (
          <p className="task__n" dir="auto">
            {task.note}
          </p>
        )}
      </div>
      <div className="task__a">
        <button type="button" data-size="sm" disabled={busy} onClick={() => onEdit(task)}>
          Edit<span className="visually-hidden"> this task</span>
        </button>
        {!done && onSnooze && (
          <button type="button" data-size="sm" disabled={busy} onClick={() => onSnooze(task)}>
            Snooze to tomorrow 10:00
          </button>
        )}
        <a className="btn" data-size="sm" href={icsHref(task.id)} download>
          <Icon name="cal" size={14} />
          .ics<span className="visually-hidden"> calendar file for this task</span>
        </a>
        {onDelete && (
          <button
            type="button"
            data-size="sm"
            data-variant="ghost"
            disabled={busy}
            onClick={() => onDelete(task)}
          >
            Delete<span className="visually-hidden"> this task</span>
          </button>
        )}
      </div>
    </li>
  );
}
