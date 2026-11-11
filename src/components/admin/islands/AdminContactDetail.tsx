// Island entry for one contact (/admin/contacts/[id]) (Admin v2 C7). The page hydrates this
// entry; the screen's code is in screens/contacts/, in the admin-contacts chunk group
// (astro.config.mjs), and its dialogs in admin-contacts-lazy, loaded on first use.
import ContactDetail, {
  type ContactDetailProps,
} from '@/components/admin/screens/contacts/ContactDetail';
import { ClockProvider } from '@/components/admin/kit/clock';

export default function AdminContactDetail({
  tz,
  ...props
}: ContactDetailProps & { tz?: string | undefined }) {
  return (
    <ClockProvider tz={tz}>
      <ContactDetail {...props} />
    </ClockProvider>
  );
}
