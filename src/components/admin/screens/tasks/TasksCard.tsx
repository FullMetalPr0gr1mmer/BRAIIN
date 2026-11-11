import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from 'react';
import Icon from '@/components/admin/kit/Icon';
import type { TaskDrawerProps } from './TaskDrawer';
import TaskItem from './TaskItem';
import {
  failureText,
  openTasks,
  readTasks,
  setDone,
  type TaskContactRef,
  type TaskGroups,
  type TaskLeadRef,
  type TaskPerson,
  type TaskRow,
} from './shared';

// The Tasks card on a lead's page (Admin v2 C8, crm.md §11 screen 3) and, from C7, on a
// contact's: the open tasks about this lead or contact (overdue first), each with its done box
// and Edit, and "Add a task", which opens the task drawer with the lead or contact already
// chosen. Loaded with import() by the page's island once it is up (`crm.tasks` holders only:
// a UX hint; the routes refuse anyone else), so the lead page's first load does not carry it.
// It reads its tasks itself (GET /api/admin/crm/tasks?lead= or ?contact=) and again after
// every change.

export interface TasksCardProps {
  lead?: TaskLeadRef | null | undefined;
  contact?: TaskContactRef | null | undefined;
  owners: TaskPerson[];
  me: TaskPerson;
  /** After a task is added, ticked or changed: the page may read its timeline again. */
  onChanged?: (() => void) | undefined;
}

export default function TasksCard({ lead, contact, owners, me, onChanged }: TasksCardProps) {
  const id = useId();
  const [groups, setGroups] = useState<TaskGroups | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [Drawer, setDrawer] = useState<ComponentType<TaskDrawerProps> | null>(null);
  const [editing, setEditing] = useState<{ task: TaskRow | null; key: number } | null>(null);
  const reads = useRef(0);
  const ownerNames = useMemo(() => new Map(owners.map((p) => [p.id, p.name] as const)), [owners]);
  const filter = lead ? { lead: lead.id } : contact ? { contact: contact.id } : null;

  async function reload(): Promise<void> {
    if (!filter) return;
    const mine = ++reads.current;
    try {
      const answer = await readTasks(filter);
      if (mine !== reads.current) return;
      setGroups(answer);
      setError('');
    } catch (err) {
      if (mine === reads.current) setError(failureText(err));
    }
  }

  useEffect(() => {
    void reload();
  }, [lead?.id, contact?.id]);

  function openDrawer(task: TaskRow | null) {
    const show = () => setEditing({ task, key: Date.now() });
    if (Drawer) return show();
    import('./TaskDrawer')
      .then((module) => {
        setDrawer(() => module.default);
        show();
      })
      .catch(() => setError('The task form could not be loaded. Reload and try again.'));
  }

  async function tick(task: TaskRow, done: boolean) {
    setBusy(true);
    setError('');
    try {
      await setDone(task, done);
      onChanged?.();
    } catch (err) {
      setError(failureText(err));
    } finally {
      await reload();
      setBusy(false);
    }
  }

  const list = groups ? openTasks(groups) : [];
  const now = groups ? Date.parse(groups.now) || Date.now() : Date.now();
  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <div className="card__h">
        <div>
          <h2 id={`${id}-h`} className="card__t">
            Tasks
          </h2>
          <p className="card__sub">Follow-ups for {lead ? 'this lead' : 'this person'}.</p>
        </div>
        {/* Not before the first read: it brings the studio's today, the new task's due date. */}
        <button
          type="button"
          data-size="sm"
          disabled={groups === null}
          onClick={() => openDrawer(null)}
        >
          <Icon name="plus" size={14} />
          Add a task
        </button>
      </div>
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {groups === null && !error ? (
        <p className="f__hint">Loading the tasks…</p>
      ) : groups && list.length === 0 ? (
        <p className="f__hint">No open tasks.</p>
      ) : (
        <ul className="task-list" data-compact="">
          {list.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              now={now}
              owners={ownerNames}
              busy={busy}
              showLinks={false}
              onDone={(t, done) => void tick(t, done)}
              onEdit={(t) => openDrawer(t)}
            />
          ))}
        </ul>
      )}
      {groups && (
        <p className="f__hint">
          <a href="/admin/tasks">All tasks</a>
        </p>
      )}
      {Drawer && editing && (
        <Drawer
          key={editing.key}
          open
          onClose={() => setEditing(null)}
          onSaved={() => {
            onChanged?.();
            void reload();
          }}
          task={editing.task}
          today={groups?.today ?? ''}
          owners={owners}
          me={me}
          lead={lead ?? null}
          contact={contact ?? null}
        />
      )}
    </section>
  );
}
