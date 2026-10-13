import { describe, expect, it } from 'vitest';
import { focusReturnTarget, isRendered } from '@/lib/admin/focusReturn';

// Where focus goes when a shell drawer closes (Admin v2 F8, WCAG 2.4.3 / 2.4.11). The shell
// is modelled as a tree whose boxes render or not, as `display: none` does: a closed
// popover or dialog hides everything inside it. personal.e2e.ts drives the real thing at
// 390px; this pins the decision for every state the browser can leave focus in.

interface Box {
  name: string;
  parent: Box | null;
  rendered: boolean;
}

function box(name: string, parent: Box | null, rendered = true): Box {
  return { name, parent, rendered };
}

/** The admin shell: the topbar (Menu button, bell), the sidebar (account chip), a drawer. */
function shell({ wide, sideOpen = false }: { wide: boolean; sideOpen?: boolean }) {
  const body = box('body', null);
  const topbar = box('topbar', body);
  // The Menu button exists only below 900px; from 900px the sidebar is a page column.
  const menu = box('menu', topbar, !wide);
  const bell = box('bell', topbar);
  const side = box('side', body, wide || sideOpen);
  const chip = box('chip', side);
  // `close` fires after the dialog lost `open`: nothing in it is rendered any more.
  const dialog = box('dialog', body, false);
  const closeButton = box('close', dialog);
  return { body, menu, bell, chip, dialog, closeButton };
}

const contains = (container: Box, element: Box): boolean => {
  for (let at: Box | null = element; at; at = at.parent) if (at === container) return true;
  return false;
};

const shown = (element: Box): boolean => {
  for (let at: Box | null = element; at; at = at.parent) if (!at.rendered) return false;
  return true;
};

function target(
  page: ReturnType<typeof shell>,
  active: Box | null,
  opener: Box | null,
): string | null {
  return (
    focusReturnTarget({
      active,
      body: page.body,
      dialog: page.dialog,
      opener,
      fallback: page.menu,
      contains,
      shown,
    })?.name ?? null
  );
}

describe('a wide screen: the dialog gives focus back itself', () => {
  it('leaves focus on the account chip it returned to', () => {
    const page = shell({ wide: true });
    expect(target(page, page.chip, page.chip)).toBeNull();
  });

  it('leaves focus on the bell it returned to', () => {
    const page = shell({ wide: true });
    expect(target(page, page.bell, page.bell)).toBeNull();
  });

  it('puts focus back on the trigger when the browser left it on <body>', () => {
    // Safari does not focus a link on click, so the dialog has nothing to give back to.
    const page = shell({ wide: true });
    expect(target(page, page.body, page.chip)).toBe('chip');
  });

  it('leaves focus alone when nothing on screen can take it', () => {
    // Opened without a click, and the Menu button is not rendered from 900px: no target is
    // better than a hidden one.
    const page = shell({ wide: true });
    expect(target(page, page.body, null)).toBeNull();
  });
});

describe('a phone: the chip sits in the sidebar popover, which showModal() closed', () => {
  it('moves focus off the closed dialog to the Menu button (the CI failure)', () => {
    // When `close` fires, focus is still on the closed dialog's Close button; Chromium drops
    // it to <body> a task later. Waiting to see <body> (the first fix) never acted.
    const page = shell({ wide: false });
    expect(target(page, page.closeButton, page.chip)).toBe('menu');
  });

  it('moves focus from <body> to the Menu button', () => {
    const page = shell({ wide: false });
    expect(target(page, page.body, page.chip)).toBe('menu');
  });

  it('moves focus to the Menu button when nothing is focused', () => {
    const page = shell({ wide: false });
    expect(target(page, null, page.chip)).toBe('menu');
  });

  it('moves focus off the hidden chip itself to the Menu button', () => {
    const page = shell({ wide: false });
    expect(target(page, page.chip, page.chip)).toBe('menu');
  });

  it('gives focus to the Menu button when the drawer was opened without a click', () => {
    const page = shell({ wide: false });
    expect(target(page, page.closeButton, null)).toBe('menu');
  });

  it('gives focus back to the chip while the sidebar is still open', () => {
    const page = shell({ wide: false, sideOpen: true });
    expect(target(page, page.closeButton, page.chip)).toBe('chip');
  });

  it('leaves focus where it is when it already sits on a control on screen', () => {
    const page = shell({ wide: false });
    expect(target(page, page.bell, page.chip)).toBeNull();
  });
});

describe('isRendered', () => {
  const element = (isConnected: boolean, rects: number) =>
    ({ isConnected, getClientRects: () => ({ length: rects }) }) as unknown as Element;

  it('is true for a connected element with a box', () => {
    expect(isRendered(element(true, 1))).toBe(true);
  });

  it('is false under display: none (no box), as inside a closed popover or dialog', () => {
    expect(isRendered(element(true, 0))).toBe(false);
  });

  it('is false for an element no longer in the document', () => {
    expect(isRendered(element(false, 1))).toBe(false);
  });
});
