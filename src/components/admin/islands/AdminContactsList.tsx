// Island entry for the People list (/admin/contacts) (Admin v2 C7). The page hydrates this
// entry; the screen's code is in screens/contacts/, in the admin-contacts chunk group
// (astro.config.mjs). The page passes the studio's time zone (`tz`), which the server HTML and
// the hydrated render both print dates in (src/components/admin/kit/clock.tsx).
import ContactsList, {
  type ContactsListProps,
} from '@/components/admin/screens/contacts/ContactsList';
import { ClockProvider } from '@/components/admin/kit/clock';

export default function AdminContactsList({
  tz,
  ...props
}: ContactsListProps & { tz?: string | undefined }) {
  return (
    <ClockProvider tz={tz}>
      <ContactsList {...props} />
    </ClockProvider>
  );
}
