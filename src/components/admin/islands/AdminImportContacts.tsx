// Island entry for Import contacts (/admin/contacts/import) (Admin v2 C15). The page hydrates
// this entry; the screen's code is in screens/contacts-import/, in its own chunk group
// (admin-import, astro.config.mjs), so no other admin screen loads it. The page passes the
// studio's time zone (`tz`) for the recent imports' dates (src/components/admin/kit/clock.tsx).
import ImportContacts, {
  type ImportContactsProps,
} from '@/components/admin/screens/contacts-import/ImportContacts';
import { ClockProvider } from '@/components/admin/kit/clock';

export default function AdminImportContacts({
  tz,
  ...props
}: ImportContactsProps & { tz?: string | undefined }) {
  return (
    <ClockProvider tz={tz}>
      <ImportContacts {...props} />
    </ClockProvider>
  );
}
