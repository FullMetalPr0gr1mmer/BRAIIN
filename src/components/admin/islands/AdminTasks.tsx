// Island entry for the Tasks screen (/admin/tasks) (Admin v2 C8). The page hydrates this entry;
// the screen's code is in screens/tasks/, in the admin-tasks chunk group (astro.config.mjs).
// The page passes the studio's time zone (`tz`), which the screen's server HTML and its
// hydrated render both print dates in (src/components/admin/kit/clock.tsx).
import TasksScreen, { type TasksScreenProps } from '@/components/admin/screens/tasks/TasksScreen';
import { ClockProvider } from '@/components/admin/kit/clock';

export default function AdminTasks({
  tz,
  ...props
}: TasksScreenProps & { tz?: string | undefined }) {
  return (
    <ClockProvider tz={tz}>
      <TasksScreen {...props} />
    </ClockProvider>
  );
}
