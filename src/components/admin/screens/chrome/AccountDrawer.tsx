import { useCallback, useRef, useState } from 'react';
import type { AccountView } from '@/lib/admin/account';
import AccountPanel from './AccountPanel';
import ChromeDrawer, { useOpenOn } from './ChromeDrawer';

// The account drawer (Admin v2 F8, docs/admin-v2/ui.md §2.9): opened from the sidebar's
// account chip, which is a link to /admin/account without JS. Its content is the same
// AccountPanel the page renders, sending each form with fetch.
//
// The panel (three forms and a line per capability) is rendered the first time the drawer
// opens, not on every admin page: the chrome island is server-rendered on every render,
// under the Workers Free plan's 10 ms of CPU, and a closed dialog needs no content. Once
// opened it stays mounted, so what was typed or saved there survives closing it.

export interface AccountDrawerProps {
  view: AccountView;
}

export default function AccountDrawer({ view }: AccountDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [opened, setOpened] = useState(false);
  const open = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    setOpened(true);
    dialog.showModal();
  }, []);
  const openerRef = useOpenOn('account', open);

  return (
    <ChromeDrawer
      dialogRef={dialogRef}
      openerRef={openerRef}
      titleId="acct-drw-title"
      title="Your account"
    >
      {opened && <AccountPanel view={view} idPrefix="acct-drw" mode="drawer" />}
    </ChromeDrawer>
  );
}
