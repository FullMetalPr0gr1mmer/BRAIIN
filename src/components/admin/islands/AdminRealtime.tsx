// Island entry for the website stats' Realtime tab (Admin v2 G1b): the figures rendered on
// the server, then asked for again once a minute while the tab is visible, with Pause, and
// stopping by itself after 30 minutes. The code is in screens/realtime/.
// Admin v2 U9: the page passes the studio's time zone (`tz`), so the minutes in the server HTML
// and in the hydrated render are the same clock's (src/components/admin/kit/clock.tsx).
import Realtime, { type RealtimeProps } from '@/components/admin/screens/realtime/Realtime';
import { ClockProvider } from '@/components/admin/kit/clock';

export default function AdminRealtime({ tz, ...props }: RealtimeProps & { tz?: string | undefined }) {
  return (
    <ClockProvider tz={tz}>
      <Realtime {...props} />
    </ClockProvider>
  );
}
