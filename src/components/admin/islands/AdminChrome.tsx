import { useEffect } from 'react';
import type { AccountView } from '@/lib/admin/account';
import type { PaletteGroup } from '@/lib/admin/palette';
import AccountDrawer from '@/components/admin/screens/chrome/AccountDrawer';
import CommandPalette from '@/components/admin/screens/chrome/CommandPalette';
import HelpDrawer from '@/components/admin/screens/help/HelpDrawer';
import NotificationsDrawer from '@/components/admin/screens/chrome/NotificationsDrawer';

// The shell's one interactive island, hydrated on every admin page: the command palette
// (F3), the notifications drawer and the account drawer (F8), and the help centre (U16).
// Everything else in the shell is server-rendered and works without it: the search
// trigger, the help "?", the bell and the account chip are links to pages that do the
// same job.

export interface AdminChromeProps {
  palette: PaletteGroup[];
  account: AccountView;
}

export default function AdminChrome({ palette, account }: AdminChromeProps) {
  // The topbar's shortcut hint is rendered for Windows and Linux; a Mac reads ⌘ instead.
  // A text change after hydration: nothing is styled, so nothing touches style-src.
  useEffect(() => {
    const mac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
    if (!mac) return;
    for (const hint of document.querySelectorAll<HTMLElement>('[data-kbd-hint]')) {
      hint.textContent = '⌘K';
    }
  }, []);

  return (
    <>
      <CommandPalette groups={palette} />
      <HelpDrawer />
      <NotificationsDrawer />
      <AccountDrawer view={account} />
    </>
  );
}
