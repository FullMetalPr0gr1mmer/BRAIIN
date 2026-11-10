import { useMemo, useRef, useState, type ComponentType } from 'react';
import EmptyState from '@/components/admin/kit/EmptyState';
import Note from '@/components/admin/kit/Note';
import Segmented from '@/components/admin/kit/Segmented';
import Icon from '@/components/admin/kit/Icon';
import type { TaskView } from '@schemas/crmTasks';
import TaskItem from './TaskItem';
import type { TaskDrawerProps } from './TaskDrawer';
import {
  failureText,
  isConflict,
  readTasks,
  removeTask,
  setDone,
  snooze,
  type TaskGroups,
  type TaskPerson,
  type TaskRow,
} from './shared';

// The Tasks screen (Admin v2 C8, crm.md §11 screen 10). The page renders the first view on the
// server (the groups as public.crm_tasks_grouped worked them out in the studio's zone) and this
// island takes over: My tasks | Everyone (the page falls back to Everyone when I have none),
// New task, and four lists: Overdue, Today, Upcoming and Done (the last 20, collapsed). Every
// change is one write applied at once (P-3: CRM data is never staged), then the lists are read
// again, so a task moves to its list as the server says. The view lives in the address; nothing
// else does.

export interface TasksScreenProps {
  initial: TaskGroups;
  view: TaskView;
  owners: TaskPerson[];
  me: TaskPerson;
}

type Message = { tone: 'ok' | 'warn' | 'err'; text: string };

const SECTIONS: readonly {
  key: 'overdue' | 'dueToday' | 'upcoming';
  title: string;
  count: 'overdue' | 'today' | 'upcoming';
  empty: string;
}[] = [
  { key: 'overdue', title: 'Overdue', count: 'overdue', empty: 'Nothing overdue. Nice.' },
  { key: 'dueToday', title: 'Today', count: 'today', empty: 'Nothing due today.' },
  { key: 'upcoming', title: 'Upcoming', count: 'upcoming', empty: 'Nothing coming up.' },
];

export default function TasksScreen({ initial, view: initialView, owners, me }: TasksScreenProps) {
  const [groups, setGroups] = useState<TaskGroups>(initial);
  const [view, setView] = useState<TaskView>(initialView);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [now, setNow] = useState(() => Date.parse(initial.now) || Date.now());
  const [Drawer, setDrawer] = useState<ComponentType<TaskDrawerProps> | null>(null);
  const [editing, setEditing] = useState<{ task: TaskRow | null; key: number } | null>(null);
  const reads = useRef(0);
  const ownerNames = useMemo(() => new Map(owners.map((p) => [p.id, p.name] as const)), [owners]);

  /** Reads the lists again; an older read never replaces a newer one. */
  async function reload(next: TaskView = view): Promise<void> {
    const mine = ++reads.current;
    try {
      const answer = await readTasks({ view: next });
      if (mine !== reads.current) return;
      setGroups(answer);
      setNow(Date.parse(answer.now) || Date.now());
    } catch (err) {
      if (mine === reads.current) setMessage({ tone: 'err', text: failureText(err) });
    }
  }

  function changeView(next: TaskView) {
    setView(next);
    setMessage(null);
    const url = new URL(window.location.href);
    url.searchParams.set('view', next);
    window.history.replaceState(null, '', url);
    void reload(next);
  }

  /** One write, then the lists again; a 409 says so and reads them anyway. */
  async function act(write: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await write();
      if (done) setMessage({ tone: 'ok', text: done });
    } catch (err) {
      setMessage({ tone: isConflict(err) ? 'warn' : 'err', text: failureText(err) });
    } finally {
      await reload();
      setBusy(false);
    }
  }

  function openDrawer(task: TaskRow | null) {
    const show = () => setEditing({ task, key: Date.now() });
    if (Drawer) return show();
    import('./TaskDrawer')
      .then((module) => {
        setDrawer(() => module.default);
        show();
      })
      .catch(() =>
        setMessage({ tone: 'err', text: 'The task form could not be loaded. Reload and try again.' }),
      );
  }

  const open = groups.counts.overdue + groups.counts.today + groups.counts.upcoming;
  const nothing = open === 0 && groups.done.length === 0;
  const item = (task: TaskRow) => (
    <TaskItem
      key={task.id}
      task={task}
      now={now}
      owners={ownerNames}
      busy={busy}
      showOwner={view === 'all'}
      onDone={(t, done) => void act(() => setDone(t, done), done ? 'Task done.' : 'Task opened again.')}
      onEdit={(t) => openDrawer(t)}
      onSnooze={(t) => void act(() => snooze(t), 'Snoozed to tomorrow 10:00.')}
      onDelete={(t) =>
        void act(async () => {
          if (await removeTask(t)) setMessage({ tone: 'ok', text: 'Task deleted.' });
        })
      }
    />
  );

  return (
    <div className="tasks">
      <div className="tasks__bar">
        <Segmented<TaskView>
          label="Whose tasks"
          options={[
            { value: 'mine', label: 'My tasks' },
            { value: 'all', label: 'Everyone' },
          ]}
          value={view}
          onChange={changeView}
        />
        <button type="button" data-variant="primary" onClick={() => openDrawer(null)}>
          <Icon name="plus" size={16} />
          New task
        </button>
      </div>
      <p className="tasks__summary" role="status">
        {groups.counts.overdue} overdue · {groups.counts.today} today · {groups.counts.upcoming}{' '}
        upcoming, {view === 'mine' ? 'for you' : 'for everyone'}
      </p>
      {message && (
        <Note tone={message.tone} role={message.tone === 'err' ? 'alert' : 'status'}>
          <p>{message.text}</p>
        </Note>
      )}
      {nothing ? (
        <EmptyState
          icon="check"
          title="No tasks"
          text="Add one from a contact, a lead or the button above."
        />
      ) : (
        <>
          {SECTIONS.map((section) => {
            const list = groups[section.key];
            const total = groups.counts[section.count];
            return (
              <section
                key={section.key}
                className="card tasks__sec"
                data-sec={section.key}
                aria-labelledby={`tasks-${section.key}-h`}
              >
                <h2 id={`tasks-${section.key}-h`} className="card__t">
                  {section.title} <span className="tasks__n">{total}</span>
                </h2>
                {list.length === 0 ? (
                  <p className="f__hint">{section.empty}</p>
                ) : (
                  <ul className="task-list">{list.map(item)}</ul>
                )}
                {total > list.length && (
                  <p className="f__hint">
                    Showing the first {list.length} of {total}.
                  </p>
                )}
              </section>
            );
          })}
          <details className="card tasks__sec" data-sec="done">
            <summary className="card__t">
              Done <span className="tasks__n">{groups.done.length}</span>
            </summary>
            {groups.done.length === 0 ? (
              <p className="f__hint">Nothing done yet.</p>
            ) : (
              <ul className="task-list">{groups.done.map(item)}</ul>
            )}
            <p className="f__hint">The last 20 done in the past 30 days.</p>
          </details>
        </>
      )}
      {Drawer && editing && (
        <Drawer
          key={editing.key}
          open
          onClose={() => setEditing(null)}
          onSaved={(task) => {
            if (task && !editing.task) setMessage({ tone: 'ok', text: 'Task added.' });
            void reload();
          }}
          task={editing.task}
          today={groups.today}
          owners={owners}
          me={me}
        />
      )}
    </div>
  );
}
