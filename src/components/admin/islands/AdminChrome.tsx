import { useEffect } from 'react';
import type { PaletteGroup } from '@/lib/admin/palette';
import CommandPalette from '@/components/admin/screens/chrome/CommandPalette';

// The shell's one interactive island (Admin v2 F3), hydrated on every admin page: the
// command palette now, the notifications drawer and the account drawer later (F8).
// Everything else in the shell is server-rendered and works without it.

export interface AdminChromeProps {
  palette: PaletteGroup[];
}

export default function AdminChrome({ palette }: AdminChromeProps) {
  // The topbar's shortcut hint is rendered for Windows and Linux; a Mac reads ⌘ instead.
  // A text change after hydration: nothing is styled, so nothing touches style-src.
  useEffect(() => {
    const mac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
    if (!mac) return;
    for (const hint of document.querySelectorAll<HTMLElement>('[data-kbd-hint]')) {
      hint.textContent = '⌘K';
    }
  }, []);

  return <CommandPalette groups={palette} />;
}
