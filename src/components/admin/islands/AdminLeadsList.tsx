// Island entry for the leads list (/admin/leads) (Admin v2 C4b). The page hydrates this entry;
// the screen's code is in screens/leads/, in the admin-leads chunk group (astro.config.mjs).
// Admin v2 U9: the page passes the studio's time zone (`tz`), which the screen's server HTML
// and its hydrated render both print dates in (src/components/admin/kit/clock.tsx).
import LeadsList, { type LeadsListProps } from '@/components/admin/screens/leads/LeadsList';
import { ClockProvider } from '@/components/admin/kit/clock';

export default function AdminLeadsList({ tz, ...props }: LeadsListProps & { tz?: string | undefined }) {
  return (
    <ClockProvider tz={tz}>
      <LeadsList {...props} />
    </ClockProvider>
  );
}
