import { useCallback, useRef } from 'react';
import type { AccountView } from '@/lib/admin/account';
import AccountPanel from './AccountPanel';
import ChromeDrawer, { useOpenOn } from './ChromeDrawer';

// The account drawer (Admin v2 F8, docs/admin-v2/ui.md §2.9): opened from the sidebar's
// account chip, which is a link to /admin/account without JS. Its content is the same
// AccountPanel the page renders, sending each form with fetch.

export interface AccountDrawerProps {
  view: AccountView;
}

export default function AccountDrawer({ view }: AccountDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  useOpenOn('account', open);

  return (
    <ChromeDrawer dialogRef={dialogRef} titleId="acct-drw-title" title="Your account">
      <AccountPanel view={view} idPrefix="acct-drw" mode="drawer" />
    </ChromeDrawer>
  );
}
