import { defineAdminRoute } from '@/lib/admin/route';
import { requireContactId } from '@/lib/crm/contacts';
import { revealContact } from '@/lib/crm/contactReveal';

// "Show contact details" for one contact (Admin v2 C6, crm.md §9): `crm.contacts`. A POST,
// because it has an effect: it spends a slot of the reveal limiter the lead reveal shares and
// writes an audit row before anything is decrypted (src/lib/crm/contactReveal.ts has the
// order and the reasons). Answers the contact's e-mails and phones, each with its id, kind,
// whether it is the primary, and where it came from.

export const prerender = false;

export const POST = defineAdminRoute({
  cap: 'crm.contacts',
  handler: async ({ auth, sb, params }) => {
    const id = requireContactId(params);
    return { channels: await revealContact(auth, sb, id) };
  },
});
